// Q1c: two real pi --print runs against the same scratch session file, started concurrently, offline.
import { spawn } from "node:child_process";
import { readFileSync, existsSync, rmSync } from "node:fs";

const FILE = new URL("./state/q1c.jsonl", import.meta.url).pathname;
if (existsSync(FILE)) rmSync(FILE);

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

if (existsSync(FILE)) {
  const text = readFileSync(FILE, "utf8");
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  let bad = [];
  const types = {};
  const sessionHeaders = [];
  lines.forEach((l, i) => {
    try {
      const o = JSON.parse(l);
      types[o.type ?? "?"] = (types[o.type ?? "?"] ?? 0) + 1;
      if (o.type === "session") sessionHeaders.push(o.id);
    } catch {
      bad.push({ line: i + 1, head: l.slice(0, 80) });
    }
  });
  console.log(JSON.stringify({ totalLines: lines.length, entryTypes: types, sessionHeaders, badLines: bad }));
  console.log(bad.length === 0 ? "VERDICT q1c: every line is valid JSON, no truncation" : "VERDICT q1c: CORRUPTION OBSERVED");
} else {
  console.log("VERDICT q1c: session file never created");
}
