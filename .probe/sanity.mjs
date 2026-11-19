// Sanity: inner store pi, scratch HOME/PI_CODING_AGENT_DIR, network to LAN proxy.
import { spawnSync } from "node:child_process";

const R = "/home/shay/extensions/pi-wake";
const PI = "/nix/store/x7xgahfvf8lf063cs20ybyby6cirxzim-pi-npm-1.5.2/bin/pi";
const r = spawnSync(PI, ["--provider", "buddy", "--model", "coder-c", "--session", R + "/.probe/state/sanity.jsonl", "--print", "Reply with exactly: NET-OK"], {
  encoding: "utf8",
  timeout: 120000,
  cwd: R,
  env: {
    ...process.env,
    HOME: R + "/.probe/home",
    PI_CODING_AGENT_DIR: R + "/.probe/home/.pi/agent",
  },
});
console.log("exit=" + r.status);
console.log("stdout:", (r.stdout || "").trim().slice(0, 500));
console.log("stderr:", (r.stderr || "").trim().slice(0, 500));
