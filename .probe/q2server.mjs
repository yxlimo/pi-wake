// Q2 step E: start the probe herdr session server (isolated via XDG_CONFIG_HOME), detached.
import { spawn } from "node:child_process";
import { existsSync, openSync, readdirSync } from "node:fs";
import net from "node:net";

const R = "/home/shay/extensions/pi-wake";
const CFG = R + "/.probe/config";
const SOCK = CFG + "/herdr/sessions/probe/herdr.sock";

const env = { ...process.env };
delete env.HERDR_ENV;            // avoid the nested-herdr guard
delete env.HERDR_PANE_ID;
delete env.HERDR_SOCKET_PATH;
delete env.HERDR_TAB_ID;
delete env.HERDR_WORKSPACE_ID;
env.XDG_CONFIG_HOME = CFG;
env.XDG_STATE_HOME = R + "/.probe/herdr";  // measured: does not move the socket; belt+braces
env.HOME = R + "/.probe/home";             // panes inherit scratch HOME
env.PI_CODING_AGENT_DIR = R + "/.probe/home/.pi/agent";
env.PATH = R + "/.probe/bin:" + env.PATH;  // `pi` resolves to the scratch shim

if (existsSync(SOCK)) {
  console.log("socket already present — server may already be running");
} else {
  const out = openSync(R + "/.probe/herdr-server.log", "a");
  const child = spawn("herdr", ["--session", "probe"], { env, stdio: ["ignore", out, out], detached: true });
  child.unref();
  console.log("spawned pid", child.pid);
}

// poll socket for 40 s
let ok = false;
for (let i = 0; i < 40 && !ok; i++) {
  await new Promise((res) => setTimeout(res, 1000));
  if (existsSync(SOCK)) {
    // try a connect
    ok = await new Promise((resolve) => {
      const s = net.createConnection(SOCK);
      s.on("connect", () => { s.destroy(); resolve(true); });
      s.on("error", () => resolve(false));
      setTimeout(() => { s.destroy(); resolve(false); }, 1500);
    });
  }
}
console.log(ok ? "probe socket connectable" : "probe socket NOT connectable after 40s");
console.log("socket:", SOCK, existsSync(SOCK) ? "present" : "absent");
console.log("server log tail:");
console.log((await import("node:fs")).readFileSync(R + "/.probe/herdr-server.log", "utf8").slice(-1500));
