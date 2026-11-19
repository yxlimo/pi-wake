// Q2 step E2: start herdr as headless server with isolated config dir.
import { spawn } from "node:child_process";
import { existsSync, openSync, readFileSync } from "node:fs";
import net from "node:net";

const R = "/home/shay/extensions/pi-wake";
const CFG = R + "/.probe/config";
const SOCK = CFG + "/herdr/herdr.sock";

const env = { ...process.env };
delete env.HERDR_ENV;
delete env.HERDR_PANE_ID;
delete env.HERDR_SOCKET_PATH;
delete env.HERDR_TAB_ID;
delete env.HERDR_WORKSPACE_ID;
env.XDG_CONFIG_HOME = CFG;
env.XDG_STATE_HOME = R + "/.probe/herdr";
env.HOME = R + "/.probe/home";
env.PI_CODING_AGENT_DIR = R + "/.probe/home/.pi/agent";
env.PATH = R + "/.probe/bin:" + env.PATH;

if (existsSync(SOCK)) {
  console.log("socket already present");
} else {
  const out = openSync(R + "/.probe/herdr-server.log", "a");
  const child = spawn("herdr", ["server"], { env, stdio: ["ignore", out, out], detached: true });
  child.unref();
  console.log("spawned pid", child.pid);
}

let ok = false;
for (let i = 0; i < 30 && !ok; i++) {
  await new Promise((res) => setTimeout(res, 1000));
  if (existsSync(SOCK)) {
    ok = await new Promise((resolve) => {
      const s = net.createConnection(SOCK);
      s.on("connect", () => { s.destroy(); resolve(true); });
      s.on("error", () => resolve(false));
      setTimeout(() => { s.destroy(); resolve(false); }, 1500);
    });
  }
}
console.log(ok ? "probe socket connectable" : "probe socket NOT connectable after 30s");
console.log("socket:", SOCK, existsSync(SOCK) ? "present" : "absent");
console.log("server log tail:");
console.log(readFileSync(R + "/.probe/herdr-server.log", "utf8").slice(-1200));
