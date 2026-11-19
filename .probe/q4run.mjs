// Q4: run pi --print against the seeded session; observe wake restore/fire and exit behavior.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const FILE = "/home/shay/extensions/pi-wake/.probe/state/q4.jsonl";
const INNER = "/nix/store/x7xgahfvf8lf063cs20ybyby6cirxzim-pi-npm-1.5.2/bin/pi";

const t0 = Date.now();
const child = spawn(INNER, ["--provider", "buddy", "--model", "coder-c", "--session", FILE, "--print", "Reply with exactly: RESUMED-OK"], {
  cwd: "/home/shay/extensions/pi-wake/.probe/cwd",
  env: { ...process.env, HOME: "/home/shay/extensions/pi-wake/.probe/home", PI_CODING_AGENT_DIR: "/home/shay/extensions/pi-wake/.probe/home/.pi/agent", PI_SUBAGENT_CHILD: "" },
  stdio: ["ignore", "pipe", "pipe"],
});
let out = "", err = "";
child.stdout.on("data", (d) => (out += d));
child.stderr.on("data", (d) => (err += d));
const killer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 40000);
child.on("close", (code, sig) => {
  clearTimeout(killer);
  console.log(JSON.stringify({ code, sig, ms: Date.now() - t0, exitedOnItsOwn: sig === null, out: out.slice(-400), err: err.slice(-500) }, null, 1));

  const lines = readFileSync(FILE, "utf8").split("\n").filter(Boolean);
  const wakes = lines.map((l) => { try { return JSON.parse(l); } catch { return { parseError: true }; } })
    .filter((o) => o.type === "custom" && o.customType === "wake_up");
  const wakeMessages = lines.map((l) => { try { return JSON.parse(l); } catch { return {}; } })
    .filter((o) => o.type === "message" && JSON.stringify(o.message?.content ?? "").includes("Scheduled wake-up"));
  const userTexts = lines.map((l) => { try { return JSON.parse(l); } catch { return {}; } })
    .filter((o) => o.type === "message" && o.message?.role === "user")
    .map((o) => (o.message.content?.[0]?.text ?? o.message.content ?? "").toString().slice(0, 80));
  console.log(JSON.stringify({
    wakeEntries: wakes.map((w) => ({ id: w.data?.id, dueAt: w.data?.dueAt, firedAt: w.data?.firedAt, cancelledAt: w.data?.cancelledAt })),
    wakeMessageCount: wakeMessages.length,
    userTexts,
    totalLines: lines.length,
  }, null, 1));
});
