// Q4c: does a REAL pi-written history survive into a later --print run's context?
// Run 1 writes the marker; run 2 (fresh process, same session file) must recall it.
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";

const R = "/home/shay/extensions/pi-wake";
const SESSION = R + "/.probe/state/q4c.jsonl";
const PI = "/nix/store/x7xgahfvf8lf063cs20ybyby6cirxzim-pi-npm-1.5.2/bin/pi";
const env = { ...process.env, HOME: R + "/.probe/home", PI_CODING_AGENT_DIR: R + "/.probe/home/.pi/agent" };

rmSync(SESSION, { force: true });

const run = (prompt) => {
  const t0 = Date.now();
  const r = spawnSync(PI, ["--provider", "buddy", "--model", "coder-c", "--session", SESSION, "--print", prompt], {
    encoding: "utf8", timeout: 120000, cwd: R, env,
  });
  return { code: r.status, ms: Date.now() - t0, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
};

const a = run("Remember this marker for later: Q4MAGIC-REAL-42. Reply with exactly: MARKER-SAVED");
console.log("run1 exit=" + a.code, "ms=" + a.ms, "stdout:", JSON.stringify(a.out.slice(0, 200)));

const b = run("Reply with exactly the marker you were told earlier in this session (it starts with Q4MAGIC-REAL) and nothing else.");
console.log("run2 exit=" + b.code, "ms=" + b.ms, "stdout:", JSON.stringify(b.out.slice(0, 200)));

// transcript roles/timestamps for evidence
const lines = readFileSync(SESSION, "utf8").split("\n").filter(Boolean);
for (const l of lines) {
  try {
    const e = JSON.parse(l);
    if (e.type === "message" && e.message?.role !== "system") {
      const c = e.message.content;
      const txt = Array.isArray(c) ? c.filter((x) => x.type === "text").map((x) => x.text).join(" ") : "";
      console.log(e.timestamp || e.message.timestamp, e.message.role.padEnd(9), JSON.stringify(txt.replace(/\n/g, " ").slice(0, 90)));
    } else if (e.type !== "message") console.log(e.type);
  } catch {}
}
