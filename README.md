# pi-wake

Let the assistant wake itself up at a chosen time.

The assistant schedules a wake-up, ends its turn, and pi starts a new turn when
the time comes — with a reminder of what it meant to do next. Nothing needs to be
typed.

```text
wake_up({ action: "schedule", after: "90m", prompt: "继续跑 typecheck" })
wake_up({ action: "schedule", at: "2026-11-12T09:30:00+08:00", prompt: "看 CI 跑完没" })
wake_up({ action: "list" })
wake_up({ action: "cancel", id: "w1" })
wake_up({ action: "cancel", all: true })
```

## Install

```bash
cd packages/pi-plugin
./install.sh
```

That links the package into `~/.pi/agent/extensions/pi-wake`, and the next pi
session loads it. `./install.sh --uninstall` removes the link. To use it in one
session only:

```bash
pi -e ~/extensions/pi-wake/packages/pi-plugin/src/index.ts
```

For a subagent, declare it in the agent frontmatter:

```yaml
subagentOnlyExtensions: ~/extensions/pi-wake/packages/pi-plugin/src/index.ts
```

## Tool reference

`wake_up` takes one `action`:

| action | fields | effect |
| --- | --- | --- |
| `schedule` | `at` or `after` (one of them), `prompt` | arm a wake-up, returns its `id` |
| `list` | — | pending wake-ups, nearest first, with the time left |
| `cancel` | `id`, or `all: true` | drop one or all pending wake-ups |

**Time.** `at` is an absolute time in ISO 8601 (`2026-11-12T09:30:00+08:00`). An
offset wins; without one the local time zone is used. A bare date
(`2026-11-12`) means local midnight. `after` is a duration with units: `90m`,
`2h`, `1h30m`, `45s`, `3d`. Both forms end up as a delay from now.

**Prompt.** `prompt` is what the waking turn is told to do. Write the next
action, not a restatement of the task — the waking turn still has the whole
conversation, so "看 CI 跑完没" is enough and "keep working on the thing" is not.

The result of `schedule` names the resolved absolute time and the delay, so you
can confirm the time was read the way you meant.

## What the waking turn receives

```text
⏰ 自动唤醒 · 2026-11-12 09:30:00 (Asia/Shanghai)

这是定时唤醒，不是用户发言。时间到了，继续之前的工作。
你当时给自己的指令：看 CI 跑完没
```

The message is injected as an extension message, marked as an automatic wake-up
so the model does not mistake it for the user speaking. It starts a new turn when
pi is idle; if a turn is still running at that moment, it is queued as a
follow-up instead of interrupting.

## Limits

- **pi has to be running.** The timer lives in the pi process. Close pi and
  pending wake-ups stop firing — in `-p`/print mode pi exits at the end of the
  turn, so wake-ups only make sense in interactive or RPC sessions.
- **Reopening a session restores pending wake-ups.** The schedule is stored in
  the session file, so `/resume` picks it up again. A wake-up that came due while
  pi was closed fires immediately on reopen, and its message says how late it is.
- **No repeats.** A wake-up fires once. Schedule another one from the waking turn
  if you want a second check.
- **One process at a time.** Two pi sessions on the same session file would each
  arm their own timer; nothing coordinates them.

## Development

```bash
cd packages/pi-plugin
pnpm install
pnpm run typecheck
pnpm test
```

`pnpm-workspace.yaml` sets `strictDepBuilds: false`: pi's transitive dependencies
ship build scripts this package never uses, and pnpm 10+ otherwise refuses to
install.

The tests load the extension against a fake pi API and use real timers, so they
cover arming, firing, cancelling, session restore and the long-delay chunking.
