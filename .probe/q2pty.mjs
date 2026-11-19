// Q2 experiment v2: genuinely slow turns (3000 streamed numbers) so the mid-turn
// submissions provably land while the turn is still in flight.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, appendFileSync, readdirSync } from "node:fs";

const R = "/home/shay/extensions/pi-wake";
const SESSION = R + "/.probe/state/q2.jsonl";
const OUTLOG = R + "/.probe/state/q2-tui-out.log";
const PI = "/nix/store/x7xgahfvf8lf063cs20ybyby6cirxzim-pi-npm-1.5.2/bin/pi";

const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const stamp = () => new Date().toISOString();

const env = { ...process.env };
delete env.HERDR_ENV;
env.HOME = R + "/.probe/home";
env.PI_CODING_AGENT_DIR = R + "/.probe/home/.pi/agent";
env.TERM = "xterm-256color";

const child = spawn(R + "/.probe/ptyrelay", [
  PI, "--provider", "buddy", "--model", "coder-c", "--session", SESSION,
], { env, stdio: ["pipe", "pipe", "pipe", "pipe"], cwd: R });

let slavePath = "";
let buf3 = "";
child.stdio[3].on("data", (d) => { buf3 += d; const i = buf3.indexOf("\n"); if (i >= 0 && !slavePath) { slavePath = buf3.slice(0, i).trim(); log("slave:", slavePath); } });

let outAll = Buffer.alloc(0);
child.stdout.on("data", (d) => { outAll = Buffer.concat([outAll, d]); appendFileSync(OUTLOG, d); });
child.stderr.on("data", (d) => appendFileSync(OUTLOG, Buffer.concat([Buffer.from("[stderr] "), d])));
child.on("exit", (c, s) => log("relay exit:", c, s));

writeFileSync(OUTLOG, "");
const send = (str, label) => { child.stdin.write(str); log("SENT", label, "at", stamp()); };

function entries() {
  if (!existsSync(SESSION)) return [];
  return readFileSync(SESSION, "utf8").split("\n").filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return { type: "BADLINE" }; } });
}
function msgText(e) {
  const c = e.message?.content;
  if (!Array.isArray(c)) return typeof c === "string" ? c : "";
  return c.filter((x) => x.type === "text").map((x) => x.text).join(" ");
}
function msgs() { return entries().filter((e) => e.type === "message" && e.message?.role !== "system"); }
function hasAssistantWith(s) { return msgs().some((e) => e.message.role === "assistant" && msgText(e).includes(s)); }
function hasUserWith(s) { return msgs().some((e) => e.message.role === "user" && msgText(e).includes(s)); }
async function waitFor(fn, timeoutMs, what) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (fn()) return true;
    await sleep(1000);
  }
  log("TIMEOUT waiting for", what);
  return false;
}

await sleep(9000);
log("pi enables bracketed paste:", outAll.toString("utf8").includes("\x1b[?2004h"));

// ---------- turn A: plain mid-turn submission ----------
send("Write the numbers from 1 to 3000, one number per line, and nothing else. After the last number output exactly SLOWA-DONE.\r", "turnA prompt");
if (!await waitFor(() => hasUserWith("1 to 3000"), 60000, "turnA user entry")) process.exit(1);
log("turnA user entry at", stamp());
await sleep(15000);
const midA = hasAssistantWith("SLOWA-DONE");
log("turnA still in flight before injection:", !midA);
if (midA) { log("turn finished too fast again — result invalid, aborting"); process.exit(2); }
send("Reply with exactly: MIDTURN-PLAIN-Q2\r", "mid-turn plain submission");
log("t_submit_A =", stamp());
if (!await waitFor(() => hasAssistantWith("SLOWA-DONE"), 420000, "turnA completion")) process.exit(1);
log("turnA completed at", stamp());
await sleep(6000);

// ---------- idle bracketed-paste baseline ----------
send("\x1b[200~Reply with exactly: PASTE-IDLE-Q2\x1b[201~\r", "idle paste submission");
if (!await waitFor(() => hasAssistantWith("PASTE-IDLE-Q2"), 120000, "idle paste reply")) process.exit(1);
log("idle paste answered at", stamp());
await sleep(5000);

// ---------- turn B: bracketed-paste mid-turn submission ----------
send("Write the numbers from 3001 to 6000, one number per line, and nothing else. After the last number output exactly SLOWB-DONE.\r", "turnB prompt");
if (!await waitFor(() => hasUserWith("3001 to 6000"), 60000, "turnB user entry")) process.exit(1);
log("turnB user entry at", stamp());
await sleep(15000);
const midB = hasAssistantWith("SLOWB-DONE");
log("turnB still in flight before injection:", !midB);
if (midB) { log("turn finished too fast again — result invalid, aborting"); process.exit(2); }
send("\x1b[200~Reply with exactly: MIDTURN-PASTE-Q2\x1b[201~\r", "mid-turn paste submission");
log("t_submit_B =", stamp());
if (!await waitFor(() => hasAssistantWith("SLOWB-DONE"), 420000, "turnB completion")) process.exit(1);
log("turnB completed at", stamp());
await sleep(8000);

// ---------- evidence ----------
log("\n=== session entry order (q2.jsonl) ===");
for (const e of entries()) {
  const ts = e.timestamp || e.message?.timestamp || "";
  if (e.type === "message" && e.message?.role !== "system") {
    log(ts, e.message.role.padEnd(9), JSON.stringify(msgText(e).replace(/\n/g, " ").slice(0, 90)));
  } else if (e.type === "message") {
    log(ts, "system", "(system prompt entry)");
  } else {
    log(ts, e.type, e.customType || "");
  }
}

// cleanup
const victims = readdirSync("/proc").filter((p) => /^\d+$/.test(p)).filter((pid) => {
  try { return readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ").includes(".probe/state/q2.jsonl"); }
  catch { return false; }
});
for (const pid of victims) { try { process.kill(Number(pid), "SIGKILL"); log("killed pi", pid); } catch (e) { log("kill failed", pid, e.message); } }
await sleep(2000);
log("done");
process.exit(0);
