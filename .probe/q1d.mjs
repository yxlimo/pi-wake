// Q1d: two real pi --print runs resuming the SAME EXISTING session file, started concurrently.
import { spawn } from "node:child_process";
import { readFileSync, existsSync, writeFileSync } from "node:fs";

const FILE = new URL("./state/q1d.jsonl", import.meta.url).pathname;
const now = Date.now();
// Seed an existing session file first (simulates a session that already exists on disk).
const seed = [
  { type: "session", version: 3, id: "01a1f0aa-0000-4000-8000-q1dseed00001", timestamp: new Date(now - 60000).toISOString(), cwd: "/home/shay/extensions/pi-wake/.probe/cwd" },
  { type: "message", id: "s1", parentId: null, timestamp: now - 60000, message: { role: "user", content: [{ type: "text", text: "Seed turn." }], timestamp: now - 60000 } },
];
writeFileSync(FILE, seed.map((e) => JSON.stringify(e)).join("\n") + "\n");

const INNER = "/nix/store/x7xgahfvf8lf063cs20ybyby6cirxzim-pi-npm-1.5.2/bin/pi";

function runPI(tag) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(INNER, ["--provider", "buddy", "--model", "coder-c", "--session", FILE, "--print", `Reply with exactly: OK-from-${tag}`], {
      cwd: "/home/shay/extensions/pi-wake/.probe/cwd",
      env: { ...process.env, HOME: "/home/shay/extensions/pi-wake/.probe/home", PI_CODING_AGENT_DIR: "/home/shay/extensions/pi-wake/.probe/home/.pi/agent", PI_SUBAGENT_CHILD: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const killer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 25000);
    child.on("close", (code, sig) => {
      clearTimeout(killer);
      resolve({ tag, code, sig, ms: Date.now() - t0, out: out.slice(-300), err: err.slice(-500) });
    });
  });
}

const results = await Promise.all([runPI("first"), runPI("second")]);
for (const r of results) console.log(JSON.stringify(r));

const text = readFileSync(FILE, "utf8");
const lines = text.split("\n");
if (lines[lines.length - 1] === "") lines.pop();
let bad = [];
const types = {};
const userTexts = [];
lines.forEach((l, i) => {
  try {
    const o = JSON.parse(l);
    types[o.type ?? "?"] = (types[o.type ?? "?"] ?? 0) + 1;
    if (o.type === "message" && o.message?.role === "user") {
      userTexts.push((o.message.content?.[0]?.text ?? "").slice(0, 60));
    }
  } catch {
    bad.push({ line: i + 1, head: l.slice(0, 80) });
  }
});
console.log(JSON.stringify({ totalLines: lines.length, entryTypes: types, userTexts, badLines: bad }));
console.log(bad.length === 0 ? "VERDICT q1d: every line valid JSON, no truncation" : "VERDICT q1d: CORRUPTION OBSERVED");
