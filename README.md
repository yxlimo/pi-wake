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
| `schedule` | `at`, `after` or `every`, or `wait`; plus `prompt`; optional `when` gate | arm a wake-up, returns its `id`; `every` repeats until cancelled; `wait` fires when its command exits |
| `list` | — | pending wake-ups, nearest first, with the time left |
| `cancel` | `id`, or `all: true` | drop one or all pending wake-ups |

**Time.** `at` is an absolute time in ISO 8601 (`2026-11-12T09:30:00+08:00`). An
offset wins; without one the local time zone is used. A bare date
(`2026-11-12`) means local midnight. `after` is a duration with units: `90m`,
`2h`, `1h30m`, `45s`, `3d`. Both forms end up as a delay from now.

**Repeat.** `every` takes the same durations and makes the wake-up come back at
that interval until it is cancelled — `wake_up({ action: "schedule", every: "5m",
prompt: "查 PR 的 review 与 CI，有要求就改" })`. Without `after` the first one
fires one interval from now; with `after`, that is only the first delay. The
minimum interval is `1s`.

**Gate.** `when` runs a command when the time comes and only wakes you if it
exits 0, so a recurring check can stay silent when there is nothing to report.
`whenLang` picks `sh` (default) or `node`; `whenChanged: true` additionally
requires the command's stdout to differ from the run that last fired, which is
the usual way to ask for "wake me only when this actually changed"; `whenTimeout`
(default 30s, max 300s) bounds it. The command reads `$PI_WAKE_ID` and
`$PI_WAKE_LAST_STDOUT`, and its stdout is quoted in the reminder as evidence.

**Wait.** `wait` replaces the clock: the command starts now and the wake-up fires
when it exits 0 — `wake_up({ action: "schedule", wait: "gh watch pr 42 --exit",
prompt: "PR 有动静了：看输出" })`. There is no interval and no deadline, so it
cannot be combined with `at`, `after`, `every` or `when`. A non-zero exit wakes
nothing: the wake-up is dropped and reported once with the exit code and the tail
of stderr. The process is killed on `cancel` and when the session ends, and a
pending one is started again when the session is reopened. Its stdout is the
evidence in the reminder.

Its `whenLang` counterpart is `waitLang` (`sh` default, or `node`).

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

A `wait` wake-up says the command finished rather than naming a time:

````text
⏰ 等待的命令已结束 · 2026-11-12 09:30:00 (Asia/Shanghai)

这是条件唤醒，不是用户发言。你之前排的那个等待命令退出了，且退出码为 0。
唤醒时条件的输出：
```
ci-failed  A required check has failed
```
````

The message is injected as an extension message, marked as an automatic wake-up
so the model does not mistake it for the user speaking. It starts a new turn when
pi is idle; if a turn is still running at that moment, it is queued as a
follow-up instead of interrupting.

## Skill

The package ships a usage skill at `packages/pi-plugin/skills/pi-wake/SKILL.md`, registered
through `resources_discover` — so every session that loads the extension gets the
conventions without anything added to `AGENTS.md`:

- when a wake-up is the right tool and when it is not
- the time forms (`at`, `after`, repeating `every`) and how to translate what a
  user said into one of them
- `wait` for work that reports its own completion, and when a watcher is better
  than an interval
- how to write the `when`/`wait` command: the exit status is the whole signal,
  stdout is the evidence, a timestamp in that output defeats `whenChanged`, and
  `when` must not poll in a loop
- what belongs in `prompt` (the next action, plus any path or URL it needs)
- the limits worth mentioning to a user: pi must be running, and a repeating
  wake-up keeps going until it is cancelled

Loading the extension is the only requirement; `files` in `package.json` includes
`skills`, so it travels with an npm install too.

## Limits

- **pi has to be running.** The timer lives in the pi process. Close pi and
  pending wake-ups stop firing — in `-p`/print mode pi exits at the end of the
  turn, so wake-ups only make sense in interactive or RPC sessions.
- **Reopening a session restores pending wake-ups.** The schedule is stored in
  the session file, so `/resume` picks it up again. A wake-up that came due while
  pi was closed fires immediately on reopen, and its message says how late it is.
- **Repeating wake-ups keep the cadence and skip missed slots.** With `every` the
  wake-up re-arms itself after each firing. If pi was closed across several
  slots, it fires once and continues from the next slot instead of catching up.
  Only `cancel` stops it.
- **Subagents get no `wake_up`.** A background child runs with
  `PI_SUBAGENT_CHILD=1` and loads ambient extensions, so a global install reaches
  it too; the extension then registers nothing, because a wake scheduled inside a
  child would start a turn in a run that is already ending.
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
cover arming, firing, cancelling, session restore, the long-delay chunking, and
the published skill directory.
