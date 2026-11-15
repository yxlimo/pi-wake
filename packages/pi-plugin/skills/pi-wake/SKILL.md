---
name: pi-wake
description: Use when work has to resume on its own at a later time — waiting for CI, a build, a deploy, a rate limit, or a user-requested reminder. Covers the wake_up tool (action schedule / list / cancel), the time forms (absolute `at` in ISO 8601, relative `after` like 90m, repeating `every` like 5m), what the waking turn receives, and the limits (pi must stay running).
---

# pi-wake: waking yourself up later

`wake_up` arms a timer and lets the current turn end. When the time comes, pi
starts a fresh turn with a reminder message. Nobody types anything.

Use it when the next step is *time-gated* — the only thing missing is elapsed
time:

- waiting for CI, a build, a deploy, or a migration to finish
- waiting out a rate limit or a backoff window
- the user asks to be reminded, or to "check again in a bit"
- polling something that changes slowly, a few times an hour

Do not use it as a substitute for doing the work now, and do not use it to wait
on something you could just check synchronously.

## Scheduling

```text
wake_up({ action: "schedule", after: "90m", prompt: "继续跑 typecheck" })
wake_up({ action: "schedule", at: "2026-11-12T09:30:00+08:00", prompt: "看 CI 跑完没" })
wake_up({ action: "schedule", after: "8s", prompt: "读 /tmp/build.log 最后 50 行，失败就修" })
wake_up({ action: "schedule", every: "5m", prompt: "查 PR 的 review 与 CI，有要求就改" })
```

Give `at`, `after`, or `every` — at most one of `at` and `after`:

| form | value | notes |
| --- | --- | --- |
| `at` | `2026-11-12T09:30:00+08:00` | ISO 8601. An offset wins; without one, local time. A bare date means local midnight. |
| `after` | `90m`, `2h`, `1h30m`, `45s`, `3d` | units required (`ms`, `s`, `m`, `h`, `d`) |
| `every` | `5m`, `1h` | repeats at that interval until cancelled. Minimum `1s`. Cannot be combined with `at`; with `after`, `after` is only the first delay, and alone it starts one interval out. |

Translate what the user said into one of these forms instead of computing
clock arithmetic: "明早九点" becomes `at`, "过一会儿" becomes `after`, "每五分钟
看一眼" becomes `every`. The result reports the resolved absolute time, the
remaining delay, and the interval when it repeats, so check those before telling
the user anything.

A time in the past is refused rather than fired immediately — if the user means
"now", just continue working.

## What to put in `prompt`

`prompt` is the instruction the waking turn gives itself. The waking turn keeps
the whole conversation, so write the *next action*, not a recap:

- good: `看 CI 跑完没，失败就修` / `reply with WAKE-OK` / `读 /tmp/build.log 末尾 50 行`
- useless: `继续之前的工作` / `keep going`

Include the concrete artifact (a URL, a path, a command) when the waking turn
would otherwise have to rediscover it.

## What the waking turn gets

```text
⏰ 自动唤醒 · 2026-11-12 09:30:00 (Asia/Shanghai)

这是定时唤醒，不是用户发言。时间到了，继续之前的工作。
你当时给自己的指令：看 CI 跑完没
```

It arrives as an extension message, not a user message, and is queued as a
follow-up: if a turn is still running it waits for that turn to finish rather
than interrupting it. When the session is idle it starts a new run.

## Seeing and cancelling

```text
wake_up({ action: "list" })                   // pending, nearest first, with time left
wake_up({ action: "cancel", id: "w1" })
wake_up({ action: "cancel", all: true })
```

Humans can list the same thing with the `/wake` command.

## Limits

- **pi must be running.** The timer lives in the pi process; closing pi drops
  pending wake-ups. In `-p`/print mode pi exits when the turn ends, so a wake-up
  there never fires.
- **Reopening a session restores pending wake-ups**, because the schedule is in
  the session file. One that came due while pi was closed fires on reopen, and
  the message says how late it is.
- **Repeating wake-ups keep a fixed cadence and skip missed slots.** `every`
  re-arms itself after each firing; if pi was closed across several slots, the
  wake-up does not fire them back to back, it continues from the next slot. It
  stays pending until `cancel`, so cancelling is the only way to stop it.
- **Only the main session has this tool.** Background subagents load the
  extension with `PI_SUBAGENT_CHILD=1` and get no `wake_up`; a subagent that
  needs a later check reports it to the parent instead.
- **Do not promise background work.** A scheduled wake-up is not a background
  job: tell the user the wake-up time, and say the work happens when pi is open
  at that time.
