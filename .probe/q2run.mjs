// Q2+Q3 one-shot experiment: everything in a single node process because the
// sandbox kills children when the bash call ends (measured: server died between calls).
import { spawn, spawnSync } from "node:child_process";
import { existsSync, openSync, readFileSync, unlinkSync, readdirSync } from "node:fs";
import net from "node:net";

const R = "/home/shay/extensions/pi-wake";
const CFG = R + "/.probe/config";
const SOCK = CFG + "/herdr/herdr.sock";
const SESSION = R + "/.probe/state/q2.jsonl";

function probeEnv() {
  const env = { ...process.env };
  delete env.HERDR_ENV; delete env.HERDR_PANE_ID; delete env.HERDR_SOCKET_PATH;
  delete env.HERDR_TAB_ID; delete env.HERDR_WORKSPACE_ID;
  env.XDG_CONFIG_HOME = CFG;
  env.XDG_STATE_HOME = R + "/.probe/herdr";
  env.HOME = R + "/.probe/home";
  env.PI_CODING_AGENT_DIR = R + "/.probe/home/.pi/agent";
  env.PATH = R + "/.probe/bin:" + env.PATH;
  return env;
}
function cli(args, timeoutMs = 120000) {
  const t0 = Date.now();
  const r = spawnSync("herdr", args, { encoding: "utf8", timeout: timeoutMs, env: probeEnv() });
  return { code: r.status, out: ((r.stdout || "") + (r.stderr || "")).trim(), ms: Date.now() - t0 };
}
const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const probeSocket = (sock) => new Promise((res) => {
  const s = net.createConnection(sock);
  s.on("connect", () => { s.destroy(); res(true); });
  s.on("error", () => res(false));
  setTimeout(() => { s.destroy(); res(false); }, 1500);
});

// ---------- A. server ----------
let up = existsSync(SOCK) && await probeSocket(SOCK);
if (!up && existsSync(SOCK)) {
  log("stale socket — removing before spawn");
  unlinkSync(SOCK);
}
if (!up) {
  const out = openSync(R + "/.probe/herdr-server.log", "a");
  const child = spawn("herdr", ["server"], { env: probeEnv(), stdio: ["ignore", out, out], detached: true });
  child.unref();
  log("server spawned pid", child.pid);
}
for (let i = 0; i < 30 && !up; i++) {
  await sleep(1000);
  up = existsSync(SOCK) && await probeSocket(SOCK);
}
log("server up:", up);
if (!up) process.exit(1);

// ---------- B. workspace ----------
let pl = cli(["pane", "list"]);
let paneId = (pl.out.match(/"pane_id":"([^"]+)"/) || [])[1];
if (!paneId) {
  const wc = cli(["workspace", "create", "--label", "probe-ws", "--cwd", R]);
  log("workspace create:", wc.code, wc.out.slice(0, 400));
  pl = cli(["pane", "list"]);
  paneId = (pl.out.match(/"pane_id":"([^"]+)"/) || [])[1];
}
log("root pane:", paneId);

// ---------- C. agent start ----------
const st = cli(["agent", "start", "wakeprobe", "--kind", "pi", "--pane", paneId, "--timeout", "60000",
  "--", "--provider", "buddy", "--model", "coder-c", "--session", SESSION], 90000);
log("agent start:", st.code, st.out.slice(0, 600));

// ---------- D. wait idle + baseline shapes ----------
log("\n=== agent wait idle ===");
log(cli(["agent", "wait", "wakeprobe", "--until", "idle", "--timeout", "60000"], 90000).out.slice(0, 400));
log("\n=== agent get (baseline) ===");
log(cli(["agent", "get", "wakeprobe"]).out.slice(0, 900));
log("\n=== agent list (baseline) ===");
log(cli(["agent", "list"]).out.slice(0, 1400));

// ---------- E. idle prompt baseline ----------
log("\n=== idle prompt (baseline) ===");
const tIdle = Date.now();
const pIdle = cli(["agent", "prompt", "wakeprobe",
  "Reply with exactly: IDLE-BASELINE-OK", "--wait", "--timeout", "120000"], 150000);
log("code:", pIdle.code, "ms:", pIdle.ms, "sent-at:", new Date(tIdle).toISOString());
log(pIdle.out.slice(0, 500));

// ---------- F. slow turn ----------
const SLOW_A = "Write out the numbers from 1 to 400, one number per line, and nothing else. After the last number output exactly SLOW-DONE-400.";
log("\n=== slow turn prompt (t=" + new Date().toISOString() + ") ===");
const pSlow = cli(["agent", "prompt", "wakeprobe", SLOW_A, "--wait", "--timeout", "300000"], 330000);
log("slow prompt result code:", pSlow.code, "ms:", pSlow.ms, pSlow.out.slice(0, 300));

// confirm still working ~6 s after submission; escalate if the turn finished too fast
let samples = [];
let stateNow = () => {
  const g = cli(["agent", "get", "wakeprobe"]);
  const m = g.out.match(/"state":"([a-z]+)"/);
  return m ? m[1] : "no-state:" + g.out.slice(0, 120);
};
await sleep(6000);
let s0 = stateNow();
samples.push([Date.now(), s0]);
log("state 6s after slow prompt:", s0);
if (s0 !== "working") {
  log("turn finished too fast — escalating to 1..1200");
  const pSlow2 = cli(["agent", "prompt", "wakeprobe",
    "Write out the numbers from 1 to 1200, one per line, and nothing else. After the last output exactly SLOW-DONE-1200.",
    "--wait", "--timeout", "300000"], 330000);
  log("escalated slow prompt code:", pSlow2.code, pSlow2.out.slice(0, 200));
  await sleep(6000);
  s0 = stateNow();
  samples.push([Date.now(), s0]);
  log("state 6s after escalated prompt:", s0);
}

// ---------- G. mid-turn prompt (the queueing question) ----------
const tMid = Date.now();
log("\n=== MID-TURN prompt submitted at", new Date(tMid).toISOString(), "state was:", s0, "===");
const pMid = cli(["agent", "prompt", "wakeprobe",
  "Reply with exactly: MIDTURN-MARKER-Q2", "--timeout", "10000"], 30000);
log("mid-turn prompt result code:", pMid.code, "ms:", pMid.ms);
log(pMid.out.slice(0, 400));

// sample state every 2 s until idle, record transitions
let last = s0, transitions = [];
const tMidStart = Date.now();
for (let i = 0; i < 150; i++) {
  await sleep(2000);
  const stx = stateNow();
  if (stx !== last) { transitions.push([Date.now() - tMidStart, last + "->" + stx]); last = stx; }
  if (stx === "idle" || stx.startsWith("no-state")) break;
}
log("state transitions after mid-turn prompt (ms since prompt):");
log(transitions.map((x) => x.join("ms: ")).join(" | ") || "(none — stayed " + s0 + ")");
log("total ms:", Date.now() - tMidStart);

// ---------- H. transcript + session file ----------
log("\n=== pane read (recent-unwrapped, tail) ===");
const rd = cli(["agent", "read", "wakeprobe", "--source", "recent-unwrapped", "--lines", "160"]);
log(rd.out.slice(-1800));

log("\n=== session file entry order (q2.jsonl) ===");
if (existsSync(SESSION)) {
  const lines = readFileSync(SESSION, "utf8").split("\n").filter(Boolean);
  for (const l of lines) {
    try {
      const e = JSON.parse(l);
      const ts = e.timestamp || (e.message && e.message.timestamp) || "";
      if (e.type === "message") {
        const c = e.message.content;
        const txt = Array.isArray(c) ? c.filter((x) => x.type === "text").map((x) => x.text).join(" ")
          : typeof c === "string" ? c : JSON.stringify(c);
        log(ts, e.message.role, JSON.stringify(txt.replace(/\n/g, " ").slice(0, 110)));
      } else {
        log(ts, e.type, e.customType || "");
      }
    } catch { log("BADLINE", l.slice(0, 80)); }
  }
} else log("(session file absent)");

// ---------- I. Q3 shape 2: kill the pi while the pane lives ----------
log("\n=== Q3: kill the pi process ===");
let victims = [];
for (const pid of readdirSync("/proc").filter((p) => /^\d+$/.test(p))) {
  try {
    const cl = readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ");
    if (cl.includes(".probe/state/q2.jsonl") || (cl.includes("bin/pi") && cl.includes("buddy"))) victims.push(pid);
  } catch {}
}
log("pi victim pids:", victims);
for (const pid of victims) { try { process.kill(Number(pid), "SIGKILL"); log("killed", pid); } catch (e) { log("kill failed", pid, e.message); } }
await sleep(3000);
log("\n=== agent list after pi killed ===");
log(cli(["agent", "list"]).out.slice(0, 800));
log("\n=== agent get wakeprobe after kill ===");
log(cli(["agent", "get", "wakeprobe"]).out.slice(0, 400));
log("\n=== pane list after kill ===");
log(cli(["pane", "list"]).out.slice(0, 900));
log("\n=== pane get after kill ===");
log(cli(["pane", "get", paneId]).out.slice(0, 900));
log("\n=== pane process-info after kill ===");
log(cli(["pane", "process-info", paneId]).out.slice(0, 700));

// ---------- J. Q3 shape 1: stop the server ----------
log("\n=== Q3: stop the probe server ===");
const stop = cli(["server", "stop"]);
log("server stop:", stop.code, stop.out.slice(0, 300));
await sleep(2000);
log("socket file after stop:", existsSync(SOCK) ? "PRESENT (stale)" : "removed");
log("raw connect to probe socket after stop:", existsSync(SOCK) ? await probeSocket(SOCK) : "(no socket file)");
log("\n=== herdr agent list against stopped server ===");
log(cli(["agent", "list"]).out.slice(0, 400));

// ---------- K. cleanup verification ----------
await sleep(1000);
let left = [];
for (const pid of readdirSync("/proc").filter((p) => /^\d+$/.test(p))) {
  try {
    const cl = readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ").trim();
    if ((cl.includes("herdr") || cl.includes("bin/pi")) && cl.includes(".probe")) left.push(pid + " " + cl.slice(0, 120));
  } catch {}
}
log("\nleftover probe processes:", left.length ? left.join("\n") : "(none)");
