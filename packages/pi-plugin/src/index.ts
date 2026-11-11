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
 *   wake_up({ action: "schedule", at: "2026-11-12T09:30:00+08:00" })
 *   wake_up({ action: "list" })
 *   wake_up({ action: "cancel", id: "w1" })
 *   wake_up({ action: "cancel", all: true })
 *
 * Both time forms end up as a delay measured from now, so `at` is only a
 * different way of saying "after"; everything below works on `dueAt`.
 *
 * Wakes only fire while pi is running: the timer lives in this process. A wake
 * that is still pending is restored from the session file when the session is
 * reopened, and an overdue one fires immediately with a note saying how late it
 * is.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

/** Session entry type holding the wake-up state (not sent to the model). */
const ENTRY_TYPE = "wake_up";
/** Message type of the reminder that starts the waking turn. */
const MESSAGE_TYPE = "wake_up";

/**
 * `setTimeout` overflows above this and fires immediately, so a longer wait is
 * split into chunks that re-arm themselves.
 */
const MAX_TIMEOUT_MS = 2_147_483_647;

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
					"How long to wait, such as 90m, 2h, 1h30m, 45s. Mutually exclusive with `at`.",
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
};

type Wake = {
	id: string;
	/** When the wake-up is due, as epoch milliseconds. */
	dueAt: number;
	/** Instruction left for the waking turn. */
	prompt: string;
	/** When the schedule was created, so the reminder can say how long it slept. */
	armedAt: number;
	/** Pending timer, cleared when the wake-up fires or is cancelled. */
	timer?: ReturnType<typeof setTimeout>;
};

type WakeEntry = {
	id: string;
	dueAt: number;
	prompt?: string;
	armedAt?: number;
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
			wake.timer = setTimeout(() => fire(wake.id), Math.max(0, remaining));
		}
		// Never hold the process open: in a one-shot run pi should still exit when
		// the turn is done instead of waiting for a wake-up that cannot be used.
		wake.timer.unref?.();
	}

	/** Persist a state change so a reopened session can rebuild the schedule. */
	function record(entry: WakeEntry) {
		pi.appendEntry<WakeEntry>(ENTRY_TYPE, entry);
	}

	/** Start the waking turn. */
	function fire(id: string) {
		const wake = wakes.get(id);
		if (!wake) return;
		wakes.delete(id);
		record({ id: wake.id, dueAt: wake.dueAt, prompt: wake.prompt, armedAt: wake.armedAt, firedAt: Date.now() });

		const late = Date.now() - wake.dueAt;
		const lines = [
			`⏰ 自动唤醒 · ${formatLocal(wake.dueAt)}`,
			"",
			"这是定时唤醒，不是用户发言。时间到了，继续之前的工作。",
		];
		if (late > 5_000) {
			lines.push(`（比预定时间晚了 ${formatSpan(late)}——期间 pi 没有在运行。）`);
		}
		lines.push(
			wake.prompt.trim()
				? `你当时给自己的指令：${wake.prompt.trim()}`
				: "你当时没有写下具体指令，按当前上下文继续。",
		);

		// `followUp` keeps a running turn intact; when idle it is ignored and
		// `triggerTurn` starts a fresh one. One call covers both cases.
		pi.sendMessage(
			{ customType: MESSAGE_TYPE, content: lines.join("\n"), display: true },
			{ triggerTurn: true, deliverAs: "followUp" },
		);
		sessionCtx?.ui?.notify(`pi-wake: 唤醒 ${wake.id} @ ${formatLocal(wake.dueAt)}`, "info");
	}

	/** Human-readable summary of one pending wake-up. */
	function describe(wake: Wake): string {
		const remaining = wake.dueAt - Date.now();
		const prompt = wake.prompt.trim() ? ` — "${wake.prompt.trim()}"` : "";
		return `${wake.id}: ${formatLocal(wake.dueAt)}（还有 ${formatSpan(remaining)}）${prompt}`;
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
			};
			wakes.set(wake.id, wake);
			arm(wake);
		}
	});

	pi.on("session_shutdown", async () => {
		for (const wake of wakes.values()) {
			if (wake.timer) clearTimeout(wake.timer);
		}
		wakes.clear();
		sessionCtx = undefined;
	});

	/* ---------------------------------------------------------------------- tool */

	pi.registerTool({
		name: "wake_up",
		label: "Wake Up",
		description:
			"Schedule a wake-up: this turn ends, and at the chosen time pi starts a new turn with a reminder so the work continues by itself. Also lists and cancels pending wake-ups. Wake-ups only fire while pi is running.",
		promptSnippet: "Schedule, list or cancel a self wake-up at a chosen time.",
		promptGuidelines: [
			"Use wake_up when the user asks to be reminded later, to check on something later, or to continue at a set time.",
			"Translate what the user said into either an absolute `at` (ISO 8601, e.g. 2026-11-12T09:30:00+08:00) or a relative `after` (e.g. 90m, 2h). Do not compute clock arithmetic yourself: pick whichever form the user's words match.",
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
				wakes.delete(id);
				record({ id, dueAt: wake.dueAt, cancelledAt: Date.now() });
				return reply(`已取消 ${id}（原定 ${formatLocal(wake.dueAt)}）。`, { cancelled: 1 });
			}

			// action === "schedule"
			const hasAt = Boolean(params.at?.trim());
			const hasAfter = Boolean(params.after?.trim());
			if (hasAt === hasAfter) {
				return reply(
					"给 `at`（绝对时间，ISO 8601）或 `after`（相对时长，如 90m）之一，不要都给或都不给。",
					{},
					true,
				);
			}

			let dueAt: number;
			if (hasAt) {
				const parsed = parseAt(params.at!);
				if ("error" in parsed) return reply(parsed.error, {}, true);
				dueAt = parsed.dueAt;
			} else {
				const parsed = parseAfter(params.after!);
				if ("error" in parsed) return reply(parsed.error, {}, true);
				dueAt = Date.now() + parsed.ms;
			}

			const now = Date.now();
			if (dueAt <= now) {
				return reply(
					`那个时间已经过去了（现在是 ${formatLocal(now)}）。要立刻继续就正常做事；要稍后，请给一个将来的时间或 after。`,
					{},
					true,
				);
			}

			const id = `w${++counter}`;
			const wake: Wake = { id, dueAt, prompt: params.prompt ?? "", armedAt: now };
			wakes.set(id, wake);
			arm(wake);
			record({ id, dueAt, prompt: wake.prompt, armedAt: now });

			const others = pending().filter((item) => item.id !== id);
			const text = [
				`已安排 ${id}：${formatLocal(dueAt)}，还有 ${formatSpan(dueAt - now)}。`,
				others.length ? `另有 ${others.length} 个待唤醒：${others.map((item) => item.id).join(", ")}。` : "",
				"本轮可以结束了；到点后我会带着提醒重新开始一轮。",
			]
				.filter(Boolean)
				.join("\n");
			return reply(text, { scheduled: true, id, dueAt, delayMs: dueAt - now });
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
