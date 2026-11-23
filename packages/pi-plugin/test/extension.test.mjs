// Offline tests for the pi-wake extension.
//
// The extension is loaded against a fake pi API, so the real timers are the ones
// under test: every case sleeps long enough for a short wake-up to fire and then
// asserts on what pi was asked to do.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

/** Collects everything the extension registers and emits. */
function createApi() {
	const tools = {};
	const commands = {};
	const handlers = {};
	const sent = [];
	const entries = [];
	const pi = {
		registerTool: (definition) => {
			tools[definition.name] = definition;
		},
		registerCommand: (name, options) => {
			commands[name] = options;
		},
		on: (event, handler) => {
			(handlers[event] ??= []).push(handler);
		},
		sendMessage: (message, options) => sent.push({ message, options }),
		appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
	};
	return { pi, tools, commands, handlers, sent, entries };
}

/** A session context with just the surface the extension touches. */
function createCtx({ idle = true, entries = [] } = {}) {
	const notes = [];
	return {
		notes,
		ctx: {
			cwd: process.cwd(),
			isIdle: () => idle,
			ui: { notify: (message, level) => notes.push({ message, level }) },
			sessionManager: { getEntries: () => entries },
		},
	};
}

/** Load the extension and run its session_start handlers, like pi would. */
async function boot({ entries = [] } = {}) {
	const api = createApi();
	const { default: activate } = await import("../src/index.ts");
	activate(api.pi);
	const { ctx, notes } = createCtx({ entries });
	for (const handler of api.handlers.session_start ?? []) {
		await handler({ type: "session_start" }, ctx);
	}
	return { ...api, ctx, notes };
}

const run = (tool, params) => tool.execute("call-1", params, undefined, undefined);
const textOf = (result) => result.content.map((part) => part.text).join("\n");

console.log("pi-wake");

// 1. `after` schedules, then the wake-up starts a new turn with the reminder.
{
	const { tools, sent, notes, entries } = await boot();
	const result = await run(tools.wake_up, { action: "schedule", after: "120ms", prompt: "继续跑 typecheck" });
	assert.equal(result.isError, undefined, textOf(result));
	assert.match(textOf(result), /Scheduled w1/, "the result names the wake-up");
	assert.equal(entries.length, 1, "the schedule is persisted as a session entry");

	assert.equal(sent.length, 0, "nothing is sent before the time is due");
	await sleep(220);

	assert.equal(sent.length, 1, "the wake-up fires once");
	const { message, options } = sent[0];
	assert.equal(message.customType, "wake_up", "the reminder has its own message type");
	assert.equal(message.display, true, "the reminder is visible in the transcript");
	assert.match(message.content, /Scheduled wake-up/, "the reminder says it is a scheduled wake-up");
	assert.match(message.content, /not the user speaking/, "the reminder tells the model this is not the user");
	assert.match(message.content, /继续跑 typecheck/, "the instruction for the waking turn is carried over");
	assert.deepEqual(options, { triggerTurn: true, deliverAs: "followUp" }, "it starts a turn without interrupting");
	assert.match(notes.at(-1).message, /wake w1/, "the user is told the wake-up fired");
	console.log("  ok   after 到点触发，提醒消息带上当时的指令");
}

// 2. `at` accepts an absolute time and ends up on the same delay path.
{
	const { tools, sent } = await boot();
	const at = new Date(Date.now() + 150).toISOString();
	const result = await run(tools.wake_up, { action: "schedule", at, prompt: "看 CI" });
	assert.equal(result.isError, undefined, textOf(result));
	assert.match(textOf(result), /Scheduled w1/);
	await sleep(260);
	assert.equal(sent.length, 1, "an absolute time fires too");
	assert.match(sent[0].message.content, /看 CI/);
	console.log("  ok   at 绝对时间同样走延迟逻辑");
}

// 3. A time in the past is refused instead of firing immediately.
{
	const { tools } = await boot();
	const at = new Date(Date.now() - 60_000).toISOString();
	const result = await run(tools.wake_up, { action: "schedule", at });
	assert.equal(result.isError, true, "a past time is an error");
	assert.match(textOf(result), /already passed/, "the message explains why");
	console.log("  ok   过去的时间被拒绝，并给出当前时间");
}

// 4. Exactly one of `at` / `after` is required.
{
	const { tools } = await boot();
	const both = await run(tools.wake_up, { action: "schedule", at: "2030-01-01T00:00:00", after: "1h" });
	assert.equal(both.isError, true, "both forms at once is an error");
	const neither = await run(tools.wake_up, { action: "schedule" });
	assert.equal(neither.isError, true, "no time at all is an error");
	console.log("  ok   at 与 after 必须二选一");
}

// 5. Unreadable durations and times are refused with the expected format.
{
	const { tools } = await boot();
	const badDuration = await run(tools.wake_up, { action: "schedule", after: "soon" });
	assert.equal(badDuration.isError, true);
	assert.match(textOf(badDuration), /90m/, "the error shows an example duration");
	const badTime = await run(tools.wake_up, { action: "schedule", at: "tomorrow morning" });
	assert.equal(badTime.isError, true, "free text is not a time");
	assert.match(textOf(badTime), /ISO 8601/, "the error names the accepted format");
	console.log("  ok   解析失败时给出可用的格式示例");
}

// 6. list reports what is pending, nearest first.
{
	const { tools } = await boot();
	await run(tools.wake_up, { action: "schedule", after: "2h", prompt: "后一个" });
	await run(tools.wake_up, { action: "schedule", after: "1h", prompt: "前一个" });
	const result = await run(tools.wake_up, { action: "list" });
	assert.equal(result.details.count, 2);
	const lines = textOf(result).split("\n");
	assert.match(lines[0], /w2/, "the sooner wake-up comes first");
	assert.match(lines[1], /w1/);
	assert.doesNotMatch(textOf(result), /Fired recently/, "a plain pending list carries no firing history");
	console.log("  ok   list 按时间排序列出待唤醒项");
}

// 7. Cancelling by id stops the timer.
{
	const { tools, sent, entries } = await boot();
	const scheduled = await run(tools.wake_up, { action: "schedule", after: "120ms" });
	const id = scheduled.details.id;
	const cancelled = await run(tools.wake_up, { action: "cancel", id });
	assert.equal(cancelled.details.cancelled, 1);
	assert.match(entries.at(-1).data.cancelledAt ? "recorded" : "", /recorded/, "the cancellation is persisted");
	await sleep(220);
	assert.equal(sent.length, 0, "a cancelled wake-up never fires");
	console.log("  ok   cancel 之后不再触发，并写入取消记录");
}

// 8. Cancelling everything clears the whole list.
{
	const { tools } = await boot();
	await run(tools.wake_up, { action: "schedule", after: "1h" });
	await run(tools.wake_up, { action: "schedule", after: "2h" });
	const result = await run(tools.wake_up, { action: "cancel", all: true });
	assert.equal(result.details.cancelled, 2);
	const list = await run(tools.wake_up, { action: "list" });
	assert.equal(list.details.count, 0, "nothing is left");
	console.log("  ok   cancel all 清空全部");
}

// 9. Cancelling an unknown id explains itself instead of failing silently.
{
	const { tools } = await boot();
	const result = await run(tools.wake_up, { action: "cancel", id: "w9" });
	assert.equal(result.isError, true);
	assert.match(textOf(result), /No wake-up with id "w9"/);
	const noId = await run(tools.wake_up, { action: "cancel" });
	assert.equal(noId.isError, true, "cancel needs an id or all");
	console.log("  ok   取消未知 id / 缺 id 都有明确报错");
}

// 10. A reopened session rebuilds pending wake-ups and fires an overdue one.
{
	const now = Date.now();
	const entries = [
		{ type: "custom", customType: "wake_up", data: { id: "w1", dueAt: now + 60_000, prompt: "未来的" } },
		{ type: "custom", customType: "wake_up", data: { id: "w2", dueAt: now - 30_000, prompt: "过期的" } },
		// Already handled entries must not come back.
		{ type: "custom", customType: "wake_up", data: { id: "w3", dueAt: now, firedAt: now - 1 } },
		{ type: "custom", customType: "wake_up", data: { id: "w4", dueAt: now + 5_000, cancelledAt: now - 1 } },
		// The last entry per id wins: w5 was rescheduled later.
		{ type: "custom", customType: "wake_up", data: { id: "w5", dueAt: now + 1_000 } },
		{ type: "custom", customType: "wake_up", data: { id: "w5", dueAt: now + 3_600_000 } },
	];
	const { tools, sent } = await boot({ entries });
	const list = await run(tools.wake_up, { action: "list" });
	assert.equal(list.details.count, 3, "w1, w2 and the rescheduled w5 survive");
	const ids = textOf(list)
		.split("\n")
		.map((line) => line.match(/w\d+/)?.[0])
		.filter(Boolean)
		.sort();
	assert.deepEqual(ids, ["w1", "w2", "w5"], "fired and cancelled wake-ups stay gone");

	await sleep(120);
	assert.equal(sent.length, 1, "the overdue wake-up fires on reopen");
	assert.match(sent[0].message.content, /过期的/);
	assert.match(sent[0].message.content, /late/, "it says the wake-up is late");
	console.log("  ok   重开会话时恢复未完成的唤醒，过期的立刻补发并说明迟到");
}

// 11. A wake-up weeks away is kept, not clamped into an immediate fire.
{
	const { tools, sent } = await boot();
	const result = await run(tools.wake_up, { action: "schedule", after: "40d" });
	assert.equal(result.isError, undefined, textOf(result));
	assert.ok(result.details.delayMs > 39 * 86_400_000, "the full delay is kept");
	await sleep(80);
	assert.equal(sent.length, 0, "a long wait does not fire early");
	const list = await run(tools.wake_up, { action: "list" });
	assert.equal(list.details.count, 1, "it stays pending");
	console.log("  ok   超过 setTimeout 上限的等待分包重排，不会提前触发");
}

// 12. Ids stay unique across a restarted session.
{
	const entries = [{ type: "custom", customType: "wake_up", data: { id: "w7", dueAt: Date.now() + 60_000 } }];
	const { tools } = await boot({ entries });
	const result = await run(tools.wake_up, { action: "schedule", after: "1h" });
	assert.equal(result.details.id, "w8", "the counter continues from the restored ids");
	console.log("  ok   重开后 id 继续递增，不会撞号");
}

// 13. The usage skill travels with the extension.
{
	const { handlers } = await boot();
	const discover = handlers.resources_discover ?? [];
	assert.equal(discover.length, 1, "resources_discover is registered");
	const { skillPaths } = await discover[0]({ type: "resources_discover" }, {});
	assert.equal(skillPaths.length, 1, "one skill directory is published");
	assert.ok(skillPaths[0].endsWith("skills/pi-wake"), `skill dir: ${skillPaths[0]}`);
	const skill = await readFile(`${skillPaths[0]}/SKILL.md`, "utf8");
	assert.match(skill, /^---\nname: pi-wake\n/, "the skill has a name in its frontmatter");
	assert.match(skill, /description:/, "the skill is discoverable by its description");
	console.log("  ok   resources_discover 发布 skill 目录，SKILL.md 带 frontmatter");
}

// 14. `every` repeats on its own cadence until it is cancelled.
{
	const { tools, sent } = await boot();
	const result = await run(tools.wake_up, { action: "schedule", every: "1s", prompt: "查两个 PR 的状态" });
	assert.equal(result.isError, undefined, textOf(result));
	assert.equal(result.details.intervalMs, 1_000, "the interval is reported back");
	assert.match(textOf(result), /then every/, "the result says it repeats");

	await sleep(1_100);
	assert.equal(sent.length, 1, "the first slot fires");
	assert.match(sent[0].message.content, /Repeats every/, "the reminder says it will come back");

	await sleep(1_100);
	assert.equal(sent.length, 2, "it fires again without being re-scheduled");

	const list = await run(tools.wake_up, { action: "list" });
	assert.equal(list.details.count, 1, "a repeating wake-up stays pending after firing");

	await run(tools.wake_up, { action: "cancel", all: true });
	const fired = sent.length;
	await sleep(1_200);
	assert.equal(sent.length, fired, "cancelling stops the repetition");
	assert.equal((await run(tools.wake_up, { action: "list" })).details.count, 0, "nothing is left pending");
	console.log("  ok   every 按固定节奏重复，cancel 之后不再唤醒");
}

// 15. `every` cannot be combined with `at`, and alone it starts one interval out.
{
	const { tools } = await boot();
	const conflict = await run(tools.wake_up, { action: "schedule", at: "2030-01-01T00:00:00", every: "5m" });
	assert.equal(conflict.isError, true, "an absolute first time and an interval are refused together");

	const alone = await run(tools.wake_up, { action: "schedule", every: "1h" });
	assert.equal(alone.isError, undefined, textOf(alone));
	assert.ok(alone.details.delayMs >= 3_599_000, "without after, the first firing is one interval away");
	assert.equal(alone.details.intervalMs, 3_600_000);

	const tooFast = await run(tools.wake_up, { action: "schedule", every: "10ms" });
	assert.equal(tooFast.isError, true, "a sub-second interval is refused");
	console.log("  ok   every 与 at 互斥，单独给 every 时首次延迟等于间隔，且拒绝亚秒间隔");
}

// 16. A restored repeating wake-up keeps its interval and re-arms instead of finishing.
{
	const entries = [{ type: "custom", customType: "wake_up", data: { id: "w9", dueAt: Date.now() + 80, intervalMs: 1_000 } }];
	const { tools, sent, entries: recorded } = await boot({ entries });
	const list = await run(tools.wake_up, { action: "list" });
	assert.match(textOf(list), /repeats every 1s/, "the pending list shows the cadence");

	await sleep(120);
	assert.equal(sent.length, 1, "the restored repeating wake-up fires");
	const rearm = recorded.at(-1).data;
	assert.equal(rearm.intervalMs, 1_000, "the re-arm keeps the interval");
	assert.ok(rearm.dueAt > Date.now(), "the next slot is in the future");
	assert.equal(rearm.firedAt, undefined, "a repeating wake-up is never marked finished");
	assert.equal(rearm.cancelledAt, undefined);
	console.log("  ok   重开会话后重复唤醒保留间隔并重新排期，不会被当成已结束");
}

// 17. A background subagent gets no wake_up tool: only the main session schedules.
{
	const previous = process.env.PI_SUBAGENT_CHILD;
	process.env.PI_SUBAGENT_CHILD = "1";
	try {
		const { tools, commands, sent } = await boot();
		assert.equal(tools.wake_up, undefined, "a child process does not register wake_up");
		assert.equal(commands.wake, undefined, "a child process does not register /wake");
		assert.equal(sent.length, 0);
	} finally {
		if (previous === undefined) delete process.env.PI_SUBAGENT_CHILD;
		else process.env.PI_SUBAGENT_CHILD = previous;
	}
	const { tools } = await boot();
	assert.ok(tools.wake_up, "the main session still gets the tool");
	console.log("  ok   后台子代理（PI_SUBAGENT_CHILD=1）不注册 wake_up，只有主会话能排计时器");
}

// 18. A `when` gate that does not hold keeps a repeating wake-up silent.
{
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wake-gate-"));
	const flag = path.join(dir, "flag");
	const { tools, sent, notes } = await boot();
	const result = await run(tools.wake_up, { action: "schedule", every: "1s", when: `test -f ${flag}`, prompt: "查 PR" });
	assert.equal(result.isError, undefined, textOf(result));
	assert.equal(result.details.gated, true, "the result says the wake-up is gated");

	await sleep(1_200);
	assert.equal(sent.length, 0, "a failing condition sends nothing");
	assert.equal((await run(tools.wake_up, { action: "list" })).details.count, 1, "it stays pending");
	assert.equal(notes.length, 0, "a quiet skip does not notify either");

	fs.writeFileSync(flag, "ok");
	await sleep(1_200);
	assert.equal(sent.length, 1, "the wake-up fires once the condition holds");
	try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
	console.log("  ok   when 条件不满足时重复唤醒保持沉默，条件成立才唤醒");
}

// 19. `whenChanged` fires only when the command's output actually moved.
{
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wake-changed-"));
	const state = path.join(dir, "state");
	fs.writeFileSync(state, "alpha");
	const { tools, sent } = await boot();
	await run(tools.wake_up, { action: "schedule", every: "1s", when: `cat ${state}`, whenChanged: true, prompt: "查两个 PR" });

	await sleep(1_200);
	assert.equal(sent.length, 1, "the first run differs from the empty baseline");
	assert.match(sent[0].message.content, /alpha/, "the reminder carries the condition output");

	await sleep(1_200);
	assert.equal(sent.length, 1, "an unchanged world stays silent");

	fs.writeFileSync(state, "beta");
	await sleep(1_200);
	assert.equal(sent.length, 2, "a changed output wakes it again");
	assert.match(sent[1].message.content, /beta/, "with the new output as evidence");
	try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
	console.log("  ok   whenChanged 只在输出变化时唤醒，并把输出作为证据带给唤醒回合");
}

// 20. A one-shot wake-up whose gate never holds is dropped, and says so.
{
	const { tools, sent, notes } = await boot();
	const result = await run(tools.wake_up, { action: "schedule", after: "100ms", when: "exit 1", prompt: "查 PR" });
	assert.equal(result.isError, undefined, textOf(result));
	await sleep(250);
	assert.equal(sent.length, 0, "no turn starts");
	assert.equal((await run(tools.wake_up, { action: "list" })).details.count, 0, "the wake-up is gone");
	assert.ok(notes.some((note) => /dropped/.test(note.message)), "the user is told instead of waiting forever");
	console.log("  ok   一次性唤醒条件不满足则丢弃并提示");
}

// 21. A condition that cannot run is reported once instead of blocking silently.
{
	const { tools, sent, notes } = await boot();
	await run(tools.wake_up, { action: "schedule", after: "100ms", when: "sleep 5", whenTimeout: 1, prompt: "查 PR" });
	await sleep(1_400);
	assert.equal(sent.length, 0, "a timed-out condition does not wake anything");
	assert.ok(notes.some((note) => /could not run/.test(note.message)), "the broken condition is surfaced");
	console.log("  ok   条件超时按不满足处理，并提示一次而不是静默永不唤醒");
}

// 22. `whenLang: "node"` runs the gate as a node program.
{
	const { tools, sent } = await boot();
	const result = await run(tools.wake_up, {
		action: "schedule",
		after: "100ms",
		whenLang: "node",
		when: 'console.log("node-gate-ok")',
		prompt: "查 PR",
	});
	assert.equal(result.isError, undefined, textOf(result));
	await sleep(400);
	assert.equal(sent.length, 1, "a node gate that exits 0 fires the wake-up");
	assert.match(sent[0].message.content, /node-gate-ok/u, "its stdout is the evidence");

	const dependent = await run(tools.wake_up, { action: "schedule", after: "1h", whenLang: "node" });
	assert.equal(dependent.isError, true, "whenLang without when is refused");
	console.log("  ok   whenLang: node 用 node 跑条件，且 whenLang 不能脱离 when 使用");
}

// 23. The reminder names the slot that fired, not the one it re-armed for.
{
	const { tools, sent } = await boot();
	await run(tools.wake_up, { action: "schedule", every: "1s", prompt: "查 PR" });
	await sleep(1_200);
	assert.equal(sent.length, 1, "the repeating wake-up fires");
	const stamp = sent[0].message.content.match(/Scheduled wake-up · ([^(]+)\(/)?.[1]?.trim();
	assert.ok(stamp, "the header carries a time");
	const firedAt = new Date(stamp.replace(/(\d+)\/(\d+)\/(\d+)/, "$3-$1-$2"));
	const drift = Math.abs(Date.now() - firedAt.getTime() - 1_000);
	assert.ok(drift < 900, `the header names the slot that fired, not the next one (drift ${drift}ms)`);
	console.log("  ok   重复唤醒的提醒写触发的那一槽，而不是重排后的下一槽");
}

// 24. `wait` has no clock: the command starts now and its exit fires the wake-up.
{
	const { tools, sent } = await boot();
	const result = await run(tools.wake_up, {
		action: "schedule",
		wait: 'sleep 0.15; echo "PR 42 ci-failed"',
		prompt: "看 PR 42 为什么红了",
	});
	assert.equal(result.isError, undefined, textOf(result));
	assert.match(textOf(result), /Started waiting on w1/, "the result names the waiting wake-up");
	assert.equal(sent.length, 0, "nothing is sent while the command is still running");

	await sleep(600);
	assert.equal(sent.length, 1, "the exit of the command fires the wake-up");
	assert.match(sent[0].message.content, /Wait command finished/, "the reminder says the command finished");
	assert.match(sent[0].message.content, /ci-failed/u, "the command's stdout is the evidence");
	assert.match(sent[0].message.content, /看 PR 42 为什么红了/u, "the instruction is carried over");
	console.log("  ok   wait 没有时间：命令退出码 0 即唤醒，stdout 作为证据");
}

// 25. A `wait` that exits non-zero reports once and drops the wake-up.
{
	const { tools, sent, notes } = await boot();
	const result = await run(tools.wake_up, { action: "schedule", wait: 'echo "auth failed" >&2; exit 3' });
	assert.equal(result.isError, undefined, textOf(result));
	await sleep(600);
	assert.equal(sent.length, 0, "a failing wait does not wake anything");
	assert.ok(notes.some((note) => /without waking/u.test(note.message) && /exit code 3/u.test(note.message)), "the failure is surfaced once");
	console.log("  ok   wait 非 0 退出不唤醒，只提示一次");
}

// 26. Cancelling a `wait` kills the process instead of leaving it running.
{
	const { tools } = await boot();
	const marker = path.join(os.tmpdir(), `piwake-wait-${process.pid}-${Date.now()}.txt`);
	const result = await run(tools.wake_up, {
		action: "schedule",
		wait: `while true; do echo tick >> '${marker}'; sleep 0.05; done`,
	});
	assert.equal(result.isError, undefined, textOf(result));
	await sleep(300);
	assert.ok(fs.statSync(marker).size > 0, "the watcher really runs");

	const cancelled = await run(tools.wake_up, { action: "cancel", all: true });
	assert.equal(cancelled.isError, undefined, textOf(cancelled));
	await sleep(300);
	const settled = fs.statSync(marker).size;
	await sleep(400);
	assert.equal(fs.statSync(marker).size, settled, "the waiting process stops writing after cancel");
	fs.rmSync(marker, { force: true });
	console.log("  ok   cancel 会杀掉等待中的进程，不留孤儿");
}

// 27. `wait` owns the schedule, so it refuses everything that also sets one.
{
	const { tools } = await boot();
	for (const conflict of [{ after: "1m" }, { at: "2099-01-01T00:00:00Z" }, { every: "5m" }]) {
		const result = await run(tools.wake_up, { action: "schedule", wait: "true", ...conflict });
		assert.equal(result.isError, true, `wait refuses ${Object.keys(conflict)[0]}`);
	}
	const withWhen = await run(tools.wake_up, { action: "schedule", wait: "true", when: "true" });
	assert.equal(withWhen.isError, true, "wait refuses a second condition");

	const langOnly = await run(tools.wake_up, { action: "schedule", after: "1m", waitLang: "node" });
	assert.equal(langOnly.isError, true, "waitLang without wait is refused");

	const nodeWait = await run(tools.wake_up, { action: "schedule", waitLang: "node", wait: 'console.log("node-wait-ok")' });
	assert.equal(nodeWait.isError, undefined, textOf(nodeWait));
	console.log("  ok   wait 与 at/after/every/when 互斥，waitLang 不能脱离 wait");
}

// 28. A waiting wake-up survives a reopened session: the command is started again.
{
	const { sent } = await boot({
		entries: [
			{
				type: "custom",
				customType: "wake_up",
				data: { id: "w3", dueAt: Date.now(), armedAt: Date.now(), prompt: "恢复后继续", wait: 'echo "restored-wait"' },
			},
		],
	});
	await sleep(600);
	assert.equal(sent.length, 1, "the restored wait fires when its command exits");
	assert.match(sent[0].message.content, /restored-wait/u, "the restarted command supplies the evidence");
	console.log("  ok   重开会话后 wait 会重新启动命令，退出时仍能唤醒");
}

// 29. A long-running `wait` keeps the tail of its output, not the head.
{
	const { tools, sent } = await boot();
	const result = await run(tools.wake_up, {
		action: "schedule",
		// 200 KB of stderr chatter would swallow a head-based buffer, and the same
		// amount of stdout noise would push the interesting line out of the head.
		wait: 'head -c 200000 /dev/zero | tr "\\0" "e" >&2; head -c 200000 /dev/zero | tr "\\0" "o"; echo "ci-failed  A required check has failed"',
		prompt: "看 PR",
	});
	assert.equal(result.isError, undefined, textOf(result));
	await sleep(1_500);
	assert.equal(sent.length, 1, "the wait fires even after a flood of output");
	assert.match(sent[0].message.content, /ci-failed  A required check has failed/u, "the last line survives as evidence");
	console.log("  ok   长时间运行的 wait 保留输出尾部，不被噪音挤掉");
}

// 30. Cancelling kills the grandchildren too, not just the shell that started them.
{
	const { tools } = await boot();
	const marker = path.join(os.tmpdir(), `piwake-tree-${process.pid}-${Date.now()}.txt`);
	// Shaped like `gh watch`: a wrapper that execs a second binary which does the
	// polling. Signalling only the wrapper leaves that binary running forever.
	const result = await run(tools.wake_up, {
		action: "schedule",
		wait: `sh -c 'while true; do echo tick >> "$0"; sleep 0.05; done' '${marker}' & wait`,
	});
	assert.equal(result.isError, undefined, textOf(result));
	await sleep(400);
	assert.ok(fs.statSync(marker).size > 0, "the inner watcher really runs");

	await run(tools.wake_up, { action: "cancel", all: true });
	await sleep(400);
	const settled = fs.statSync(marker).size;
	await sleep(500);
	assert.equal(fs.statSync(marker).size, settled, "the grandchild stops writing after cancel");
	fs.rmSync(marker, { force: true });
	console.log("  ok   cancel 连同孙进程一起杀掉，不留孤儿 watcher");
}


// 31. A paused wake-up survives a reload and stays paused.
{
	const now = Date.now();
	const entries = [
		{ type: "custom", customType: "wake_up", data: { id: "w1", dueAt: now + 60_000, prompt: "未来的" } },
		{ type: "custom", customType: "wake_up", data: { id: "w2", dueAt: now - 30_000, prompt: "暂停中的" } },
		{ type: "custom", customType: "wake_up", data: { id: "w2", dueAt: now - 30_000, prompt: "暂停中的", paused: true } },
		{ type: "custom", customType: "wake_up", data: { id: "w3", dueAt: now + 5_000, prompt: "暂停的后续", paused: true } },
	];
	const { tools, sent } = await boot({ entries });
	const list = await run(tools.wake_up, { action: "list" });
	assert.equal(list.details.count, 3, "a paused wake-up is restored instead of dropped");
	const rows = textOf(list).split("\n");
	assert.match(rows[0], /w2.*paused/, "the paused wake-up comes first and is marked paused");
	assert.match(rows[1], /w3.*paused/, "every paused wake-up is restored paused");
	assert.match(rows[2], /w1/, "the live wake-up is still pending");
	assert.doesNotMatch(rows[2], /paused/, "and it is not marked paused");

	await sleep(150);
	assert.equal(sent.length, 0, "the paused, overdue w2 does not fire on reopen");
	console.log("  ok   暂停状态跨会话保留：重开后仍显示 paused 且不补发");
}
// 32. A paused wake-up keeps its entry but never fires.
{
	const { tools, sent, entries } = await boot();
	const scheduled = await run(tools.wake_up, { action: "schedule", after: "80ms", prompt: "暂停的" });
	const id = scheduled.details.id;
	const paused = await run(tools.wake_up, { action: "pause", id });
	assert.equal(paused.isError, undefined, textOf(paused));
	assert.match(textOf(paused), /Paused w1/, "the reply names the wake-up");
	assert.equal(entries.at(-1).data.paused, true, "the pause is written to the session");

	const list = await run(tools.wake_up, { action: "list" });
	assert.match(textOf(list), /paused/, "the paused wake-up is listed as paused");
	assert.equal(list.details.count, 1, "it keeps its entry");

	await sleep(200);
	assert.equal(sent.length, 0, "a paused wake-up does not fire");
	console.log("  ok   暂停后不再触发，list 标出 paused，暂停状态写进会话");
}

// 33. Resuming fires per the documented semantics: an overdue one-shot wakes now.
{
	const now = Date.now();
	const { tools, sent } = await boot({
		entries: [
			{ type: "custom", customType: "wake_up", data: { id: "w2", dueAt: now - 120_000, prompt: "恢复后立刻继续", paused: true } },
		],
	});
	await sleep(50);
	assert.equal(sent.length, 0, "a paused entry restored from the session stays silent");

	const resumed = await run(tools.wake_up, { action: "resume", id: "w2" });
	assert.equal(resumed.isError, undefined, textOf(resumed));
	assert.match(textOf(resumed), /wakes you now/, "the reply says it fires immediately");
	await sleep(50);
	assert.equal(sent.length, 1, "a one-shot whose time passed while paused fires on resume");
	assert.match(sent[0].message.content, /恢复后立刻继续/u, "the instruction is carried over");
	assert.match(sent[0].message.content, /the wake-up was paused/u, "the reminder says why it is late");

	const list = await run(tools.wake_up, { action: "list" });
	assert.match(textOf(list), /late/u, "the recent-fires row says it fired late");
	console.log("  ok   恢复一次过期的一次性唤醒：立刻触发并说明只因暂停而迟到");
}

// 34. Resuming a paused `every` re-arms one full interval from the resume moment.
{
	const { tools, sent } = await boot();
	const scheduled = await run(tools.wake_up, { action: "schedule", every: "1s", prompt: "周期性恢复" });
	const id = scheduled.details.id;
	await run(tools.wake_up, { action: "pause", id });
	// Pause across two and a half intervals, so the slot the pause ate is far in
	// the past by the time of the resume: a `dueAt` carried over from before the
	// pause and one counted from the resume are then two separated slots, and the
	// checkpoints below can tell them apart.
	await sleep(2_500);
	assert.equal(sent.length, 0, "the slots that passed while paused are not fired");

	const resumed = await run(tools.wake_up, { action: "resume", id });
	assert.equal(resumed.isError, undefined, textOf(resumed));
	await sleep(400);
	assert.equal(sent.length, 0, "the next slot is a full interval after the resume, not a missed one");
	await sleep(1_100);
	assert.equal(sent.length, 1, "it fires one interval after the resume");
	assert.match(sent[0].message.content, /Repeats every/u, "it is still repeating");
	console.log("  ok   恢复 every：下一槽从恢复那一刻重新计算，不补发错过的槽");
}

// 35. `list` keeps only the five most recent firings, newest first.
{
	const { tools } = await boot();
	for (let index = 1; index <= 7; index += 1) {
		// Staggered on purpose: the history keeps push order, and `when` gates
		// finish in their own time, so simultaneous slots would make the cap flaky.
		await run(tools.wake_up, { action: "schedule", after: `${index * 200}ms`, when: `echo run-${index}`, prompt: `第 ${index} 次` });
	}
	await sleep(1_900);
	const list = await run(tools.wake_up, { action: "list" });
	const text = textOf(list);
	const rows = text.split("\n").filter((line) => /fired/.test(line));
	assert.equal(rows.length, 5, "only the five most recent firings are kept");
	assert.match(rows[0], /w7/, "the newest firing comes first");
	assert.match(rows[4], /w3/, "the oldest kept firing is the fifth newest");
	assert.doesNotMatch(text, /w1: fired|w2: fired/, "the older firings fell out of the cap");
	assert.match(rows[0], /run-7/, "the row carries the condition output as evidence");
	assert.match(rows[0], /\(on time\)/, "a timely firing says so");
	console.log("  ok   list 只保留最近 5 条触发记录，最新的在前，并带证据摘要");
}

// 36. A `wait` wake-up can be paused and resumed, and the child the pause killed
// must not speak for it: that stale `close` arriving after the resume is what
// used to drop the wake-up and report it ended without waking.
{
	const { tools, sent, notes } = await boot();
	const marker = path.join(os.tmpdir(), `piwake-resume-${process.pid}-${Date.now()}.txt`);
	// Shaped like a watcher that writes as it polls and has to be stopped on pause:
	// on TERM it stops writing at once and exits non-zero a moment later, so its
	// `close` lands after the resume — the only window where it can misfire.
	const result = await run(tools.wake_up, {
		action: "schedule",
		wait: `trap 'sleep 1.2; exit 7' TERM; while true; do echo tick >> '${marker}'; sleep 0.05; done`,
		prompt: "等 PR 更新",
	});
	assert.equal(result.isError, undefined, textOf(result));
	const id = result.details.id;
	await sleep(300);
	assert.ok(fs.statSync(marker).size > 0, "the watcher really runs");

	const paused = await run(tools.wake_up, { action: "pause", id });
	assert.equal(paused.isError, undefined, textOf(paused));
	await sleep(250);
	const stopped = fs.statSync(marker).size;
	await sleep(350);
	assert.equal(fs.statSync(marker).size, stopped, "the watch command stops writing while paused");

	const resumed = await run(tools.wake_up, { action: "resume", id });
	assert.equal(resumed.isError, undefined, textOf(resumed));
	await sleep(1_300);
	// The child signalled by the pause has closed by now; the resumed one still runs.
	assert.ok(fs.statSync(marker).size > stopped, "the watch command runs again after resume");
	assert.equal(sent.length, 0, "the resumed watcher has not woken anything yet");
	assert.equal((await run(tools.wake_up, { action: "list" })).details.count, 1, "the wake-up is still waiting");
	assert.ok(
		!notes.some((note) => /ended without waking/u.test(note.message)),
		"the child paused away does not report having ended without waking",
	);

	// The stale `close` above must not have forgotten which child is live: cancel
	// has to reach the watcher the resume started, not nothing at all.
	const cancelled = await run(tools.wake_up, { action: "cancel", all: true });
	assert.equal(cancelled.isError, undefined, textOf(cancelled));
	await sleep(300);
	const settledAfterCancel = fs.statSync(marker).size;
	await sleep(400);
	assert.equal(fs.statSync(marker).size, settledAfterCancel, "cancel kills the watcher the resume started, not a handle the stale close dropped");
	fs.rmSync(marker, { force: true });
	console.log("  ok   pause/resume 后 watch 命令继续运行，被 pause 杀掉的旧子进程不会误报结束");
}

// 37. A `when` evaluation that started before a pause, and resolves after the
// resume, must not fire the slot the pause was asked to hold. A `wait` child has
// a `close` to be told apart by; a `when` evaluation has nothing but the counter
// the resume bumps, so a stale one would wake an `every` wake-up early and
// recount its cadence from the missed slot.
{
	const { tools, sent } = await boot();
	const result = await run(tools.wake_up, {
		action: "schedule",
		every: "1s",
		when: "sleep 1; echo gated",
		prompt: "查 PR",
	});
	assert.equal(result.isError, undefined, textOf(result));
	const id = result.details.id;

	// Slot one is at ~1s and starts a 1s condition, so the pause lands inside
	// that window: the condition is still running when the pause is issued.
	await sleep(1_300);
	const paused = await run(tools.wake_up, { action: "pause", id });
	assert.equal(paused.isError, undefined, textOf(paused));
	await sleep(200);
	const resumed = await run(tools.wake_up, { action: "resume", id });
	assert.equal(resumed.isError, undefined, textOf(resumed));

	// The pre-pause condition resolves here, ~0.5s after the resume: it belongs
	// to the pause, so it wakes nothing. A stale attempt would send its reminder.
	await sleep(800);
	assert.equal(sent.length, 0, "a condition started before the pause does not fire after the resume");
	assert.equal((await run(tools.wake_up, { action: "list" })).details.count, 1, "the repeating wake-up is still pending");

	// The slot re-armed from the moment of resume still fires, once.
	await sleep(1_600);
	assert.equal(sent.length, 1, "the resumed slot fires once, on its own time");
	assert.match(sent[0].message.content, /Repeats every/u, "it is still the repeating wake-up that fired");
	await run(tools.wake_up, { action: "cancel", all: true });
	console.log("  ok   pause 期间开始的 when 求值在 resume 后不补发旧槽，恢复后的槽照常唤醒一次");
}

// 38. A second `session_start` starts a fresh fired history: the rows belong to
// the session that produced them, so /new does not inherit another's firings.
{
	const { tools, handlers, ctx } = await boot();
	await run(tools.wake_up, { action: "schedule", after: "80ms", when: "echo done", prompt: "查 PR" });
	await sleep(400);
	const before = textOf(await run(tools.wake_up, { action: "list" }));
	assert.match(before, /Fired recently/, "the firing is remembered before the session restarts");

	for (const handler of handlers.session_start ?? []) await handler({ type: "session_start" }, ctx);
	const after = textOf(await run(tools.wake_up, { action: "list" }));
	assert.doesNotMatch(after, /Fired recently/, "a second session_start drops the fired history");
	console.log("  ok   第二次 session_start 清空 fired 历史，新会话的 list 不带上一段会话的触发记录");
}

// 39. The stale `close` can also land while the pause still holds, not only after
// a resume. In that window `wake.paused` alone stops it: a `wait` whose child
// ignores SIGTERM long enough to die inside the pause stays pending, stays
// paused, and is not reported as having ended without waking.
{
	const { tools, notes } = await boot();
	const marker = path.join(os.tmpdir(), `piwake-pausedonly-${process.pid}-${Date.now()}.txt`);
	// Same trap as case 36: on TERM the watcher stops writing at once and exits
	// 1.2s later, so its `close` arrives while the wake-up is still paused.
	const result = await run(tools.wake_up, {
		action: "schedule",
		wait: `trap 'sleep 1.2; exit 7' TERM; while true; do echo tick >> '${marker}'; sleep 0.05; done`,
		prompt: "等 PR 更新",
	});
	assert.equal(result.isError, undefined, textOf(result));
	const id = result.details.id;
	await sleep(300);
	assert.ok(fs.statSync(marker).size > 0, "the watcher really runs");

	const paused = await run(tools.wake_up, { action: "pause", id });
	assert.equal(paused.isError, undefined, textOf(paused));

	// Past the trap's 1.2s delay: the killed child has closed by now, and the
	// pause is still in force.
	await sleep(1_500);
	const stopped = fs.statSync(marker).size;
	const list = await run(tools.wake_up, { action: "list" });
	assert.equal(list.details.count, 1, "a paused wake-up whose child died is still pending");
	assert.match(textOf(list), /paused/, "and it is still listed as paused");
	assert.ok(
		!notes.some((note) => /ended without waking/u.test(note.message)),
		"a stale close inside the pause is not reported as an ending",
	);

	// The entry survived: resume starts the command again.
	const resumed = await run(tools.wake_up, { action: "resume", id });
	assert.equal(resumed.isError, undefined, textOf(resumed));
	await sleep(300);
	assert.ok(fs.statSync(marker).size > stopped, "resume starts the watch command again");

	await run(tools.wake_up, { action: "cancel", all: true });
	await sleep(300);
	const settled = fs.statSync(marker).size;
	await sleep(400);
	assert.equal(fs.statSync(marker).size, settled, "cancel still reaps the restarted watcher");
	fs.rmSync(marker, { force: true });
	console.log("  ok   暂停期间旧子进程退出不会被当成结束：仍 pending、仍 paused，resume 能重新启动命令");
}

// 40. A `when` evaluation can also resolve *inside* the pause, with no resume in
// between. Case 37 resumes before the condition resolves, so it only exercises
// the counter; this window is the one where `wake.paused` alone discards the
// result, and the pause no longer bumps the counter, so nothing else covers it.
{
	const { tools, sent } = await boot();
	const result = await run(tools.wake_up, {
		action: "schedule",
		every: "1s",
		when: "sleep 1; echo gated",
		prompt: "查 PR",
	});
	assert.equal(result.isError, undefined, textOf(result));
	const id = result.details.id;

	// Slot one is at ~1s and starts a 1s condition; the pause lands inside that
	// window and is never resumed, so the condition resolves while paused.
	await sleep(1_300);
	const paused = await run(tools.wake_up, { action: "pause", id });
	assert.equal(paused.isError, undefined, textOf(paused));

	// The condition started before the pause resolves here: no wake-up may follow.
	await sleep(1_500);
	assert.equal(sent.length, 0, "a condition that resolves inside the pause fires nothing");
	const list = await run(tools.wake_up, { action: "list" });
	assert.equal(list.details.count, 1, "the paused wake-up is still pending");
	assert.match(textOf(list), /paused/, "and it is still listed as paused");

	await run(tools.wake_up, { action: "cancel", all: true });
	console.log("  ok   暂停期间解析的 when 只被 paused 丢弃，不会补发唤醒");
}
// 宿主提供的包必须写在 peerDependencies（范围 "*"），不能进 dependencies。
//
// pi 的原文（docs/packages.md「Declare dependencies」）：宿主把这些包直接供给扩展，放进
// dependencies 会装出第二份物理副本，绕过扩展的模块映射。typebox 这种 schema 库最隐蔽 ——
// 扩展里的 Type.Object(...) 与宿主校验用的不是同一个模块实例，schema 身份判断失效，
// 表现为「参数校验莫名其妙不生效」。0.1.1 就是因为 typebox 在 dependencies 里被 pi 报过警告。
const HOST_PROVIDED = new Set([
	"@earendil-works/pi-ai",
	"@earendil-works/pi-agent-core",
	"@earendil-works/pi-coding-agent",
	"@earendil-works/pi-tui",
	"typebox",
]);
const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

const inDependencies = Object.keys(manifest.dependencies ?? {}).filter((name) => HOST_PROVIDED.has(name));
assert.deepEqual(
	inDependencies,
	[],
	`host-provided packages belong in peerDependencies("*"), not dependencies: ${inDependencies.join(", ")}`,
);

// 源码真正 import 的宿主包，peer 范围必须是 "*"（钉一个版本也算错：宿主的实例才是那份）。
const imported = new Set();
const walkSrc = async (dir) => {
	for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
		const absolute = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			await walkSrc(absolute);
			continue;
		}
		if (!entry.name.endsWith(".ts")) continue;
		const text = await readFile(absolute, "utf8");
		for (const match of text.matchAll(/(?:from|import)\s+["']([^"']+)["']/g)) {
			const specifier = match[1];
			if (specifier.startsWith(".") || specifier.startsWith("node:")) continue;
			imported.add(specifier);
		}
	}
};
await walkSrc(new URL("../src", import.meta.url).pathname);

const referenced = [...imported].filter((name) => HOST_PROVIDED.has(name)).sort();
// 正对照：一条都没扫到说明扫描坏了，否则下面的断言会在空集上永远绿。
assert.ok(referenced.length > 0, `no host-provided package found in ${imported.size} imports — the scan broke`);

for (const name of referenced) {
	assert.equal(
		manifest.peerDependencies?.[name],
		"*",
		`${name} is imported by src/ and must be a peerDependency with range "*"`,
	);
	// 本地 typecheck 与测试仍要用真实那一份。
	assert.ok(manifest.devDependencies?.[name], `${name} needs a devDependency too, or a fresh checkout cannot type check`);
}
console.log(`  ok   宿主提供的包只声明成 peer（${referenced.join(", ")}），不进 dependencies`);

console.log("\npi-wake 测试通过");
