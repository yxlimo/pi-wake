// Q4b run: headless --print over a session with 3 overdue wakes, model reachable.
// Measures: (a) do wake reminders land in the transcript; (b) N overdue -> N turns or one;
// (c) is the pre-session context visible to the resumed turn's answer.
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";

const R = "/home/shay/extensions/pi-wake";
const SESSION = R + "/.probe/state/q4b.jsonl";
const PI = "/nix/store/x7xgahfvf8lf063cs20ybyby6cirxzim-pi-npm-1.5.2/bin/pi";

const t0 = Date.now();
const r = spawnSync(PI, [
  "--provider", "buddy", "--model", "coder-c",
  "--session", SESSION,
  "--print", "Reply with exactly the marker you were told earlier in this session (it starts with Q4MAGIC) and nothing else.",
], {
  encoding: "utf8",
  timeout: 180000,
  cwd: R,
  env: { ...process.env, HOME: R + "/.probe/home", PI_CODING_AGENT_DIR: R + "/.probe/home/.pi/agent" },
});
console.log("exit=" + r.status, "elapsedMs=" + (Date.now() - t0));
console.log("stdout:", (r.stdout || "").trim().slice(0, 400));
console.log("stderr:", (r.stderr || "").trim().slice(0, 300));

console.log("\n=== transcript (q4b.jsonl) ===");
if (existsSync(SESSION)) {
  const lines = readFileSync(SESSION, "utf8").split("\n").filter(Boolean);
  let assistantCount = 0;
  for (const l of lines) {
    let e;
    try { e = JSON.parse(l); } catch { console.log("BADLINE", l.slice(0, 60)); continue; }
    const ts = e.timestamp || e.message?.timestamp || "";
    if (e.type === "message" && e.message?.role !== "system") {
      const c = e.message.content;
      const txt = Array.isArray(c) ? c.filter((x) => x.type === "text").map((x) => x.text).join(" ")
        : typeof c === "string" ? c : "";
      if (e.message.role === "assistant") assistantCount++;
      console.log(ts, e.message.role.padEnd(11), JSON.stringify(txt.replace(/\n/g, " ").slice(0, 120)));
    } else if (e.type === "custom") {
      console.log(ts, "custom", e.customType, JSON.stringify(e.data));
    } else if (e.type !== "message") {
      console.log(ts, e.type);
    }
  }
  console.log("assistantEntries(non-system total):", assistantCount);
} else console.log("(no session file)");
