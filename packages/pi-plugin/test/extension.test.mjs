// Offline tests for the pi-wake extension.
//
// The extension is loaded against a fake pi API, so the real timers are the ones
// under test: every case sleeps long enough for a short wake-up to fire and then
// asserts on what pi was asked to do.

import assert from "node:assert/strict";
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
	assert.match(textOf(result), /已安排 w1/, "the result names the wake-up");
	assert.equal(entries.length, 1, "the schedule is persisted as a session entry");

	assert.equal(sent.length, 0, "nothing is sent before the time is due");
	await sleep(220);

	assert.equal(sent.length, 1, "the wake-up fires once");
	const { message, options } = sent[0];
	assert.equal(message.customType, "wake_up", "the reminder has its own message type");
	assert.equal(message.display, true, "the reminder is visible in the transcript");
	assert.match(message.content, /自动唤醒/, "the reminder says it is an automatic wake-up");
	assert.match(message.content, /不是用户发言/, "the reminder tells the model this is not the user");
	assert.match(message.content, /继续跑 typecheck/, "the instruction for the waking turn is carried over");
	assert.deepEqual(options, { triggerTurn: true, deliverAs: "followUp" }, "it starts a turn without interrupting");
	assert.match(notes.at(-1).message, /唤醒 w1/, "the user is told the wake-up fired");
	console.log("  ok   after 到点触发，提醒消息带上当时的指令");
}

// 2. `at` accepts an absolute time and ends up on the same delay path.
{
	const { tools, sent } = await boot();
	const at = new Date(Date.now() + 150).toISOString();
	const result = await run(tools.wake_up, { action: "schedule", at, prompt: "看 CI" });
	assert.equal(result.isError, undefined, textOf(result));
	assert.match(textOf(result), /已安排 w1/);
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
	assert.match(textOf(result), /已经过去/, "the message explains why");
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
	assert.match(textOf(result), /没有 id 为 "w9"/);
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
	assert.match(sent[0].message.content, /晚了/, "it says the wake-up is late");
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
	assert.match(textOf(result), /重复/, "the result says it repeats");

	await sleep(1_100);
	assert.equal(sent.length, 1, "the first slot fires");
	assert.match(sent[0].message.content, /重复/, "the reminder says it will come back");

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
	assert.match(textOf(list), /每 1s 重复/, "the pending list shows the cadence");

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

console.log("\npi-wake 测试通过");
