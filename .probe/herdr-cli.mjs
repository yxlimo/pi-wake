// Shared helper: run herdr CLI against the probe server (isolated config dir).
import { spawnSync } from "node:child_process";

const R = "/home/shay/extensions/pi-wake";
const CFG = R + "/.probe/config";

export function cli(args, timeoutMs = 60000) {
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
  const r = spawnSync("herdr", args, { encoding: "utf8", timeout: timeoutMs, env });
  return { code: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
}

export function probeEnv() {
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
  return env;
}
