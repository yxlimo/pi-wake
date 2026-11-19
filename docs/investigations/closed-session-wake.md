# Closed-session wake delivery — measurements

Investigation, not a feature. Question: how can a pi-wake wake-up be delivered when the
owning pi session is not running? Every claim below cites a command that was run and its
(trimmed) output, inside this repository's sandbox. First run 2026-11-19 branch `main`;
this second run (same day, 07:00–08:10 CST) on branch `docs/closed-session-wake`, with the
three grants the first run lacked (`network: true`, `herdr --session` / `herdr agent start`
/ `herdr pane`, inner store binary `re:^/nix/store/…/bin/pi`). Everything created for the
probes lives under `.probe/` (git-ignored); no real session file was written to and no live
pi or herdr process was touched. The systemd half of Q6 was measured by the parent session
and lives in `docs/investigations/q6-systemd-parent-measured.md` — cited, not re-derived.

## Traps that bite whoever implements this

- **The `pi` on PATH is a nix wrapper that provisions state on every run.**
  `/home/shay/.nix-profile/bin/pi` → `/nix/store/5xg7nbqb…-pi/bin/pi` merges a
  machine-provisioned settings patch (`{"npmCommand":["…/pnpm"],"packages":[20 packages]}`)
  into `$PI_CODING_AGENT_DIR/settings.json` on *every* invocation, so a scratch agent dir
  silently grows the full user package list and the first offline scratch run spends ~140 s
  failing to npm-install it. Scratch runs must call the inner store binary
  `/nix/store/x7xgahfvf8lf063cs20ybyby6cirxzim-pi-npm-1.5.2/bin/pi` directly with `HOME` and
  `PI_CODING_AGENT_DIR` pointed at a scratch tree. A scratch `pi` shim at `.probe/bin/pi`
  (export scratch `HOME`/`PI_CODING_AGENT_DIR`, `exec` the inner binary) makes herdr's
  `--kind pi` resolve to the scratch agent via the server's inherited `PATH`.

- **The herdr integration reports state in TUI mode only.**
  `/home/shay/.pi/agent/extensions/herdr-agent-state.ts` (installed by herdr,
  `HERDR_INTEGRATION_VERSION=9`): `session_start` returns early unless `ctx?.mode === "tui"`,
  and all state reports are gated on `rootSession`, so a headless `pi --print` run never
  reports `pane.report_agent_session`, never appears in `herdr agent list`, and subagent
  sessions never report either. It finds the socket purely via `process.env.HERDR_SOCKET_PATH`
  plus `HERDR_ENV === "1"` + `HERDR_PANE_ID` — all injected by the pane.

- **herdr socket isolation comes from `XDG_CONFIG_HOME`, not `XDG_STATE_HOME`.** Measured:

  ```text
  $ herdr --session probe agent list
  {"error":{"code":"server_not_running","message":"no herdr server is running at
    /home/shay/.config/herdr/sessions/probe/herdr.sock; run `herdr session attach probe` …"}}
  $ XDG_STATE_HOME=$PWD/.probe/herdr herdr --session probe agent list   # same message, same path
  $ XDG_CONFIG_HOME=$PWD/.probe/config herdr --session probe agent list
  … no herdr server is running at $PWD/.probe/config/herdr/sessions/probe/herdr.sock …
  ```

  `--session <name>` addresses a *separate server per name* (socket
  `$XDG_CONFIG_HOME/herdr/sessions/<name>/herdr.sock`) — that is the sanctioned isolation
  path (SKILL.md: "Use named test sessions for experiments that need an isolated server").
  `XDG_STATE_HOME` alone moves nothing: the first run's env-var-only "isolation" silently
  talked to the real server because the socket lives under the config dir. Bare
  `herdr --session probe` needs a TTY (`cannot attach without a usable terminal`), and
  `herdr session attach probe` inside a herdr pane is refused by the nested-herdr guard
  (`nested herdr is disabled by default`). What works headless:
  `XDG_CONFIG_HOME=$PWD/.probe/config herdr server` — a fully isolated headless server whose
  API socket is `$XDG_CONFIG_HOME/herdr/herdr.sock`, stoppable with `herdr server stop`
  against the same env (stopped it, socket removed — see Q3).

- **The sandbox denies PTY allocation via `/dev/ptmx` but allows `/dev/pts/ptmx`.**

  ```text
  open("/dev/ptmx")     → EACCES (node; mode 20666, uid 0 — a sandbox rule, not DAC)
  open("/dev/pts/ptmx") → OK
  $ herdr --session probe  (after server start) → workspace create:
  {"error":{"code":"workspace_create_failed","message":"failed to openpty: Os { code: 13,
    kind: PermissionDenied, message: \"Permission denied\" }"}}
  ```

  Consequence: **no herdr pane can be created inside this sandbox at all**, so the herdr
  pane layer (`agent start` into a pane, `agent prompt` into that pane) cannot be exercised
  end-to-end here — that refusal is a sandbox property, not evidence about herdr (the real
  server outside runs 5 agents in panes). A bind-mount/symlink attempt to expose
  `/dev/pts/ptmx` as `/dev/ptmx` failed (`mount: mount point is not a directory`, `unlink:
  EACCES`). The minimal grant a future in-sandbox probe needs is whatever rule blocks
  `/dev/ptmx` opens; with it, `herdr agent start --kind pi` + `herdr agent prompt` become
  testable exactly as scripted in `.probe/q2run.mjs`.

- **Background processes do not survive a bash call.** The first detached herdr server
  (spawned `detached`+`unref` from a node script) was gone when the next bash call ran, and
  `herdr agent list` returned `server_not_running`. Every server experiment therefore runs
  as one node script that starts the server, runs all steps, and stops the server at the end.
  (Also observed: an orphan from an earlier run leaves a *stale socket file* that makes a
  naive "socket exists → skip spawn" check hang; probe scripts must connect-test and remove
  stale sockets before spawning.)

- **`herdr agent prompt --timeout` requires `--wait`** (CLI syntax, measured:
  `--timeout requires --wait`, exit 2).

---

## Q1 — Concurrent write on one session file

**Question.** Does `pi --session <file> --print "…"` against a session file another pi
has open corrupt it, collide on a lock, or interleave safely?

### 1a. Mechanical baseline: two concurrent JSONL appenders

`node .probe/q1a.mjs` — two writers, one file opened `O_APPEND`, 200 single-line
`write()` calls each, one line per write (same shape as `pi.appendEntry`):

```text
writer-A done: 200 lines
writer-B done: 200 lines
{"totalLines":400,"expected":400,"badLines":0,"perWriter":{"A":200,"B":200},"trailingEmpty":1}
VERDICT q1a: no interleaving, no truncation, no lost writes
```

### 1c. Two pi processes, NEW session file, started concurrently

`node .probe/q1c.mjs` — two `pi --print` spawned at the same instant on a path that does
not exist yet:

```text
{"tag":"first","code":1,"ms":14581,"err":"Connection error.: connect ENETUNREACH …"}
{"tag":"second","code":1,"ms":568,"err":"EEXIST: file already exists, open
  '/home/shay/extensions/pi-wake/.probe/state/q1c.jsonl'\n"}
{"totalLines":12,…,"badLines":[]}
VERDICT q1c: every line is valid JSON, no truncation
```

**The second process refuses to start**: pi creates a new session file with
exclusive-create semantics and the loser exits 1 in 568 ms with `EEXIST`. Loud collision,
no corruption, no silent interleave.

### 1d. Two pi processes, EXISTING session file, started concurrently (the wake scenario)

`node .probe/q1d.mjs` — seed an existing two-entry session, then two `pi --session
<file> --print` at the same instant:

```text
{"tag":"first","code":1,"ms":14588,"err":"Connection error. …"}
{"tag":"second","code":1,"ms":14614,"err":"Connection error. …"}
{"totalLines":22,…,"userTexts":["Seed turn.","Reply with exactly: OK-from-first",
 "Reply with exactly: OK-from-second"],"badLines":[]}
VERDICT q1d: every line valid JSON, no truncation
```

**Both processes ran, both appended, the file stayed valid JSON.** No lock was taken, no
error about the other process, entries from both writers are interleaved and every line
parses.

**Conclusion.** Concurrent access does **not** corrupt the file and does **not** collide
on a lock (existing file); on a new file it collides loudly (`EEXIST`). The real hazard
is not byte-level: it is **duplicate wake firing** — see Q4, where a dispatch process
arms and fires the overdue wakes it finds in the same file while the owner process arms
its own copies. Session-file integrity is safe; wake semantics are not.

## Q2 — herdr prompt delivery (working / idle)

**Question.** Does `herdr agent prompt` queue behind an in-flight turn or interrupt it?

**Measured: it queues; it does not interrupt** — at the layer that decides the outcome.

- **herdr leg (blocked, exact refusal).** The isolated headless server runs fine
  (`XDG_CONFIG_HOME=$PWD/.probe/config herdr server` → api socket
  `.probe/config/herdr/herdr.sock`, `herdr agent list` → `{"agents":[…]}`), but
  `herdr workspace create` fails at `failed to openpty: PermissionDenied` (sandbox PTY
  wall above). No pane → `agent start` → `agent_pane_not_found` → no agent to prompt. The
  herdr pane path itself needs the `/dev/ptmx` grant to measure in-sandbox.
- **pi leg (measured — this is where the verdict is decided).** `herdr agent prompt`
  works by writing text + Enter into the pane's PTY ("sends text followed by encoded
  Enter as one ordered submission", SKILL.md). What pi's TUI then does with a mid-turn
  submission is the queueing question, so it was measured directly: the inner store pi ran
  in TUI mode on a real PTY (allocated via `/dev/pts/ptmx` with a 15-line C relay,
  `.probe/ptyrelay.c`, compiled with clang — the same byte-level delivery a herdr pane
  performs), driving session `.probe/state/q2.jsonl`. The agent model (coder-c, LAN proxy)
  streamed 3000 numbers per turn to keep turns genuinely slow.

  ```text
  sent turnA prompt           00:01:50.890Z
  turnA user entry            00:01:51.892Z
  turnA in flight at 00:02:06 → assistant reply NOT yet present   (asserted before injection)
  sent mid-turn plain submission "Reply with exactly: MIDTURN-PLAIN-Q2"  00:02:06.893Z
  turnA assistant reply completed   00:03:43.529Z   ← full 3000-number answer, 1m53s in-flight
  user  "Reply with exactly: MIDTURN-PLAIN-Q2"   00:03:43.530Z  ← queued, appended at turn end
  assistant "MIDTURN-PLAIN-Q2"                   00:03:45.967Z  ← processed as its own turn

  sent turnB prompt 00:03:57; in flight at 00:04:13 (asserted)
  sent mid-turn bracketed-paste submission "\e[200~Reply with exactly: MIDTURN-PASTE-Q2\e[201~\r"
  turnB assistant reply completed   00:05:58.200Z   ← 2m01s in-flight, not interrupted
  user  "Reply with exactly: MIDTURN-PASTE-Q2"   00:05:58.201Z
  assistant "MIDTURN-PASTE-Q2"                   00:06:01.933Z
  ```

  (An idle submission and a bracketed-paste idle submission were also sent between turns;
  both became normal user entries and normal turns. pi's TUI enables bracketed paste —
  `\e[?2004h` in the terminal output — which is exactly the "live bracketed-paste mode"
  herdr's prompt honors; the wrapped encoding behaved identically to plain Enter.)

- **Observations that decide the question.**
  1. The in-flight turn was **not** interrupted: the full long answer arrived *after* the
     mid-turn submission in both turns, and there is no abort/cancel entry in the session
     file.
  2. The submitted message was **not delivered early**: its user entry appears in the
     session file at turn end (`.529Z → .530Z` in turn A), timestamped when pi drained it,
     not when it was typed. *Held by the TUI* was the first reading; PTY line-discipline
     buffering before pi ever read the bytes fits the same timestamps, and this run cannot
     tell them apart.
  3. The queued message then ran **as its own turn** — the human-visible behaviour of a
     wake prompt sent mid-turn is "the agent finishes what it is doing, then handles the
     wake".

**What this does not establish.** Exactly one mid-turn submission was in flight per turn,
so "queued" is distinguished from "lost" for N=1 only; whether two submissions arriving
mid-turn are both queued or coalesced into one turn was not measured, and that is the
shape a storm of overdue wakes would arrive in.

**Conclusion.** A wake delivered into a working pi TUI pane queues behind the in-flight
turn and is processed afterwards, in both the plain-Enter and the bracketed-paste encoding
herdr uses. Idle delivery starts a turn immediately. pi-wake's README claim is correct at
the mechanism level. What remains unmeasured is only herdr's own pane plumbing
(`agent start` → detection → `agent prompt`), which the sandbox PTY wall prevents — the
scripted end-to-end version is ready in `.probe/q2run.mjs` for a run with the `/dev/ptmx`
grant.

## Q3 — herdr absent: three shapes

**Question.** How should each shape be detected and dispatched?

### Shape 1: herdr server stopped — **measured this run**

```text
$ herdr server stop   (against the probe server's env)
exit=0
socket file after stop: removed                      # not a stale file — gone
raw connect to probe socket after stop: (no socket file)
$ herdr agent list
{"id":"cli:agent:list","error":{"code":"server_not_running","message":"no herdr server is
  running at …/herdr.sock; run `herdr` to start or attach it"}}   # exit 1
```

**Detection signal: a `connect()` to `$HERDR_SOCKET_PATH` (or the default
`$XDG_CONFIG_HOME/herdr/herdr.sock`) fails** — not socket-file existence (a killed server
leaves the file behind; a stopped one removes it; existence is not a liveness signal).
This matches what herdr's own integration client does (`socket.on("error", () =>
finish(false))`, two attempts at 500 ms / 1500 ms). **Dispatch: none possible** —
everything herdr offers goes through that socket; fallback is catch-up on next session
start (pi-wake's existing behavior, and pi-wake itself annotates it: measured in Q4 —
"(Fired 1m3s late — pi was not running.)").

### Shape 2: pane alive, agent exited — still not measured live

Blocked by the same sandbox PTY wall (no pane can exist, so none can be killed while the
pane lives); refusal quoted under Traps. Documented signal (SKILL.md, read not run): an
agent's *name* "is cleared when that agent exits, is released, or is replaced", so the
reliable check is: pane present in `herdr pane list`, but no `agent list` entry for that
`pane_id`. Dispatch would be `herdr agent start --kind pi` on the session file in that
pane — but see Q7: an unattended restart executes tools; this leg needs an explicit
decision, not just a mechanism.

### Shape 3: the owner is a subagent (`PI_SUBAGENT_CHILD=1`) — source-measured, unchanged

pi-wake refuses to register in a subagent (`packages/pi-plugin/src/index.ts:804`); the
herdr integration never reports for children (`rootSession` gate) or for headless modes
(`mode !== "tui"` gate). A dispatcher will never be handed a subagent session through
`herdr agent list`; the weak `run-N/` filesystem hint exists but is not needed.

## Q4 — No session process at all: headless resume

**Question.** Does `pi --session <file> --print "<facts>"` resume with full prior
context, exit on its own, load pi-wake, and re-arm the wakes it finds?

Setup (first run): scratch home `.probe/home`, pi-wake in
`.probe/home/.pi/agent/extensions/pi-wake`, session seeded by `node .probe/q4seed.mjs`
with two overdue one-shots (w1 −60 s, w2 −30 s) and one future (w3 +1 h), then inner-store
`pi --print`. This run adds the model-reachable measurements the first run could not do.

**Carried over from the first run (unchanged):**

- It loads pi-wake in `--print` mode and re-arms + fires overdue wakes immediately,
  mid-turn (both overdue wakes got `firedAt` ~11 s into the run, during retry backoff).
- With the model unreachable it does not exit on its own (retry backoff); environment-
  dependent, not a clean yes.

**Measured this run (`node .probe/q4bseed.mjs` + `q4brun.mjs`; seed: marker message + 3
overdue wakes w1/w2/w3; run: `--print "Reply with exactly the marker …"`; coder-c
reachable; whole run 20.2 s, exit 0):**

```text
user  "Reply with exactly the marker …"                 00:07:10.235Z
custom wake_up w1 … "firedAt":1795046830284             00:07:10.284Z   ← all 3 fired at restore,
custom wake_up w2 … "firedAt":1795046830287             00:07:10.287Z     within 4 ms of each other
custom wake_up w3 … "firedAt":1795046830288             00:07:10.288Z
assistant "There is no marker starting with Q4MAGIC …"  00:07:15.105Z   ← turn 1 (the --print prompt)
custom_message "⏰ Scheduled wake-up · … (Fired 1m3s late — pi was not running.)
  The instruction you left for yourself: Wake one: say WAKEONE-ACK."   00:07:15.106Z
assistant "WAKEONE-ACK"                                 00:07:20.738Z   ← turn 2
custom_message "… Wake two: say WAKETWO-ACK."           00:07:20.739Z
assistant "WAKETWO-ACK"                                 00:07:25.283Z   ← turn 3
custom_message "… Wake three: say WAKETHREE-ACK."       00:07:25.285Z
assistant "WAKETHREE-ACK"                               00:07:29.925Z   ← turn 4
assistantEntries(non-system total): 4
```

- **3. The wake reminder goes into the transcript, not just into the model's context.**
  Each fired wake persists a `custom_message` entry (`{"type":"custom_message",
  "customType":"wake_up","content":"⏰ Scheduled wake-up · …\n(Fired 48s late — pi was not
  running.)\nThe instruction you left for yourself: …","display":true}`) with full
  display text, and the model answers each in its own follow-up turn. The first run's
  `wakeMessageCount: 0` was a counter in its own probe script that was never given a
  definition — it measured nothing, and both runs' later explanations of it were wrong:
  the review found two `custom_message` entries appended during run 1's retry window
  (`q4.jsonl` at 23:28:10 / 23:28:24), so reminders persisted in run 1 as well.
- **4. N overdue wakes → N sequential turns, no coalescing** (measured N=3: three
  `custom_message` entries, three separate assistant replies, ~4.5 s apart). The "storm"
  size is linear in the number of overdue wakes; each turn runs the full toolset (Q7).
- **5. Resume context: pi-written history is restored; hand-seeded entries are not.**

  ```text
  run1 --print "Remember this marker for later: Q4MAGIC-REAL-42. Reply with exactly: MARKER-SAVED"
    → stdout "MARKER-SAVED" (3.2 s)
  run2 --print "Reply with exactly the marker you were told earlier …"   (fresh process, same file)
    → stdout "Q4MAGIC-REAL-42" (4.2 s)     ← context fully visible
  ```

  But the hand-seeded marker of q4b was *not* seen by the model ("There is no marker
  starting with Q4MAGIC from earlier in this session") even though the entry is in the
  file — a caution for anyone building test seeds by hand: a JSONL entry that pi did not
  write may not rehydrate into context. Headless dispatch of a *real* session sees real
  history (measured), which is what any wake dispatcher would target.

**Conclusion.** A headless `--print` dispatch of a session with overdue wakes fires all
of them, persists each reminder into the transcript with a human-readable "fired late"
annotation, and burns one full agent turn per overdue wake. It is a working catch-up
mechanism *and* the duplicate-fire hazard of Q1 in practice, and it is unsupervised (Q7).

## Q5 — State outside the session (design, anchored on measurements)

The session file is the schedule, and this run strengthens the anchor:

- pi-wake persists every state change as an append-only `custom` entry
  (`pi.appendEntry("wake_up", …)`, `src/index.ts:352`); restore takes the last entry per
  id, so a fired/cancelled wake cannot come back (`src/index.ts:752-760`).
- Concurrent appends from two processes are safe (Q1d: 22/22 valid JSON); concurrent
  creation is exclusive (Q1c: `EEXIST`).
- pi-wake writes nothing outside the session file (`rg "cache|homedir|fs\.|writeFile|mkdir"
  packages/pi-plugin/src/index.ts` matches nothing); `~/.cache/pi-wake` does not exist.
- Measured this run: the catch-up path itself needs no external outbox — a reopened
  session restores, fires, and *annotates* overdue wakes on its own ("Fired 1m3s late —
  pi was not running", Q4.3).

Minimal external state when the dispatcher is a timer spawning a headless run: a **dispatch
ledger**, not a second copy of the schedule — one JSON line per dispatch decision
`{session_path, wake_id, due_at, dispatched_at, via}` under `~/.local/state/pi-wake/`
(append `O_APPEND`, single `write()`, line-atomic per Q1a). Correctness anchor stays the
session file: before dispatching, parse the latest `wake_up` entry for the id;
`firedAt`/`cancelledAt` present → skip.

**Locking: the first run's "no multi-session lock file is required" stands — with a
sharpened boundary.** No lock is needed for *file integrity* (Q1d: interleaved appends
stay valid; no lock is taken and none is needed). What no lock can fix is *semantic
duplication*: two dispatchers (or a dispatcher racing the owner) both see the same
overdue wake and both act — that is resolved by the `firedAt` anchor plus the advisory
ledger, i.e. by protocol, not by locking. A systemd user unit also never overlaps itself
(parent-measured Q6 doc), so within one dispatcher no lock is ever contended.

## Q6 — systemd side

Measured by the parent session on this machine; see
`docs/investigations/q6-systemd-parent-measured.md`. Facts cited from it (do not
re-derive): `Linger=yes` → the user manager and its timers survive logout; a past
one-shot `OnCalendar` produces no catch-up at all; a recurring `OnCalendar=*:0/5` with
`Persistent=true` fires exactly **one** catch-up run after a missed window (measured by
backdating the stamp file `~/.local/share/systemd/timers/stamp-<unit>.timer`) and does
not replay every missed slot — so the delivered set must be computed from the session
files' due times, not from the timer's slot. Consequence for pi-wake: a catch-up run
delivers whatever is overdue at that moment; the `firedAt` anchor (Q5) keeps it
idempotent. This run created no unit and touched no systemd state.

## Q7 — Safety of unattended execution

**Question.** Should a wake be limited to "deliver facts, do not act", or must it
declare what it may do?

Measured about headless runs (Q4): a `--print` resume runs a full agent turn with all
tools enabled, executes pi-wake's restore + fire path with no human in the loop, fires
*every* overdue wake (this run: 3 wakes → 3 extra full turns, Q4.4), and when the model
endpoint is unreachable it silently retries without exiting or notifying. A wake `prompt`
is written to be acted on (README: "check whether CI finished"; skill: "put the next
concrete action in `prompt`"). Combine: an unattended headless dispatch is an agent
executing imperative instructions with full tools and no supervision, several turns in
sequence, and it can stall invisibly.

**Conclusion: this is the user's call, not the implementation's.** An unattended headless
dispatch is an agent executing imperative prompts with the full toolset and no supervision;
the owner of the machine has accepted that risk, so the design must not silently refuse it.
What it owes instead is the facts and a way out:

- the risk is documented where the timer or daemon is configured, in those words;
- the spawned run's tool surface is adjustable (`--tools read,grep,find,ls` / `--no-tools`,
  from `pi --help`) so a user who does *not* accept the risk can narrow it without forking;
- a stalled run is visible (it can neither be silent nor retried forever), because the
  measured failure mode is a run that keeps retrying without exiting or telling anyone.

---

## Recommendation

**A: out-of-process delivery, herdr-*compatible* and not herdr-dependent. A timer (or a
supervised daemon) delivers a due wake by spawning `pi --session <ownerFile> --print
<facts>`; the session keeps its in-session timer for the case where the process is alive.
Both surfaces exist, and neither is a fallback for the other.**

Two things the earlier drafts of this section got wrong, both corrected here:

**1. herdr is a compatibility constraint, not a delivery channel.** The requirement was
never "use herdr to deliver"; it was "do not break on a machine that runs pi under herdr".
That reduces to three obligations, all measured: never corrupt the session file a herdr pane
has open (Q1 — appends interleave safely, and opening a *missing* file is an exclusive
create, so the dispatcher must expect `EEXIST` rather than assume it won); never assume we
are the only writer of that file; and never require herdr's API or its socket to work. The
queueing measurement (Q2) stays useful only as a fact about what a prompt into a live TUI
does — it is not the design's delivery path, because when the pane is live the in-session
timer already fired.

**2. The "storm" is narrower than this document first claimed.** With out-of-process
delivery running, overdue wakes do not *accumulate*: each is delivered at its due time. The
only way a backlog forms is that nothing was dispatching while the process was closed — a
config edit made while closed, a timer that was off, a first run before the timer existed.
So the fix is not "never spawn headless"; it is a rule for exactly that case: **on session
start, discard overdue wakes instead of firing them**, and say so once ("2 overdue wake-ups
discarded: nothing was delivering while the session was closed"). Firing them is what turns
one spawn into N turns; discarding makes a backlog a no-op.

What that leaves to build, in this order:

1. **A passive mode for the spawned run** (the sibling package's `WAKE_ALARM_PASSIVE=1`):
   the child still registers the `wake_up` tool, so the wake turn can list, cancel or create
   wakes under its own policy — but it does not act as a scheduler: no presence claim, no
   timer arming, no firing of overdue wakes, no spawning a dispatcher of its own. Without
   this, one spawn becomes a cascade.
2. **The discard-on-start rule** above, which removes the one remaining backlog case. In a
   session that is *not* passive, an overdue wake is discarded with one notice rather than
   fired; a passive run never fires anything by construction.
3. **A delivery record outside the session** — a small outbox with a claim written under a
   transaction lock, an entry cleared only on a clean exit and retried with capped backoff
   otherwise. A wake **may** be lost — what it must not be is lost *silently*: every dispatch
   attempt, retry and terminal failure is written to a log that can be read back afterwards,
   so "why did the 3am wake never arrive" has an answer on disk. Delivery is therefore
   at-least-once in the normal path, and an explicit failure record in the bad one.
4. **A liveness signal for "is this session running?"** that needs neither herdr nor a lock
   on the session file — a per-session heartbeat record with pid + session file, which is
   also what tells the dispatcher a session it is about to spawn for has meanwhile come back.
5. **The timer itself**, with the measured caveats: `Linger=yes` is a host prerequisite for a
   `--user` timer (not a design property); `Persistent=true` catches up exactly once, so the
   overdue set must be computed from the state file's due times rather than from the slot the
   timer believes it is on; and a past one-shot calendar produces no run at all.
6. **`deliverAs` becomes configurable**, defaulting to today's `followUp` (the wake lands
   when the current turn ends) with `steer` as the option (it lands at the next model step,
   interleaved between tool calls). `followUp` stays the default because it does not change
   the behaviour of a turn that is already producing an answer; `steer` is there for a wake
   whose value decays — a CI result the agent should see before it finishes the thought it
   is on.

The unattended-execution risk is real and documented under Q7, and it is the owner's decision
to take it; the implementation owes a configurable tool surface, not a refusal.

**Implication for the open todo (persistent outbox, multi-session locking):** with A the
outbox is **required**, and the locking question resolves to "not a lock on the session
file":

- *The outbox comes back.* The moment delivery happens outside the owning process, the
  dispatcher must record what it delivered, or every tick re-delivers the same due wake. A
  claim token under a transaction lock is what keeps two potential dispatchers (a timer and
  a live session that just woke up) from double-delivering. The guarantee is not
  exactly-once but *never silent*: a lost wake must leave a failure record behind, which is
  also why an entry is cleared only on a clean exit and retried on anything else.
- *No lock on the session file itself.* Q1 measured both shapes — opening a missing file is
  an exclusive create (the second writer gets `EEXIST`), and two processes appending to an
  existing file interleave with all 22 lines remaining valid JSON. Integrity does not need
  one, and a lock there would sit in the way of herdr's own pane, which is the compatibility
  constraint from earlier.
- *The multi-session question becomes a presence question.* What actually has to be known is
  "is the session a wake belongs to currently running?" — answered by a heartbeat record per
  session, not by a lock and not by herdr.

## Cleanup statement

All probe processes were stopped inside the scripts that started them: the probe herdr
server via `herdr server stop` (socket file removed, raw connect refused, `herdr agent
list` → `server_not_running`), the PTY nested pi via SIGKILL (relay exited on EIO). The
bash-call sandbox itself killed one earlier detached server (recorded as a trap above);
final sweep: no process matching herdr/pi/ptyrelay except this session's own helper, both
probe socket paths absent. No systemd unit was created, nothing was committed. `.probe/`
probe socket paths absent. No systemd unit was created, nothing was committed.

`.probe/` is git-ignored and kept only for the scripts a follow-up run would need
(`q1*.mjs`, `q2pty.mjs`, `q2run.mjs`, `ptyrelay.c`) plus the session files they produced.
Its 193 MB scratch home — including the one secret-bearing `auth.json` copy and the whole
provisioned package tree — was deleted after the measurements were quoted, as was the
1.4 MB PTY log; 628 KB remains and carries no credentials.


## Not measured — summary

| Question | Status | Exact blocker |
| --- | --- | --- |
| Q2 herdr pane plumbing end-to-end (`agent start` → detection → `agent prompt` in a real pane) | not measured | sandbox denies PTY allocation: `failed to openpty: PermissionDenied` / `open /dev/ptmx → EACCES`; needs the `/dev/ptmx` grant; scripted in `.probe/q2run.mjs` |
| Q2 queue vs coalesce (two submissions arriving mid-turn) | not measured | one mid-turn submission per turn was injected; N=1 distinguishes queued from lost only |
| Q3 shape 2 (pane alive, agent dead) observed live | not measured | same PTY wall — no pane can exist in-sandbox; detection signal documented (SKILL.md), not observed |
| Q3 shape 3 as a live observation | not needed | source-measured: subagents never report (`PI_SUBAGENT_CHILD`, `rootSession`/TUI gates) |
| Q6 timer survival, `Persistent=true` after suspend, probe unit in `list-timers` | parent-measured | cited from `docs/investigations/q6-systemd-parent-measured.md`; this run created no unit |
| N-turn storm with N > 3, and wake turns' tool-use behaviour | not measured | N=3 measured (Q4.4); larger N is extrapolation of the same measured per-wake turn mechanism |
