// Q1b: two real `pi --print` runs against the same scratch session file, started concurrently.
import { spawn } from "node:child_process";
import { readFileSync, existsSync, rmSync } from "node:fs";

const FILE = new URL("./state/q1b.jsonl", import.meta.url).pathname;
if (existsSync(FILE)) rmSync(FILE);

function runPI(tag, prompt) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn("pi", ["--session", FILE, "--print", prompt], {
      cwd: "/home/shay/extensions/pi-wake/.probe",
      env: { ...process.env, PI_CODING_AGENT_DIR: "/home/shay/extensions/pi-wake/.probe/agent", PI_SUBAGENT_CHILD: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const killer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 120000);
    child.on("close", (code, sig) => {
      clearTimeout(killer);
      resolve({ tag, code, sig, ms: Date.now() - t0, out: out.slice(-500), err: err.slice(-800) });
    });
  });
}

const results = await Promise.all([
  runPI("first", "Reply with exactly: OK-from-first"),
  runPI("second", "Reply with exactly: OK-from-second"),
]);
for (const r of results) console.log(JSON.stringify(r, null, 1));

// Validate the session file: every line parses as JSON, none truncated.
if (existsSync(FILE)) {
  const text = readFileSync(FILE, "utf8");
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  let bad = [];
  const types = {};
  lines.forEach((l, i) => {
    try {
      const o = JSON.parse(l);
      types[o.type ?? "?"] = (types[o.type ?? "?"] ?? 0) + 1;
    } catch (e) {
      bad.push({ line: i + 1, head: l.slice(0, 100) });
    }
  });
  console.log(JSON.stringify({ totalLines: lines.length, entryTypes: types, badLines: bad }, null, 1));
  console.log(bad.length === 0 ? "VERDICT q1b: session file intact — every line is valid JSON" : "VERDICT q1b: CORRUPTION OBSERVED");
} else {
  console.log("VERDICT q1b: session file was never created");
}
