# Parent-measured: systemd user timer behaviour (Q6)

Taken by the parent session on 2026-11-19 because the sandboxed investigator cannot reach the user bus
(`Failed to connect to user scope bus via local transport`). Cite these as measured, with the unit shown;
do not re-derive systemd semantics from documentation.

Machine: this host, user `shay`, systemd `--user` with `Linger=yes`.

## 1. Does a user timer keep running after logout?

```bash
loginctl show-user shay -p Linger
# Linger=yes
```

`Linger=yes` is set on this machine, so the user manager (and its timers) survives the last logout.
**Without linger this is false** — a `--user` timer dies with the session. Any design that relies on a
user timer must either require `loginctl enable-linger "$USER"` or schedule a system unit, and that
requirement is a fact about the host, not about the design.

## 2. Does `Persistent=true` catch up a missed run?

A past one-shot calendar produces **nothing to catch up**:

```bash
# timer: OnCalendar=2026-11-01 03:00:00, Persistent=true
systemctl --user enable --now pi-wake-probe.timer
systemctl --user show pi-wake-probe.timer -p NextElapseUSecRealtime -p LastTriggerUSec -p Persistent
# Persistent=yes
# NextElapseUSecRealtime=      (empty)
# LastTriggerUSec=             (empty)
# -> the service never ran: a calendar in the past yields no next elapse
```

With a recurring calendar, catch-up works and is observable by backdating the stamp:

```bash
# timer: OnCalendar=*:0/5, Persistent=true
systemctl --user start pi-wake-probe.timer
systemctl --user show pi-wake-probe.timer -p LastTriggerUSec
# LastTriggerUSec=Thu 2026-11-19 07:30:39 CST

systemctl --user stop pi-wake-probe.timer
touch -d '20 minutes ago' ~/.local/share/systemd/timers/stamp-pi-wake-probe.timer
systemctl --user start pi-wake-probe.timer
# immediately triggered:
cat /tmp/pi-wake-probe.log
# 2026-11-19T07:30:57+08:00
# ran
systemctl --user show pi-wake-probe.timer -p NextElapseUSecRealtime -p LastTriggerUSec
# LastTriggerUSec=Thu 2026-11-19 07:30:57 CST
# NextElapseUSecRealtime=Thu 2026-11-19 07:35:00 CST
systemctl --user show pi-wake-probe.service -p ExecMainStartTimestamp -p Result
# Result=success
```

So `Persistent=true` fires **one** catch-up run when a recurring slot was missed while the timer was not
active (suspend, shutdown), and it records its last trigger in
`~/.local/share/systemd/timers/stamp-<unit>.timer` — note the `stamp-` prefix, which is easy to miss when
hand-building a probe. It does **not** replay every missed slot.

Consequence for pi-wake: a catch-up run delivers whatever is overdue at that moment, so the delivered set
must be computed from the state file's due times, not from "the slot that the timer thinks it is on".

## 3. What the probe touched

Temporary units `pi-wake-probe.{service,timer}` under `~/.config/systemd/user`, a marker log at
`/tmp/pi-wake-probe.log`, and the timer's stamp file. All removed afterwards; `systemctl --user list-timers
--all | grep -c probe` → `0`, and no probe unit remains in the unit directory.
