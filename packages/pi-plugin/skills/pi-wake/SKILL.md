---
name: pi-wake
description: Use when work has to resume on its own later or when something that finishes on its own must wake you — waiting for CI, a build, a deploy, a rate limit, a PR watcher, or a user-requested reminder. Covers the wake_up tool (action schedule / list / pause / resume / cancel), the time forms (absolute `at` in ISO 8601, relative `after` like 90m, repeating `every` like 5m), `wait` for a command that decides when it is done, how to write the `when`/`wait` command, what the waking turn receives, and the limits (pi must stay running).
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
wake_up({ action: "schedule", after: "90m", prompt: "re-run the typecheck" })
wake_up({ action: "schedule", at: "2026-11-12T09:30:00+08:00", prompt: "check whether CI finished" })
wake_up({ action: "schedule", after: "8s", prompt: "read the last 50 lines of /tmp/build.log and fix what failed" })
wake_up({ action: "schedule", every: "5m", prompt: "check the PR reviews and CI, act on anything asked" })
wake_up({ action: "schedule", wait: "gh watch pr 42 --exit", prompt: "the PR moved: read the output" })
```

Give `at`, `after`, or `every` — at most one of `at` and `after`:

| form | value | notes |
| --- | --- | --- |
| `at` | `2026-11-12T09:30:00+08:00` | ISO 8601. An offset wins; without one, local time. A bare date means local midnight. |
| `after` | `90m`, `2h`, `1h30m`, `45s`, `3d` | units required (`ms`, `s`, `m`, `h`, `d`) |
| `every` | `5m`, `1h` | repeats at that interval until cancelled. Minimum `1s`. Cannot be combined with `at`; with `after`, `after` is only the first delay, and alone it starts one interval out. |

Translate what the user said into one of these forms instead of computing
clock arithmetic: "tomorrow at nine" becomes `at`, "in a bit" becomes `after`,
"every five minutes" becomes `every`. The result reports the resolved absolute time, the
remaining delay, and the interval when it repeats, so check those before telling
the user anything.

A time in the past is refused rather than fired immediately — if the user means
"now", just continue working.

## Only wake up when there is something to report

A repeating wake-up that finds nothing to say should stay silent, not spend a
turn on "no change". `when` gates the wake-up on a command:

```text
wake_up({
  action: "schedule",
  every: "5m",
  when: "gh pr view 42 --repo owner/repo --json state,updatedAt",
  whenChanged: true,
  prompt: "the PR moved: read the reviews and make the changes they ask for",
})
```

| field | meaning |
| --- | --- |
| `when` | Command run when the time comes. Exit 0 = wake, non-zero = stay silent. |
| `whenLang` | `sh` (default, POSIX through `/bin/sh`) or `node` (`node -e`). |
| `whenChanged` | Also require the command's stdout to differ from the run that last fired. This is what keeps an unchanged world quiet. |
| `whenTimeout` | Seconds the command may take. Default 30, maximum 300. |

The command gets `$PI_WAKE_ID` and `$PI_WAKE_LAST_STDOUT` (the output from the
run that last fired, empty the first time), so it can do its own comparison
instead of relying on `whenChanged`.

When the wake-up does fire, the condition's stdout travels into the reminder as
evidence, so the waking turn sees what changed without re-running the query.

A skipped slot is silent: a repeating wake-up just re-arms. A **one-shot** gated
wake-up has nothing left to wait for, so it is dropped and the user is told once.
A condition that cannot run at all (timeout, missing interpreter) is reported
once, because otherwise the wake-up would be silent forever.

The command runs unsandboxed in the session's working directory, with the same
power as the `bash` tool — a reminder is not a security boundary.

## Waiting for a command instead of a time

When the thing you are waiting for decides when it is done, do not guess an
interval. `wait` starts the command now and fires the wake-up the moment it
exits 0:

```text
wake_up({
  action: "schedule",
  wait: "gh watch pr 42 --repo owner/repo --interval 20s --exit-on ci-failed,ci-passed,review-submitted,comment-added --exit",
  prompt: "the PR moved: read the output above, make the changes it calls for,
  and reply where needed",
})
```

| field | meaning |
| --- | --- |
| `wait` | Command started now. Exit 0 = wake. Its stdout becomes the evidence. |
| `waitLang` | `sh` (default, POSIX through `/bin/sh`) or `node`. |

`wait` replaces the clock, so it cannot be combined with `at`, `after`, `every`
or `when`: there is no slot to evaluate at and nothing to repeat. Put every
judgement inside the command and express it through the exit status.

- **No timeout.** The command runs for as long as it takes; that is the point.
- **Non-zero exit wakes nothing.** The wake-up is dropped and the user is told
  once with the exit code and the tail of stderr, because a watcher that failed
  will not fix itself by being ignored.
- **Killed on `cancel`, on `pause` and when the session ends**, so a watcher
  cannot outlive the session that asked for it. `resume` starts it again.
- **One shot.** After it fires, schedule again if you need to keep watching.
- **Restarted on reopen.** A pending `wait` is persisted like any other wake-up,
  so reopening the session starts the command again.

Use `wait` for things that report their own completion: `gh watch`, a long
build, `until`-style polling with an exit code. Use `after`/`every` when the only
thing you know is how much time should pass.

## Writing the `when` / `wait` command

The exit status is the entire signal, and stdout is the entire message. Both
facts drive every rule below.

**Exit status.** `0` wakes, anything else stays silent. Do not try to express
"do not wake" in the output — output is only read after the decision is made.
A pipeline reports its last command's status, and some tools have surprising
codes (`gh pr checks` exits 8 while checks are pending), so handle those
explicitly instead of assuming 0/1.

**stdout is the evidence.** On wake, stdout is pasted into the reminder (trimmed,
capped at 4000 characters; for `wait` it is the *end* of stdout, since a watcher
that ran for hours says what it found last). So print a short conclusion, not a
log: no `cat` of whole JSON, no progress chatter, and never anything secret —
that text lands in the transcript and in the model's context.

**stderr is invisible.** It is not part of the evidence, and only the tail of it
is quoted in a notification when a `wait` command ends without waking. A one-shot
`when` that exits non-zero quotes the first 200 characters of its stderr in the
single "condition not met" notification, so it is not private either. If the
failure itself is what the waking turn must see, print it to stdout and `exit 0`.

**With `whenChanged`, stdout is a fingerprint.** The rule is "different from the
run that last fired", so the same world must produce byte-identical output. A
timestamp, a duration, a random value or a PID in the output defeats it
completely and wakes you every slot. Also avoid empty output: the baseline starts
as `""`, so an empty string counts as unchanged and never wakes.

**`whenTimeout` is a deadline, not a duration.** Default 30s, maximum 300s. The
command is killed when it expires, and a timeout is reported once per pi run as a
broken condition. So `when` must return quickly — never poll or sleep inside it. `wait`
is the form to use when the command legitimately runs long.

**It is `/bin/sh`, not your shell.** `whenLang: "sh"` means POSIX; zsh and fish
syntax will fail. It runs in the session's working directory, so `cd` or use
absolute paths when the script assumes a project root.

**It runs repeatedly; keep it free of side effects.** `when` is evaluated at
every slot, so it must only observe. No commits, no deletes, no messages, no
state changes — decide in `when`, act in the waking turn.

```sh
# The world as a fingerprint: stable, non-empty, no timestamp.
now=$(gh pr view 42 --repo owner/repo --json state,headRefOid \
  --jq '"$(.state) $(.headRefOid)"' 2>&1) || { printf 'gh failed: %s\n' "$now"; exit 0; }

[ -n "$now" ] || exit 1                 # nothing to report
[ "$now" = "$PI_WAKE_LAST_STDOUT" ] && exit 1   # same as the run that last fired
printf '%s\n' "$now"
```

## What to put in `prompt`

`prompt` is the instruction the waking turn gives itself. The waking turn keeps
the whole conversation, so write the *next action*, not a recap:

- good: `check whether CI finished, fix what failed` / `reply with WAKE-OK` /
  `read the last 50 lines of /tmp/build.log`
- useless: `keep working on the previous thing` / `keep going`

Include the concrete artifact (a URL, a path, a command) when the waking turn
would otherwise have to rediscover it.

## What the waking turn gets

```text
⏰ Scheduled wake-up · 2026-11-12 09:30:00 (Asia/Shanghai)

This is a scheduled wake-up, not the user speaking. The time has come; carry on with the work.
The instruction you left for yourself: check whether CI finished
```

A `wait` wake-up reads differently, because nothing was scheduled:

````text
⏰ Wait command finished · 2026-11-12 09:30:00 (Asia/Shanghai)

This is a conditional wake-up, not the user speaking. The command you were waiting on exited with status 0.
The instruction you left for yourself: the PR moved — read the output above
Condition output at wake time:
```
ci-failed  A required check has failed
```
````

It arrives as an extension message, not a user message, and is queued as a
follow-up: if a turn is still running it waits for that turn to finish rather
than interrupting it. When the session is idle it starts a new run.

The time is rendered in the local zone and locale, so the separators vary by
machine.

## Seeing, pausing and cancelling

```text
wake_up({ action: "list" })                   // pending, nearest first, plus the last 5 firings
wake_up({ action: "pause", id: "w1" })
wake_up({ action: "resume", id: "w1" })
wake_up({ action: "cancel", id: "w1" })
wake_up({ action: "cancel", all: true })
```

`list` keeps the last five firings next to the pending wake-ups: each row has the
id, the time it fired, whether it was late, and a one-line summary of the output
that woke it. It is the way to confirm that a wake-up did what it promised.
Humans can list the same thing with the `/wake` command.

## Limits

- **pi must be running.** The timer lives in the pi process; closing pi drops
  pending wake-ups. In `-p`/print mode pi exits when the turn ends, so a wake-up
  there never fires.
- **Reopening a session restores pending wake-ups**, because the schedule is in
  the session file. One that came due while pi was closed fires on reopen, and
  the message says how late it is.
- **A paused wake-up survives the reload too.** `pause` stops it firing without
  dropping it, so the session file keeps the entry and it comes back paused;
  `resume` arms it again. What resume does depends on the wake-up: a paused
  `every` waits one full interval from the resume moment (missed slots are not
  fired back to back), an overdue one-shot fires on resume because its
  instruction was left for exactly that turn (and says it is late because it was
  paused), and a one-shot still in the future keeps its time.
- **Repeating wake-ups keep a fixed cadence and skip missed slots.** `every`
  re-arms itself after each firing; if pi was closed across several slots, the
  wake-up does not fire them back to back, it continues from the next slot. It
  stays pending until `cancel`, so cancelling is the only way to stop it — or
  `pause`, which holds it without dropping the entry until `resume` re-arms it.
- **`wait` is not a background service.** It is one child process of the pi
  process: no deadline, but also no survival. Closing pi kills it, and reopening
  the session starts it again.
- **Only the main session has this tool.** Background subagents load the
  extension with `PI_SUBAGENT_CHILD=1` and get no `wake_up`.
- **A wake-up is not a background job.** It only fires while pi is running at
  that time.
