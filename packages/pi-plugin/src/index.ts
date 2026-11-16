/**
 * pi-wake — wake yourself up at a chosen time.
 *
 * The assistant schedules a wake-up and then ends its turn. When the time comes,
 * pi starts a new turn with a reminder message, so the work continues without
 * anyone typing anything.
 *
 * Usage:
 *
 *   wake_up({ action: "schedule", after: "90m", prompt: "继续跑 typecheck" })
 *   wake_up({ action: "schedule", every: "5m", prompt: "查一下 PR 状态" })
 *   wake_up({ action: "schedule", at: "2026-11-12T09:30:00+08:00" })
 *   wake_up({ action: "schedule", wait: "gh watch pr 42 --exit", prompt: "看 PR 变化" })
 *   wake_up({ action: "list" })
 *   wake_up({ action: "cancel", id: "w1" })
 *   wake_up({ action: "cancel", all: true })
 *
 * Both one-shot time forms end up as a delay measured from now, so `at` is only
 * a different way of saying "after"; everything below works on `dueAt`.
 *
 * `wait` drops the clock entirely: the command starts now and the wake-up fires
 * when it exits 0. It is for long-running watchers, so there is no interval and
 * no deadline; the process is killed when the wake-up is cancelled or the
 * session ends.
 *
 * `every` makes the wake-up repeat: it fires, then re-arms itself at a fixed
 * cadence until it is cancelled. A repeating wake-up skips the slots it missed
 * while pi was not running instead of firing them back to back.
 *
 * Wakes only fire while pi is running: the timer lives in this process. A wake
 * that is still pending is restored from the session file when the session is
 * reopened, and an overdue one fires immediately with a note saying how late it
 * is.
 *
 * The package also ships a usage skill (../skills/pi-wake) registered through
 * resources_discover, so the convention travels with the extension instead of
 * having to be written into AGENTS.md.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

/** Session entry type holding the wake-up state (not sent to the model). */
const ENTRY_TYPE = "wake_up";
/** Message type of the reminder that starts the waking turn. */
const MESSAGE_TYPE = "wake_up";

/** Usage skill shipped with the package; registered whenever the extension loads. */
const SKILL_DIRS = [fileURLToPath(new URL("../skills/pi-wake", import.meta.url))];

/**
 * `setTimeout` overflows above this and fires immediately, so a longer wait is
 * split into chunks that re-arm themselves.
 */
const MAX_TIMEOUT_MS = 2_147_483_647;

/** How long a `when` condition may run before it counts as unsatisfied. */
const DEFAULT_CONDITION_TIMEOUT_MS = 30_000;
const MAX_CONDITION_TIMEOUT_MS = 300_000;
/** Output kept from a condition: enough to quote as evidence, small enough for a message. */
const MAX_CONDITION_BYTES = 64 * 1024;
/** How much of that output travels into the reminder. */
const MAX_EVIDENCE_CHARS = 4_000;

const wakeUpSchema = Type.Object(
	{
		action: Type.Union([Type.Literal("schedule"), Type.Literal("list"), Type.Literal("cancel")], {
			description: "schedule a wake-up, list pending ones, or cancel one",
		}),
		at: Type.Optional(
			Type.String({
				description:
					"When to wake, as an absolute time: ISO 8601 such as 2026-11-12T09:30:00+08:00. Without an offset the local time zone is used. Mutually exclusive with `after`.",
			}),
		),
		after: Type.Optional(
			Type.String({
				description:
					"How long to wait, such as 90m, 2h, 1h30m, 45s. Mutually exclusive with `at`. With `every`, this is only the first delay.",
			}),
		),
		when: Type.Optional(
			Type.String({
				description:
					"Gate the wake-up on a command: it runs when the time comes, and the wake-up only starts a turn if it exits 0. Use it to stay silent when there is nothing to report.",
			}),
		),
		whenLang: Type.Optional(
			Type.Union([Type.Literal("sh"), Type.Literal("node")], {
				description: "How to run `when`: a POSIX shell script through /bin/sh (default) or a node program. The exit status decides the gate.",
			}),
		),
		whenChanged: Type.Optional(
			Type.Boolean({
				description:
					"With `when`: also require that its stdout differ from the run that last fired this wake-up, so an unchanged world stays silent. The command can read the previous output from $PI_WAKE_LAST_STDOUT.",
			}),
		),
		whenTimeout: Type.Optional(
			Type.Number({ description: "Seconds `when` may run before it counts as unsatisfied. Default 30, maximum 300." }),
		),
		wait: Type.Optional(
			Type.String({
				description:
					"Wait for a command to exit instead of scheduling a time: it starts now, and the wake-up fires when it exits 0. No interval and no deadline, so it suits long-running watchers such as `gh watch pr 42 --exit`. Mutually exclusive with `at`, `after`, `every` and `when`.",
			}),
		),
		waitLang: Type.Optional(
			Type.Union([Type.Literal("sh"), Type.Literal("node")], {
				description: "How to run `wait`: a POSIX shell script through /bin/sh (default) or a node program.",
			}),
		),
		every: Type.Optional(
			Type.String({
				description:
					"Repeat instead of firing once: the interval between wake-ups, such as 5m or 1h. Without `after` the first one fires one interval from now. Cancelling stops it. Mutually exclusive with `at`.",
			}),
		),
		prompt: Type.Optional(
			Type.String({
				description:
					"What to tell your future self when the wake-up fires. Write the next action, not a restatement of the task.",
			}),
		),
		id: Type.Optional(Type.String({ description: "Cancel this id instead of all wake-ups." })),
		all: Type.Optional(Type.Boolean({ description: "With action cancel: drop every pending wake-up." })),
	},
	{ additionalProperties: false },
);

type WakeUpParams = Static<typeof wakeUpSchema>;

/** The single `details` shape every call returns; pi keeps one type per tool. */
type WakeUpDetails = {
	/** Pending wake-ups left after the call. */
	count: number;
	/** How many wake-ups this call cancelled. */
	cancelled: number;
	/** Whether this call created a wake-up. */
	scheduled: boolean;
	id?: string;
	dueAt?: number;
	delayMs?: number;
	/** Set when the wake-up repeats. */
	intervalMs?: number;
	/** Whether this wake-up only fires when its condition holds. */
	gated?: boolean;
};

type Wake = {
	id: string;
	/** When the wake-up is due, as epoch milliseconds. */
	dueAt: number;
	/** Instruction left for the waking turn. */
	prompt: string;
	/** When the schedule was created, so the reminder can say how long it slept. */
	armedAt: number;
	/** Repeat interval; absent for a one-shot wake-up. */
	intervalMs?: number;
	/** Condition that must exit 0 before the wake-up fires. */
	when?: string;
	whenLang?: "sh" | "node";
	whenChanged?: boolean;
	whenTimeoutMs?: number;
	/** Command that blocks until the wake-up should fire; absent for timed wake-ups. */
	wait?: string;
	waitLang?: "sh" | "node";
	/** The running `wait` process, killed when the wake-up is cancelled or the session ends. */
	child?: ChildProcess;
	/** stdout of the run that last fired this wake-up, for `whenChanged`. */
	lastStdout?: string;
	/** Set once a broken condition has been reported, so it is reported once. */
	reportedBroken?: boolean;
	/** Pending timer, cleared when the wake-up fires or is cancelled. */
	timer?: ReturnType<typeof setTimeout>;
};

type WakeEntry = {
	id: string;
	dueAt: number;
	prompt?: string;
	armedAt?: number;
	intervalMs?: number;
	when?: string;
	whenLang?: "sh" | "node";
	whenChanged?: boolean;
	whenTimeoutMs?: number;
	wait?: string;
	waitLang?: "sh" | "node";
	lastStdout?: string;
	skippedAt?: number;
	firedAt?: number;
	cancelledAt?: number;
};

export default function (pi: ExtensionAPI) {
	/** Pending wake-ups for this session, keyed by id. */
	const wakes = new Map<string, Wake>();
	/** Set on session_start; used for notifications and idle checks when firing. */
	let sessionCtx: ExtensionContext | undefined;
	/** Monotonic suffix for new ids, restored from the session so ids stay unique. */
	let counter = 0;

	/* ------------------------------------------------------------------ timing */

	/** Convert `at` into epoch milliseconds, or explain why it is unusable. */
	function parseAt(text: string): { dueAt: number } | { error: string } {
		const trimmed = text.trim();
		// A bare date would be read as UTC midnight by Date.parse, which is not
		// what "today" means to a caller; a space instead of T is what people and
		// models both write.
		const normalized = /^\d{4}-\d{2}-\d{2}$/.test(trimmed)
			? `${trimmed}T00:00:00`
			: trimmed.replace(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})/, "$1T$2");
		const dueAt = Date.parse(normalized);
		if (Number.isNaN(dueAt)) {
			return {
				error: `cannot read "${text}" as a time. Use ISO 8601 such as 2026-11-12T09:30:00+08:00 (no offset means local time).`,
			};
		}
		return { dueAt };
	}

	/** Convert `after` ("90m", "1h30m", "45s") into milliseconds. */
	function parseAfter(text: string): { ms: number } | { error: string } {
		const pattern = /(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)/gi;
		const unit: Record<string, number> = {
			ms: 1,
			s: 1_000,
			m: 60_000,
			h: 3_600_000,
			d: 86_400_000,
		};
		let total = 0;
		let consumed = 0;
		for (const match of text.matchAll(pattern)) {
			total += Number(match[1]) * unit[match[2].toLowerCase()];
			consumed += match[0].length;
		}
		const rest = text.replace(pattern, "").replace(/[\s,]/g, "");
		if (total <= 0 || rest !== "" || consumed === 0) {
			return {
				error: `cannot read "${text}" as a duration. Use a unit-bearing value such as 90m, 2h, 1h30m or 45s.`,
			};
		}
		return { ms: total };
	}

	/** How pi shows a moment to a human: local time plus the zone it belongs to. */
	function formatLocal(epochMs: number): string {
		const date = new Date(epochMs);
		const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
		const stamp = date.toLocaleString(undefined, {
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
			hour12: false,
		});
		return `${stamp} (${zone})`;
	}

	/** "1h29m" style rendering of a span, for results and reminders. */
	function formatSpan(ms: number): string {
		const totalSeconds = Math.max(0, Math.round(ms / 1000));
		const days = Math.floor(totalSeconds / 86_400);
		const hours = Math.floor((totalSeconds % 86_400) / 3_600);
		const minutes = Math.floor((totalSeconds % 3_600) / 60);
		const seconds = totalSeconds % 60;
		const parts = [
			days > 0 ? `${days}d` : "",
			hours > 0 ? `${hours}h` : "",
			minutes > 0 ? `${minutes}m` : "",
			seconds > 0 || (days === 0 && hours === 0 && minutes === 0) ? `${seconds}s` : "",
		];
		return parts.filter(Boolean).join("");
	}

	/* ---------------------------------------------------------------- scheduling */

	/**
	 * Arm the timer for one wake-up.
	 *
	 * A span beyond the `setTimeout` limit is waited out in chunks; each chunk
	 * re-arms, so a wake-up three weeks away still fires on time.
	 */
	function arm(wake: Wake) {
		if (wake.timer) clearTimeout(wake.timer);
		const remaining = wake.dueAt - Date.now();
		if (remaining > MAX_TIMEOUT_MS) {
			wake.timer = setTimeout(() => arm(wake), MAX_TIMEOUT_MS);
		} else {
			wake.timer = setTimeout(() => void fire(wake.id), Math.max(0, remaining));
		}
		// Never hold the process open: in a one-shot run pi should still exit when
		// the turn is done instead of waiting for a wake-up that cannot be used.
		wake.timer.unref?.();
	}

	/** Persist a state change so a reopened session can rebuild the schedule. */
	function record(entry: WakeEntry) {
		pi.appendEntry<WakeEntry>(ENTRY_TYPE, entry);
	}

	/** Everything about a wake-up that the session file has to keep. */
	function baseEntry(wake: Wake): WakeEntry {
		return {
			id: wake.id,
			dueAt: wake.dueAt,
			prompt: wake.prompt,
			armedAt: wake.armedAt,
			...(wake.intervalMs ? { intervalMs: wake.intervalMs } : {}),
			...(wake.when ? { when: wake.when } : {}),
			...(wake.whenLang ? { whenLang: wake.whenLang } : {}),
			...(wake.whenChanged ? { whenChanged: true } : {}),
			...(wake.whenTimeoutMs ? { whenTimeoutMs: wake.whenTimeoutMs } : {}),
			...(wake.wait ? { wait: wake.wait } : {}),
			...(wake.waitLang === "node" ? { waitLang: "node" as const } : {}),
			...(wake.lastStdout !== undefined ? { lastStdout: wake.lastStdout } : {}),
		};
	}

	type ConditionOutcome = { ok: boolean; stdout: string; stderr: string; broken?: string };

	/**
	 * Run the `when` gate.
	 *
	 * Exit status is the gate. A condition that cannot run at all (missing
	 * interpreter, timeout, spawn failure) also counts as unsatisfied but is
	 * reported, because otherwise the wake-up would be silent forever.
	 */
	function evaluateCondition(wake: Wake): Promise<ConditionOutcome> {
		const env = {
			...process.env,
			PI_WAKE_ID: wake.id,
			PI_WAKE_LAST_STDOUT: wake.lastStdout ?? "",
		};
		const [file, args] =
			wake.whenLang === "node"
				? [process.execPath, ["-e", wake.when ?? ""]]
				: ["/bin/sh", ["-c", wake.when ?? ""]];
		const timeout = Math.min(wake.whenTimeoutMs ?? DEFAULT_CONDITION_TIMEOUT_MS, MAX_CONDITION_TIMEOUT_MS);
		return new Promise((resolve) => {
			const stdout: Buffer[] = [];
			const stderr: Buffer[] = [];
			let settled = false;
			const finish = (outcome: ConditionOutcome) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolve(outcome);
			};
			const text = (chunks: Buffer[]) => Buffer.concat(chunks).toString("utf8").slice(0, MAX_CONDITION_BYTES);
			let child: ReturnType<typeof spawn>;
			try {
				child = spawn(file, args, { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] });
			} catch (error) {
				resolve({ ok: false, stdout: "", stderr: "", broken: error instanceof Error ? error.message : String(error) });
				return;
			}
			const timer = setTimeout(() => {
				child.kill("SIGKILL");
				finish({ ok: false, stdout: text(stdout), stderr: text(stderr), broken: `超过 ${Math.round(timeout / 1000)}s 没有返回` });
			}, timeout);
			timer.unref?.();
			child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
			child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
			child.once("error", (error) => finish({ ok: false, stdout: text(stdout), stderr: text(stderr), broken: error.message }));
			child.once("close", (code, signal) => {
				const broken = code === 0 ? undefined : signal ? `被信号 ${signal} 终止` : undefined;
				finish({ ok: code === 0, stdout: text(stdout), stderr: text(stderr), ...(broken ? { broken } : {}) });
			});
		});
	}

	/**
	 * Move a wake-up past a slot without starting a turn.
	 *
	 * A repeating wake-up stays silent and re-arms; a one-shot one has nothing
	 * left to wait for, so it is dropped and the user is told rather than being
	 * left with a reminder that will never arrive.
	 */
	function skip(wake: Wake, reason: string) {
		const now = Date.now();
		if (wake.intervalMs) {
			const next = Math.max(wake.dueAt + wake.intervalMs, now + wake.intervalMs);
			wake.dueAt = next;
			arm(wake);
			record({ ...baseEntry(wake), dueAt: next, skippedAt: now });
			return;
		}
		wakes.delete(wake.id);
		record({ ...baseEntry(wake), skippedAt: now });
		sessionCtx?.ui?.notify(`pi-wake: ${wake.id} 的条件不满足（${reason}），一次性唤醒已丢弃。`, "info");
	}

	/**
	 * Start a `wait` wake-up: the command runs now and the wake-up fires when it
	 * exits 0.
	 *
	 * There is no interval and no deadline; the process is the clock. Whatever it
	 * prints becomes the evidence in the reminder, so the waking turn knows what
	 * happened without asking again. A non-zero exit is reported once and drops
	 * the wake-up: a watcher that failed will not fix itself by being ignored.
	 */
	function startWait(wake: Wake) {
		const [file, args] =
			wake.waitLang === "node"
				? [process.execPath, ["-e", wake.wait ?? ""]]
				: ["/bin/sh", ["-c", wake.wait ?? ""]];
		// A watcher can run for hours and print all the while, so the useful part is
		// the tail: the last thing it said before exiting. Each stream has its own
		// budget, otherwise a chatty stderr would starve the stdout we quote.
		const out: Buffer[] = [];
		const err: Buffer[] = [];
		const collect = (chunks: Buffer[], chunk: Buffer) => {
			chunks.push(chunk);
			let total = 0;
			for (let index = chunks.length - 1; index >= 0; index -= 1) {
				total += chunks[index].length;
				if (total > MAX_CONDITION_BYTES) {
					chunks.splice(0, index + 1);
					return;
				}
			}
		};
		const text = (chunks: Buffer[]) => Buffer.concat(chunks).toString("utf8");
		let child: ChildProcess;
		try {
			child = spawn(file, args, {
				cwd: process.cwd(),
				env: { ...process.env, PI_WAKE_ID: wake.id, PI_WAKE_LAST_STDOUT: wake.lastStdout ?? "" },
				stdio: ["ignore", "pipe", "pipe"],
				// A watcher starts children of its own — `gh watch` execs a gh-watch
				// binary — and signalling just the shell leaves them polling forever.
				// Its own process group makes the whole tree killable at once.
				detached: process.platform !== "win32",
			});
		} catch (error) {
			dropWait(wake, error instanceof Error ? error.message : String(error));
			return;
		}
		wake.child = child;
		child.stdout?.on("data", (chunk: Buffer) => collect(out, chunk));
		child.stderr?.on("data", (chunk: Buffer) => collect(err, chunk));
		let settled = false;
		const finish = (summary: { code: number | null; signal: NodeJS.Signals | null } | { error: string }) => {
			if (settled) return;
			settled = true;
			wake.child = undefined;
			// A cancel or a restart already took this wake-up away; say nothing.
			if (wakes.get(wake.id) !== wake) return;
			if ("error" in summary) {
				dropWait(wake, summary.error, text(err));
				return;
			}
			if (summary.code === 0) {
				void fire(wake.id, text(out));
				return;
			}
			const why = summary.signal
				? `被信号 ${summary.signal} 终止`
				: `退出码 ${summary.code === null ? "未知" : summary.code}`;
			dropWait(wake, why, text(err));
		};
		child.once("error", (error) => finish({ error: error.message }));
		child.once("close", (code, signal) => finish({ code, signal }));
	}

	/**
	 * Kill a `wait` command and the processes it started.
	 *
	 * Signalling the group rather than the process matters because the interesting
	 * watchers are wrappers: `gh watch` runs a separate gh-watch binary, so a
	 * SIGTERM to the shell alone leaves the watcher reparented to init, still
	 * polling. SIGTERM first, SIGKILL for anything that ignores it.
	 */
	function killWaitChild(wake: Wake) {
		const child = wake.child;
		const pid = child?.pid;
		if (!child || !pid) return;
		const signal = (name: NodeJS.Signals) => {
			try {
				if (process.platform === "win32") child.kill(name);
				else process.kill(-pid, name);
			} catch {
				// The process is already gone; nothing to escalate to.
			}
		};
		signal("SIGTERM");
		const escalate = setTimeout(() => signal("SIGKILL"), 2_000);
		escalate.unref?.();
	}

	/** Drop a `wait` wake-up that ended without waking, telling the user why once. */
	function dropWait(wake: Wake, why: string, stderr = "") {
		wakes.delete(wake.id);
		record({ ...baseEntry(wake), skippedAt: Date.now() });
		const noise = stderr.trim().slice(-200);
		sessionCtx?.ui?.notify(`pi-wake: ${wake.id} 的 wait 结束但没有唤醒（${why}${noise ? `：${noise}` : ""}）。`, "warning");
	}

	/** Start the waking turn; a repeating wake-up re-arms itself for its next slot. */
	async function fire(id: string, waitOutput?: string) {
		const wake = wakes.get(id);
		if (!wake) return;

		let evidence = "";
		if (wake.wait) {
			// The command has already run to completion; the end of its output is the
			// part that says why it exited, so that is what the reminder quotes.
			evidence = (waitOutput ?? "").trim().slice(-MAX_EVIDENCE_CHARS);
			wake.lastStdout = waitOutput ?? "";
		} else if (wake.when) {
			const outcome = await evaluateCondition(wake);
			// The wake-up may have been cancelled while the condition ran.
			if (wakes.get(id) !== wake) return;
			if (outcome.broken && !wake.reportedBroken) {
				wake.reportedBroken = true;
				sessionCtx?.ui?.notify(`pi-wake: ${wake.id} 的 when 条件无法正常执行：${outcome.broken}`, "warning");
			}
			const changed = !wake.whenChanged || outcome.stdout !== (wake.lastStdout ?? "");
			if (!outcome.ok || !changed) {
				let reason = "输出没有变化";
				if (!outcome.ok) {
					const noise = outcome.stderr.trim().slice(0, 200);
					reason = noise ? `退出码非 0：${noise}` : "退出码非 0";
				}
				skip(wake, reason);
				return;
			}
			wake.lastStdout = outcome.stdout;
			evidence = outcome.stdout.trim().slice(0, MAX_EVIDENCE_CHARS);
		}

		// Keep the slot that fired: re-arming moves `dueAt` to the next one.
		const firedSlot = wake.dueAt;
		const firedAt = Date.now();
		if (wake.intervalMs) {
			// Fixed cadence, but never catch up: slots missed while pi was not
			// running are skipped rather than fired back to back.
			const next = Math.max(wake.dueAt + wake.intervalMs, firedAt + wake.intervalMs);
			wake.dueAt = next;
			arm(wake);
			record({ ...baseEntry(wake), dueAt: next });
		} else {
			wakes.delete(id);
			record({ ...baseEntry(wake), firedAt });
		}

		const late = firedAt - firedSlot;
		const lines = wake.wait
			? [
					`⏰ 等待的命令已结束 · ${formatLocal(firedAt)}`,
					"",
					"这是条件唤醒，不是用户发言。你之前排的那个等待命令退出了，且退出码为 0。",
				]
			: [
					`⏰ 自动唤醒 · ${formatLocal(firedSlot)}`,
					"",
					"这是定时唤醒，不是用户发言。时间到了，继续之前的工作。",
				];
		if (!wake.wait && late > 5_000) {
			lines.push(`（比预定时间晚了 ${formatSpan(late)}——期间 pi 没有在运行。）`);
		}
		lines.push(
			wake.prompt.trim()
				? `你当时给自己的指令：${wake.prompt.trim()}`
				: "你当时没有写下具体指令，按当前上下文继续。",
		);
		if (evidence) {
			lines.push("", "唤醒时条件的输出：", "```", evidence, "```");
		}
		if (wake.intervalMs) {
			lines.push(`（这是每 ${formatSpan(wake.intervalMs)} 重复的提醒，下次 ${formatLocal(wake.dueAt)}。不需要了就 cancel。）`);
		}

		// `followUp` keeps a running turn intact; when idle it is ignored and
		// `triggerTurn` starts a fresh one. One call covers both cases.
		pi.sendMessage(
			{ customType: MESSAGE_TYPE, content: lines.join("\n"), display: true },
			{ triggerTurn: true, deliverAs: "followUp" },
		);
		sessionCtx?.ui?.notify(`pi-wake: 唤醒 ${wake.id} @ ${formatLocal(firedSlot)}`, "info");
	}

	/** Human-readable summary of one pending wake-up. */
	function describe(wake: Wake): string {
		const prompt = wake.prompt.trim() ? ` — "${wake.prompt.trim()}"` : "";
		if (wake.wait) {
			return `${wake.id}: 等待命令退出（已等 ${formatSpan(Date.now() - wake.armedAt)}）${prompt}`;
		}
		const remaining = wake.dueAt - Date.now();
		const cadence = wake.intervalMs ? `，每 ${formatSpan(wake.intervalMs)} 重复` : "";
		const gate = wake.when ? "，条件满足才唤醒" : "";
		return `${wake.id}: ${formatLocal(wake.dueAt)}（还有 ${formatSpan(remaining)}${cadence}${gate}）${prompt}`;
	}

	function pending(): Wake[] {
		return [...wakes.values()].sort((a, b) => a.dueAt - b.dueAt);
	}

	/** Build a result with the shared details shape. */
	function reply(text: string, details: Partial<WakeUpDetails>, isError = false) {
		const full: WakeUpDetails = { count: pending().length, cancelled: 0, scheduled: false, ...details };
		const content = [{ type: "text" as const, text }];
		return isError ? { content, details: full, isError: true as const } : { content, details: full };
	}

	/* ------------------------------------------------------------------ skill */

	pi.on("resources_discover", async () => ({ skillPaths: SKILL_DIRS }));

	/* ------------------------------------------------------------------- restore */

	const latest = new Map<string, WakeEntry>();
	pi.on("session_start", async (_event, ctx) => {
		sessionCtx = ctx;
		wakes.clear();
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
			const data = entry.data as WakeEntry | undefined;
			if (!data?.id) continue;
			// Entries are append-only and ordered, so the last one per id wins:
			// a cancelled or already-fired wake-up must not come back.
			latest.set(data.id, data);
		}
		for (const data of latest.values()) {
			const suffix = Number(/^w(\d+)$/.exec(data.id)?.[1] ?? 0);
			if (suffix > counter) counter = suffix;
			if (data.firedAt || data.cancelledAt) continue;
			const dueAt = Number(data.dueAt);
			if (!Number.isFinite(dueAt)) continue;
			const wake: Wake = {
				id: data.id,
				dueAt,
				prompt: data.prompt ?? "",
				armedAt: Number(data.armedAt) || dueAt,
				...(Number(data.intervalMs) > 0 ? { intervalMs: Number(data.intervalMs) } : {}),
				...(data.when ? { when: data.when } : {}),
				...(typeof data.wait === "string" && data.wait ? { wait: data.wait } : {}),
				...(data.waitLang === "node" ? { waitLang: "node" as const } : {}),
				...(data.whenLang === "node" ? { whenLang: "node" as const } : {}),
				...(data.whenChanged ? { whenChanged: true } : {}),
				...(Number(data.whenTimeoutMs) > 0 ? { whenTimeoutMs: Number(data.whenTimeoutMs) } : {}),
				...(typeof data.lastStdout === "string" ? { lastStdout: data.lastStdout } : {}),
			};
			wakes.set(wake.id, wake);
			if (wake.wait) startWait(wake);
			else arm(wake);
		}
	});

	pi.on("session_shutdown", async () => {
		for (const wake of wakes.values()) {
			if (wake.timer) clearTimeout(wake.timer);
			killWaitChild(wake);
		}
		wakes.clear();
		sessionCtx = undefined;
	});

	/* ---------------------------------------------------------------------- tool */

	// Global installs load this extension in background subagents too (separate
	// processes with PI_SUBAGENT_CHILD=1). A subagent must not schedule wakes:
	// the wake would start a turn in a child that is already ending.
	if (process.env.PI_SUBAGENT_CHILD === "1") return;

	pi.registerTool({
		name: "wake_up",
		label: "Wake Up",
		description:
			"Schedule a wake-up: this turn ends, and at the chosen time pi starts a new turn with a reminder so the work continues by itself. Also lists and cancels pending wake-ups. Wake-ups only fire while pi is running.",
		promptSnippet: "Schedule, list or cancel a self wake-up at a chosen time.",
		promptGuidelines: [
			"Use wake_up when the user asks to be reminded later, to check on something later, or to continue at a set time.",
			"Translate what the user said into either an absolute `at` (ISO 8601, e.g. 2026-11-12T09:30:00+08:00) or a relative `after` (e.g. 90m, 2h). Do not compute clock arithmetic yourself: pick whichever form the user's words match.",
			"For a recurring check (\"remind me every 5 minutes\"), pass `every` with the interval instead of re-scheduling by hand.",
			"Put the next concrete action in `prompt`, so the waking turn knows what to do without re-reading the whole conversation.",
			"Tell the user the wake-up time you scheduled; do not claim that work will happen while pi is closed.",
		],
		parameters: wakeUpSchema,

		async execute(_toolCallId, params: WakeUpParams) {
			const action = params.action;

			if (action === "list") {
				const list = pending();
				const text = list.length
					? list.map((wake) => `- ${describe(wake)}`).join("\n")
					: "没有待唤醒的定时器。";
				return reply(text, { count: list.length });
			}

			if (action === "cancel") {
				if (params.all) {
					const list = pending();
					for (const wake of list) {
						if (wake.timer) clearTimeout(wake.timer);
						killWaitChild(wake);
						wakes.delete(wake.id);
						record({ id: wake.id, dueAt: wake.dueAt, cancelledAt: Date.now() });
					}
					return reply(`已取消 ${list.length} 个定时器。`, { cancelled: list.length });
				}
				const id = params.id?.trim();
				if (!id) {
					return reply("取消需要给 id，或传 all: true 取消全部。", {}, true);
				}
				const wake = wakes.get(id);
				if (!wake) {
					const known = pending().map((item) => item.id);
					return reply(
						`没有 id 为 "${id}" 的定时器。${known.length ? `待唤醒：${known.join(", ")}` : "当前没有待唤醒的定时器。"}`,
						{},
						true,
					);
				}
				if (wake.timer) clearTimeout(wake.timer);
				killWaitChild(wake);
				wakes.delete(id);
				record({ id, dueAt: wake.dueAt, cancelledAt: Date.now() });
				return reply(`已取消 ${id}（原定 ${formatLocal(wake.dueAt)}）。`, { cancelled: 1 });
			}

			// action === "schedule"
			const wait = params.wait?.trim();
			const hasAt = Boolean(params.at?.trim());
			const hasAfter = Boolean(params.after?.trim());
			const hasEvery = Boolean(params.every?.trim());
			if (wait && (hasAt || hasAfter || hasEvery)) {
				return reply("`wait` 自己决定什么时候唤醒：它没有时间间隔，所以不能再给 `at`、`after` 或 `every`。", {}, true);
			}
			if (params.waitLang && !wait) {
				return reply("`waitLang` 只跟 `wait` 一起用。", {}, true);
			}
			if (!wait && hasAt === hasAfter && !hasEvery) {
				return reply(
					"给 `at`（绝对时间，ISO 8601）、`after`（相对时长，如 90m）或 `every`（重复间隔，如 5m）之一，不要 `at` 和 `after` 都给或都不给。",
					{},
					true,
				);
			}
			if (hasAt && hasEvery) {
				return reply(
					"`every` 是重复提醒，不能用 `at` 定首次时间：用 `after` 定首次延迟，或直接给 `every` 让它从一整个间隔之后开始。",
					{},
					true,
				);
			}

			const when = params.when?.trim();
			if (wait && when) {
				return reply("`wait` 本身就是条件（命令退出即唤醒），不能再叠 `when`：把要判断的东西写进 `wait` 脚本，用退出码表达。", {}, true);
			}
			if (!when && (params.whenLang || params.whenChanged !== undefined || params.whenTimeout !== undefined)) {
				return reply("`whenLang`、`whenChanged`、`whenTimeout` 只跟 `when` 一起用，没有 `when` 时它们没有意义。", {}, true);
			}

			let firstDelayMs: number | undefined;
			let intervalMs: number | undefined;
			if (hasAfter) {
				const parsed = parseAfter(params.after!);
				if ("error" in parsed) return reply(parsed.error, {}, true);
				firstDelayMs = parsed.ms;
			}
			if (hasEvery) {
				const parsed = parseAfter(params.every!);
				if ("error" in parsed) return reply(parsed.error, {}, true);
				if (parsed.ms < 1_000) {
					return reply("`every` 至少 1s，否则会不停地唤醒自己。", {}, true);
				}
				intervalMs = parsed.ms;
			}

			const now = Date.now();
			let dueAt: number;
			if (wait) {
				dueAt = now;
			} else if (hasAt) {
				const parsed = parseAt(params.at!);
				if ("error" in parsed) return reply(parsed.error, {}, true);
				dueAt = parsed.dueAt;
			} else {
				dueAt = now + (firstDelayMs ?? intervalMs ?? 0);
			}

			if (!wait && dueAt <= now) {
				return reply(
					`那个时间已经过去了（现在是 ${formatLocal(now)}）。要立刻继续就正常做事；要稍后，请给一个将来的时间或 after。`,
					{},
					true,
				);
			}

			const id = `w${++counter}`;
			const gate = when
				? {
						when,
						...(params.whenLang === "node" ? { whenLang: "node" as const } : {}),
						...(params.whenChanged ? { whenChanged: true } : {}),
						...(params.whenTimeout ? { whenTimeoutMs: Math.min(Math.max(params.whenTimeout, 1), 300) * 1_000 } : {}),
					}
				: {};
			const waiting = wait
				? { wait, ...(params.waitLang === "node" ? { waitLang: "node" as const } : {}) }
				: {};
			const wake: Wake = { id, dueAt, prompt: params.prompt ?? "", armedAt: now, ...(intervalMs ? { intervalMs } : {}), ...gate, ...waiting };
			wakes.set(id, wake);
			if (wake.wait) startWait(wake);
			else arm(wake);
			record(baseEntry(wake));

			const others = pending().filter((item) => item.id !== id);
			const othersLine = others.length ? `另有 ${others.length} 个待唤醒：${others.map((item) => item.id).join(", ")}。` : "";
			const text = wake.wait
				? [
						`已开始等待 ${id}：命令退出码 0 就唤醒你。没有时间间隔，也没有超时；cancel 会杀掉它，会话结束也会杀掉它。`,
						othersLine,
						"本轮可以结束了；命令退出后我会带着它的输出重新开始一轮。",
					]
						.filter(Boolean)
						.join("\n")
				: [
						`已安排 ${id}：${formatLocal(dueAt)}，还有 ${formatSpan(dueAt - now)}${intervalMs ? `，之后每 ${formatSpan(intervalMs)} 重复` : ""}${when ? `，每次先跑 when 条件，退出码 0${params.whenChanged ? "且输出有变化" : ""}才唤醒` : ""}。`,
						othersLine,
						"本轮可以结束了；到点后我会带着提醒重新开始一轮。",
					]
						.filter(Boolean)
						.join("\n");
			return reply(text, {
				scheduled: true,
				id,
				dueAt,
				...(wake.wait ? { gated: true } : { delayMs: dueAt - now }),
				...(intervalMs ? { intervalMs } : {}),
				...(!wake.wait && when ? { gated: true } : {}),
			});
		},
	});

	/* ------------------------------------------------------------------- command */

	pi.registerCommand("wake", {
		description: "List pending wake-ups (see the wake_up tool)",
		handler: async (_args, ctx) => {
			const list = pending();
			const lines = list.length
				? ["pi-wake:"].concat(list.map((wake) => `- ${describe(wake)}`))
				: ["pi-wake: 没有待唤醒的定时器。"];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
