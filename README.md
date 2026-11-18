# pi-wake

Let the assistant wake itself up at a chosen time, or when a command it started exits.

The assistant schedules a wake-up, ends its turn, and pi starts a new turn when
the time comes — with a reminder of what it meant to do next. Nothing needs to be
typed.

```text
wake_up({ action: "schedule", after: "90m", prompt: "run the typecheck again" })
wake_up({ action: "schedule", at: "2026-11-12T09:30:00+08:00", prompt: "check whether CI finished" })
wake_up({ action: "list" })
wake_up({ action: "pause", id: "w1" })
wake_up({ action: "resume", id: "w1" })
wake_up({ action: "cancel", id: "w1" })
wake_up({ action: "cancel", all: true })
```

## Install

From npm, which is also what the pi package gallery lists:

```bash
pi install npm:@yxlimo/pi-wake
```

From a clone:

```bash
cd packages/pi-plugin
./install.sh
```

That links the package into `~/.pi/agent/extensions/pi-wake`, and the next pi
session loads it. `./install.sh --uninstall` removes the link. To use it in one
session only:

```bash
pi -e <clone>/packages/pi-plugin/src/index.ts
```

## Tool reference

`wake_up` takes one `action`:

| action | fields | effect |
| --- | --- | --- |
| `schedule` | `at`, `after` or `every`, or `wait`; plus `prompt`; optional `when` gate | arm a wake-up, returns its `id`; `every` repeats until cancelled; `wait` fires when its command exits |
| `list` | — | pending wake-ups, nearest first, with the time left (a `wait` entry shows how long it has been waiting), plus the five most recent firings |
| `pause` | `id` | stop a wake-up firing without dropping it; a paused `wait` has its command stopped |
| `resume` | `id` | re-arm it: `every` waits a full interval from now, an overdue one-shot fires at once |
| `cancel` | `id`, or `all: true` | drop one or all pending wake-ups |

The same list is available to a human as the `/wake` command.

**Time.** `at` is an absolute time in ISO 8601 (`2026-11-12T09:30:00+08:00`). An
offset wins; without one the local time zone is used. A bare date
(`2026-11-12`) means local midnight. `after` is a duration with units: `90m`,
`2h`, `1h30m`, `45s`, `3d`. Both forms end up as a delay from now.

**Repeat.** `every` takes the same durations and makes the wake-up come back at
that interval until it is cancelled or paused — `wake_up({ action: "schedule", every: "5m",
prompt: "check the PR for reviews and CI, and act on anything asked" })`. Without `after` the first one
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
prompt: "the PR moved: read the output" })`. There is no interval and no deadline, so it
cannot be combined with `at`, `after`, `every` or `when`. A non-zero exit wakes
nothing: the wake-up is dropped and reported once with the exit code and the tail
of stderr. The process is killed on `cancel` and when the session ends, and a
pending one is started again when the session is reopened. Its stdout is the
evidence in the reminder.

Its `whenLang` counterpart is `waitLang` (`sh` default, or `node`).

**Pause.** `pause` stops a wake-up firing without dropping it; `resume` arms it
again — `wake_up({ action: "pause", id: "w1" })`, later `wake_up({ action:
"resume", id: "w1" })`. The entry is kept, so the list still shows it (marked
`paused`), and a reopened session restores it paused. A paused `wait` has its
command stopped, and resume starts it again. What resume does depends on the
wake-up:

- `every`: the next slot is one full interval from the moment you resume. Slots
  that passed while it was paused are not fired — catching up would fire the
  wake-up several times back to back.
- a one-shot whose time passed while it was paused: it fires as soon as you
  resume, because the instruction it carries was left for exactly that moment —
  waiting for a new time would delay a turn that is already overdue. Its reminder
  says it is late because it was paused, not because pi was closed.
- a one-shot still in the future: it keeps its original time.

**Prompt.** `prompt` is what the waking turn is told to do. Write the next
action, not a restatement of the task — the waking turn still has the whole
conversation, so "check whether CI finished" is enough and "keep working on the thing" is not.

The result of `schedule` names the resolved absolute time and the delay, so you
can confirm the time was read the way you meant.

## What the waking turn receives
```text
⏰ Scheduled wake-up · 2026-11-12 09:30:00 (Asia/Shanghai)

This is a scheduled wake-up, not the user speaking. The time has come; carry on with the work.
The instruction you left for yourself: check whether CI finished
```

A `wait` wake-up says the command finished rather than naming a time:

````text
⏰ Wait command finished · 2026-11-12 09:30:00 (Asia/Shanghai)

This is a conditional wake-up, not the user speaking. The command you were waiting on exited with status 0.
The instruction you left for yourself: the PR moved — read the output above
Condition output at wake time:
```
ci-failed  A required check has failed
```
````

The message is injected as an extension message, marked as an automatic wake-up
so the model does not mistake it for the user speaking. It starts a new turn when
pi is idle; if a turn is still running at that moment, it is queued as a
follow-up instead of interrupting. The stamp is rendered in the local zone and
locale, so the separators vary by machine.

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
  A paused wake-up is restored as paused rather than armed.
- **Repeating wake-ups keep the cadence and skip missed slots.** With `every` the
  wake-up re-arms itself after each firing. If pi was closed across several
  slots, it fires once and continues from the next slot instead of catching up.
  Only `cancel` stops it — or `pause`, which holds it until `resume` re-arms it.
- **Subagents get no `wake_up`.** A background child runs with
  `PI_SUBAGENT_CHILD=1` and loads ambient extensions, so a global install reaches
  it too; there the extension registers no tool and no `/wake` command, because a
  wake scheduled inside a child would start a turn in a run that is already
  ending.
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

## Releasing

```bash
# bump "version" in packages/pi-plugin/package.json, then
git commit -am "chore(release): v0.2.0"
git tag v0.2.0 && git push --tags
```

The tag is the release: `.github/workflows/publish.yml` runs the type check and
the tests, refuses to publish when the tag and `package.json` disagree, publishes
to npm, and creates the GitHub release. A version that is already on the registry
is skipped, so re-running a half-finished workflow is safe.

Authentication is one of:

- **Trusted publishing** (recommended, nothing stored in this repository): on
  npmjs.com open the package, then Settings → Trusted publishing → GitHub
  Actions, with repository `yxlimo/pi-wake` and workflow `publish.yml`.
- **`NPM_TOKEN`**: a granular access token with "bypass 2FA", saved as a
  repository secret. The workflow uses the secret whenever it is set, so add it
  only if trusted publishing is unavailable.
