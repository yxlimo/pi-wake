# Closed-session wake delivery — measurements

Investigation, not a feature. Question: how can a pi-wake wake-up be delivered when the
owning pi session is not running? Every claim below cites a command that was run and its
(trimmed) output, run inside this repository's sandbox on 2026-11-19, branch `main`
(working tree, nothing committed). Everything created for the probes lives under
`.probe/` (git-ignored); no real session file was written to, and no live pi or herdr
process was touched — `herdr agent list` against the real server is read-only and was
used only to confirm the output shape the parent had already verified.

Two traps discovered on the way, both of which will bite whoever implements this:

- **The `pi` on PATH is a nix wrapper that provisions state on every run.**
  `/home/shay/.nix-profile/bin/pi` → `/nix/store/5xg7nbqb…-pi/bin/pi` is a shell script
  that, on *every* invocation, merges a machine-provisioned settings patch into
  `$PI_CODING_AGENT_DIR/settings.json`:

  ```text
  merge_settings_json() {
    file="$PI_CODING_AGENT_DIR/settings.json"
    patch=/nix/store/2z8sn394lp3y04hk8rs73kcrxmpy7nd3-pi-settings.json
    tmp="$(mktemp "$PI_CODING_AGENT_DIR/.settings.json.XXXXXX")"
    jq -s '.[0] * .[1]' "$file" "$patch" > "$tmp"   # or from {} if absent
    mv "$tmp" "$file"
  }
  ```

  The patch is `{"npmCommand":["…/pnpm"],"packages":["npm:pi-web-access","npm:pi-lens",
  …19 packages…]}` — so a scratch agent dir silently grows the full user package list and
  the first scratch run then spends ~140 s failing to npm-install it (offline). A scratch
  pi must therefore call the inner store binary
  `/nix/store/x7xgahfvf8lf063cs20ybyby6cirxzim-pi-npm-1.5.2/bin/pi` directly, with
  `HOME` *and* `PI_CODING_AGENT_DIR` pointed at a scratch tree, and a minimal
  `settings.json` (`{"lastChangelogVersion":"1.5.2"}`). It also installs `mcp.json`
  (`keenable` MCP) the same way. This is why every scratch run below uses the inner
  binary plus `HOME=$PWD/.probe/home`.

- **The herdr integration reports state in TUI mode only.**
  `/home/shay/.pi/agent/extensions/herdr-agent-state.ts` (installed by herdr,
  `HERDR_INTEGRATION_VERSION=9`):

  ```ts
  pi.on("session_start", async (event, ctx) => {
    // TUI only: RPC/JSON/print modes are headless (no PTY herdr can display) …
    if (ctx?.mode !== "tui") {
      return;
    }
    rootSession = true;
    updateSessionRef(ctx);
    await reportSession(event?.reason);
  ```

  Consequence: a headless `pi --print` run — the dispatch vehicle one would naturally
  reach for — is **invisible to herdr**: it never reports `pane.report_agent_session`,
  never reports working/idle, and would never appear in `herdr agent list`. Also all
  state events (`agent_start`, `agent_settled`) are gated on `rootSession`, so subagent
  sessions never report either.

## Sandbox reality vs the task description

The task said `herdr`, `systemctl --user`, `journalctl --user`, `loginctl` and `pi` were
allowlisted. The actual profile (`investigator` in `.pi/subagent-bindings.json`) allows a
narrower set: among others `herdr agent list|api`, `pi --version|--session|--help`,
`systemctl --user list-timers|show|cat|is-active|is-enabled`, `journalctl --user`,
`loginctl show-user` (read); `herdr agent prompt|wait`, `herdr session|tab|workspace`,
`systemctl --user start|stop|enable|disable|daemon-reload` (write). Notably **not**
allowed in this run: `herdr --session <name> …` (the named-session isolation path), `herdr
agent start`, `herdr pane …`, any `kill`, and network. Each refusal below is quoted where
it blocked a question. The parent has since approved grants for
`herdr --session probe …`, `herdr agent start` and `herdr pane …`, plus `network: true`,
but a profile is read once at session start, so they do **not** reach this run; they are
recorded here so a follow-up run can finish Q2/Q3.

---

## Q1 — Concurrent write on one session file

**Question.** Does `pi --session <file> --print "…"` against a session file another pi
has open corrupt it, collide on a lock, or interleave safely?

Two scenarios were measured, both with scratch sessions under `.probe/` and a scratch
agent dir (`.probe/home`, redirected `HOME` + `PI_CODING_AGENT_DIR`, inner store binary,
`--provider buddy --model coder-c`). The network was off, so the model call failed —
that does not matter for the question: pi writes session entries (header, model change,
user message, retry/error entries) regardless, and both processes ran to completion of
their writes.

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
{"tag":"first","code":1,"sig":null,"ms":14581,"err":"Connection error.: connect ENETUNREACH …"}
{"tag":"second","code":1,"sig":null,"ms":568,"err":"EEXIST: file already exists, open
  '/home/shay/extensions/pi-wake/.probe/state/q1c.jsonl'\n"}
{"totalLines":12,"entryTypes":{"session":1,"model_change":1,"thinking_level_change":1,
 "message":6,"context_edit":3},"sessionHeaders":["01a1f0fb-…"],"badLines":[]}
VERDICT q1c: every line is valid JSON, no truncation
```

**The second process refuses to start**: pi creates a new session file with
exclusive-create semantics and the loser exits 1 in 568 ms with `EEXIST`. Loud collision,
no corruption, no silent interleave.

### 1d. Two pi processes, EXISTING session file, started concurrently (the wake scenario)

`node .probe/q1d.mjs` — seed an existing two-entry session, then two `pi --session
<file> --print` at the same instant:

```text
{"tag":"first","code":1,"ms":14588,"err":"Connection error.: connect ENETUNREACH …"}
{"tag":"second","code":1,"ms":14614,"err":"Connection error.: connect ENETUNREACH …"}
{"totalLines":22,"entryTypes":{"session":1,"message":13,"thinking_level_change":2,
 "context_edit":6},
 "userTexts":["Seed turn.","Reply with exactly: OK-from-first","Reply with exactly: OK-from-second"],
 "badLines":[]}
VERDICT q1d: every line valid JSON, no truncation
```

**Both processes ran, both appended, the file stayed valid JSON.** No lock was taken, no
error about the other process, entries from both writers are interleaved and every line
parses. This matches pi-wake's own README limit: *"One process at a time. Two pi sessions
on the same session file would each arm their own timer; nothing coordinates them."*

**Conclusion.** Concurrent access does **not** corrupt the file and does **not** collide
on a lock (existing file); on a new file it collides loudly (`EEXIST`). The real hazard
is not byte-level: it is **duplicate wake firing** — see Q4, where a dispatch process
arms and fires the overdue wakes it finds in the same file while the owner process arms
its own copies. Session-file integrity is safe; wake semantics are not.

## Q2 — herdr prompt delivery (working / idle)

**Question.** Does `herdr agent prompt` queue behind an in-flight turn or interrupt it?

**Not measured — blocked.** The isolation path the task prescribes is a named persistent
session, `herdr --session probe …`. That command shape is refused by this run's profile:

```text
$ herdr --session probe agent list
pi-subagents-extend: command not in the allowlist: "herdr --session probe agent list"
  — allowed: git status, git diff, git log, git show, cat, ls, rg, find, wc, head, tail, sed …
```

`XDG_STATE_HOME` alone does **not** isolate anything — measured:

```text
$ XDG_STATE_HOME=/home/shay/extensions/pi-wake/.probe/herdr herdr agent list
{"id":"cli:agent:list","result":{"agents":[ …the same 5 real agents as without the env var… ]}}
```

herdr finds its server via the socket (`HERDR_SOCKET_PATH=/home/shay/.config/herdr/herdr.sock`,
measured present), not via the state dir, so an env-var-only "isolation" silently talks
to the *real* server — which is exactly the thing this investigation must never prompt.
Prompting through the real server (only `herdr agent prompt` is allowlisted here) would
have touched a live session, so it was not done.

What is known from the herdr CLI itself (v0.9.5, `/nix/store/…-herdr-0.9.5/share/skills/herdr/herdr/SKILL.md`,
read, not measured): `agent prompt` "honors the pane's live bracketed-paste mode and sends
text followed by encoded Enter as one ordered submission"; it reports submission, "that
alone does not prove the agent started a turn"; with `--wait` it "waits for the first
settled idle, done, or blocked state" and "if the agent is already working, completion of
the active turn may satisfy it"; it refuses an agent sitting at an approval dialog with
`agent_blocked` before sending anything. That is *paste into the pane* semantics —
whether pi's TUI queues a submission typed mid-turn as a follow-up (as pi-wake's own
message injection does) is **documented, not measured**. The parent has approved
`herdr --session probe …`, `herdr agent start` and `herdr pane …` for a follow-up run;
that run can answer this with a scratch pi in a scratch server.

## Q3 — herdr absent: three shapes

**Question.** How should each shape be detected and dispatched?

### Shape 1: herdr server stopped

- **Detection (partially measured).** The integration's own client treats a failed socket
  connect as "not delivered" and retries once with a longer timeout
  (`herdr-agent-state.ts`: `socket.on("error", () => finish(false))`, two attempts at
  500 ms / 1500 ms). The socket file exists while the server runs
  (`ls /home/shay/.config/herdr/herdr.sock` → present). Socket *existence* is therefore
  not a liveness signal; **connect** to `$HERDR_SOCKET_PATH` is the signal herdr's own
  clients use. A dead-server connect is **not measured** (needs the probe server; refused
  as in Q2).
- **Dispatch:** none possible — everything herdr offers goes through that socket. The
  only fallback is catch-up on next session start (pi-wake's existing behavior).

### Shape 2: pane alive, agent exited

- **Detection (documented, not measured).** herdr clears an agent's name and identity
  when the agent exits ("A name … is cleared when that agent exits, is released, or is
  replaced", SKILL.md), so the reliable signal is: pane exists in `herdr pane list` but
  `herdr agent list` has no entry with that `pane_id` (no `agent_session.value`). Requires
  the probe server to observe end-to-end — **not measured**.
- **Dispatch:** a pi could be restarted on the session file in that pane (`herdr agent
  start --kind pi`), but see Q7 — an unattended restart executes tools; this leg needs an
  explicit decision, not just a mechanism.

### Shape 3: the owner is a subagent (`PI_SUBAGENT_CHILD=1`)

- **Detection + behavior (source-measured).** pi-wake refuses to register in a subagent:
  `packages/pi-plugin/src/index.ts:804` — `if (process.env.PI_SUBAGENT_CHILD === "1")
  return;` (after the `session_start` restore hook is registered, so a fresh child
  session restores nothing anyway — its session file has no wake entries). The herdr
  integration never reports for children either (`rootSession` gate, TUI gate above). So
  **a subagent neither schedules wakes nor appears in herdr**, and a dispatcher will never
  be handed a subagent session through `herdr agent list`. A weak filesystem hint exists
  (child sessions live under a `run-N/` subdirectory — observed in the real agent list's
  `agent_session.value` paths and in `PI_SESSION_FILE`), but it is not needed and was not
  tested as a detection mechanism.

## Q4 — No session process at all: headless resume

**Question.** Does `pi --session <file> --print "<facts>"` resume with full prior
context, exit on its own, load pi-wake, and re-arm the wakes it finds?

Setup: scratch home `.probe/home` (own `settings.json`, `auth.json`, `models.json`,
`trust.json` copied in; `.probe/` is git-ignored), pi-wake installed by copying
`packages/pi-plugin` into `.probe/home/.pi/agent/extensions/pi-wake`, session seeded by
`node .probe/q4seed.mjs` — one prior user message ("Remember this marker for later:
Q4-MAGIC-7391") plus three `wake_up` entries in the exact format pi-wake persists
(`{"type":"custom","customType":"wake_up","data":{id,dueAt,prompt,armedAt}}`, last-per-id
wins; format read from `src/index.ts` `record()`/restore): two overdue one-shots (w1 −60 s,
w2 −30 s) and one future (w3 +1 h). Then:

```text
$ env HOME=$PWD/.probe/home PI_CODING_AGENT_DIR=$PWD/.probe/home/.pi/agent \
    /nix/store/x7xg…/bin/pi --provider buddy --model coder-c \
    --session .probe/state/q4.jsonl --print "Reply with exactly: RESUMED-OK"
# killed by the probe at 40 s (exitedOnItsOwn: false)
{"wakeEntries":[
  {"id":"w1","dueAt":…}, {"id":"w2","dueAt":…}, {"id":"w3","dueAt":…},      // seeded
  {"id":"w1","dueAt":…,"firedAt":1795044476845},                            // fired
  {"id":"w2","dueAt":…,"firedAt":1795044476857}],                           // fired
 "wakeMessageCount":0,
 "userTexts":["Remember this marker for later: Q4-MAGIC-7391","Reply with exactly: RESUMED-OK"],
 "totalLines":33}
```

Measured conclusions:

1. **It resumes the session.** The prior user message is in the transcript and the new
   prompt was appended (33 valid JSONL lines total).
2. **It loads pi-wake in `--print` mode, and re-arms + fires overdue wakes
   immediately — mid-turn.** Both overdue wakes got `firedAt` entries ~11 s into the run,
   while the model call was still in its retry backoff. The future wake (w3) stayed
   armed. So every headless dispatch of a session with overdue wakes fires them *in the
   dispatching process* — independently of the owner's own timers. This is the
   duplicate-fire hazard of Q1 in practice, and it means a naive "systemd timer runs
   `pi --session X --print`" dispatch is not a neutral delivery vehicle: it is a second
   armed agent on the same schedule.
3. **It did not exit on its own within 40 s.** pi retries a failing model call with
   backoff (2 s → 4 s → 8 s …, observed in `.probe/state/q0.jsonl`: four failed
   `stopReason:"error"` assistant entries, then a *provider fallback* attempt), so with
   the model unreachable the headless run keeps retrying; an offline retry run that had
   no wake to fire did exit on its own (code 1, 14.5 s), so the exit-on-its-own question
   is environment-dependent, not a clean yes.
4. **The wake reminder never reached the transcript in the failed-turn case**
   (`wakeMessageCount: 0`): pi-wake delivers via `pi.sendMessage(…, {triggerTurn: true,
   deliverAs: "followUp"})`, and with the turn stuck in retries the queued message never
   became a transcript entry.

Not measured here, needing the network grant: whether a successful model turn (a) sees
the full prior context in its answer (the marker test), and (b) how many sequential
turns N overdue wakes produce in one `--print` run (the "storm" size). The firing
mechanism — one `firedAt` per overdue wake, each with `triggerTurn` — makes N turns the
expected shape (source: `fire()` in `src/index.ts`), but the turn count itself is **not
measured**.

## Q5 — State outside the session (design, anchored on measurements)

An external timer cannot read wake state out of a live pi's memory, but it does not need
to: **the session file is the schedule**. Measured facts that anchor the design:

- pi-wake persists every state change as an append-only `custom` entry in the session
  file (`pi.appendEntry("wake_up", entry)`, `src/index.ts:352`); restore scans entries and
  takes the last per id, so a fired/cancelled wake cannot come back (`src/index.ts:752-760`).
- Concurrent appends to that file from two processes are safe (Q1d: 22/22 valid JSON) and
  concurrent *creation* is exclusive (Q1c: `EEXIST`).
- pi-wake writes **nothing** outside the session file — `rg "cache|homedir|fs\.|writeFile|mkdir"
  packages/pi-plugin/src/index.ts` matches nothing — and `~/.cache/pi-wake` does not exist
  on this machine (`ls` → No such file or directory). There is no existing spec cache to
  be compatible with.

Minimal external state: a **dispatch ledger**, not a second copy of the schedule.

- **Where:** `~/.cache/pi-wake/dispatch-ledger.jsonl` is acceptable (it is rebuildable
  from the session files, so cache semantics fit); `~/.local/state/pi-wake/` is better if
  the ledger also records outcomes worth keeping across cache clears.
- **Format:** one JSON line per dispatch decision: `{session_path, wake_id, due_at,
  dispatched_at, via}`. Read concurrently is safe (append-only JSONL, Q1a/Q1d); append
  with a single `write()` under `O_APPEND` (measured atomic at line granularity).
- **Correctness anchor is the session file, not the ledger.** Before dispatching, the
  timer parses the target session's latest `wake_up` entry for the id: `firedAt` or
  `cancelledAt` present → skip (someone already handled it, in-session or in a previous
  dispatch). The ledger then only records "I dispatched this", making retries idempotent
  and making the ledger advisory rather than authoritative.
- **Atomic write:** tmp file + `rename()` in the same directory (what the nix pi wrapper
  itself does for `settings.json`, measured in its script).
- **Locking:** none needed for the timer itself — a systemd user unit never runs
  concurrently with itself, and `Persistent=true` catch-up does not overlap either. The
  cross-writer case (timer dispatch racing a session reopen) resolves through the
  `firedAt` anchor above: both writers append, both reads see the latest entry, the loser
  skips. No multi-session lock file is required.

**The concurrency hazard actually observed** (Q1 + Q4): not corruption — *double
firing*. The same overdue wake armed in two processes fires twice (each `pi` arms its own
timer; the dispatch process demonstrably fires wakes mid-turn). The ledger + `firedAt`
check is the measured-shape answer to exactly that hazard.

## Q6 — systemd side

**Measured here:**

```text
$ loginctl show-user shay        # (trimmed)
Linger=yes
```

Linger is on: the user manager (`user@1000.service`) runs from boot without an active
login session, so a `--user` timer **keeps running after logout** on this machine. That
is the load-bearing fact for any timer-based design: wake scheduling would not stop when
the user closes the terminal.

**Not measured — blocked by the sandbox, refusal quoted:**

```text
$ systemctl --user list-timers
Failed to connect to user scope bus via local transport: No such file or directory
$ XDG_RUNTIME_DIR=/run/user/1000 systemctl --user list-timers
Failed to connect to user scope bus via local transport: No data available
```

The user-bus socket is unreachable from this subagent's mount namespace (the sandbox
shadows host sockets — `resolver sockets shadowed: /run/nscd`); installing a probe unit
would additionally need to write `~/.config/systemd/user/`, outside this run's write
scope. Per the parent's decision, the user-bus grant is deliberately not given and the
parent is measuring the timer side itself (`list-timers`, `journalctl` output for a probe
unit) — **that output is parent-measured and must not be reconstructed from
documentation here**. No unit was created and no unit file written, so there is nothing
to clean up; `Persistent=true`-after-suspend behavior is likewise not measured in this
run and not inferable from what was measured.

## Q7 — Safety of unattended execution

**Question.** Should a wake be limited to "deliver facts, do not act", or must it
declare what it may do?

What was measured about headless runs (Q4): a `--print` resume runs a full agent turn
with all tools enabled (the scratch run's session header shows the complete toolset —
read/bash/edit/write/codemode — registered before any model call), it executes
pi-wake's restore + fire path with no human in the loop, it fires *every* overdue wake
in the file, and when the model endpoint is unreachable it silently retries for a long
time (no exit, no notification — the run in Q4 produced zero stdout/stderr before being
killed). A wake `prompt` is written to be acted on (README: "check whether CI finished";
the skill says "put the next concrete action in `prompt`"). Combine: an unattended
headless dispatch is an agent executing imperative instructions with full tools and no
supervision, possibly several turns in sequence, and it can stall invisibly.

**Conclusion: a closed-session wake must be limited to "deliver facts, do not act" as
the default.** Concretely: no headless full-agent resume as a dispatch vehicle. If a
future design ever dispatches headless, it must declare its tool surface explicitly at
dispatch time (pi already has the flag: `--tools read,grep,find,ls` / `--no-tools`, from
`pi --help`, measured) — never the default full toolset. The supervised alternative is
delivery into a live pane via herdr (`agent prompt`), where herdr's own `blocked`
detection and the visible pane provide the human surfaces a `--print` run has none of.

---

## Recommendation

**B — in-session only, catch up on the next session start.** Reasons, tied to the
measurements:

1. The only delivery mechanism fully measured end-to-end here — headless `pi --print`
   resume — is disqualified by its own behavior: it fires every overdue wake mid-turn
   (Q4), runs a full toolset unattended (Q7), and stalls without exiting when the model
   is unreachable (Q4.3).
2. The herdr dispatch leg could not be measured in this run (Q2 refusal); its queueing
   semantics are documented but unverified, so choosing A today would rest on
   documentation, not evidence — against this project's own rule.
3. B is already implemented and its dangerous edges are already measured safe: overdue
   one-shots fire once on reopen (Q4: two overdue wakes → two `firedAt` entries, not a
   catch-up loop), repeating wakes skip missed slots, paused wakes restore paused
   (README + restore code read). Zero new state, no outbox, no locking.
4. The gap B leaves is real — a wake due while the session is closed fires late — but
   for the five long-lived herdr panes on this machine the sessions are open essentially
   always, and the in-session timer covers exactly that case today.

**Implication for the open todo (persistent outbox, multi-session locking): both are
unneeded.** Wake schedules live in the session file (Q5) and are restored on reopen;
nothing outside the session is authoritative. If the follow-up run (with the approved
`herdr --session` + network grants) verifies herdr's queueing and pane-restart behavior
and A is then pursued, the *only* external state to add is the small dispatch ledger of
Q5 — still not an outbox, still no locking, because the `firedAt` anchor in the session
file already deduplicates.

## Cleanup statement

No probe server, no systemd unit, no background pi was left running. All pi probe runs
were spawned with hard timeouts and confirmed exited (`SIGKILL`/code 1 observed by the
spawning scripts); `ps -C pi` after everything shows no pi processes, `pgrep -af herdr`
shows only this subagent's own helper. `.probe/` (scripts, scratch home with copied
`auth.json` — the one secret-containing artifact, git-ignored, and removable with the
scratch tree) is left in place for the follow-up run to reuse; nothing was committed.

## Not measured — summary

| Question | Status | Exact blocker |
| --- | --- | --- |
| Q2 prompt queueing behind a working turn (scratch herdr) | not measured | `herdr --session probe agent list` → "command not in the allowlist" (grants approved for follow-up run) |
| Q2 idle prompt turn shape | not measured | same refusal |
| Q3 dead-server connect behavior | not measured | probe server could not be started (same refusal) |
| Q3 pane-alive/agent-exited signal observed live | not measured | same refusal |
| Q4 context actually visible to the resumed turn's answer | not measured | bash network off → `connect ENETUNREACH 192.168.50.4:6450` |
| Q4 storm size (N overdue → N turns) | not measured | same; firing mechanism measured, turn count not |
| Q6 timer survival, `Persistent=true` after suspend, probe unit in `list-timers` | not measured | `systemctl --user` → "Failed to connect to user scope bus …"; parent measuring separately |
