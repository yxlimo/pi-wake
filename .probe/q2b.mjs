// Q2 step B: session/server subcommand surface + XDG_STATE_HOME effect on the probe socket path.
import { spawnSync } from "node:child_process";

function sh(cmd, args, env = {}, timeout = 20000) {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout, env: { ...process.env, ...env } });
  return `exit=${r.status}\n${((r.stdout || "") + (r.stderr || "")).trim()}`;
}

const STATE = "/home/shay/extensions/pi-wake/.probe/herdr";

console.log("=== herdr session --help ===");
console.log(sh("herdr", ["session", "--help"]));

console.log("\n=== herdr server --help ===");
console.log(sh("herdr", ["server", "--help"]));

console.log("\n=== herdr --session probe agent list WITH XDG_STATE_HOME redirected ===");
console.log(sh("herdr", ["--session", "probe", "agent", "list"], { XDG_STATE_HOME: STATE }));

console.log("\n=== does the probe state dir exist now? ===");
const { readdirSync, existsSync } = await import("node:fs");
if (existsSync(STATE)) console.log(readdirSync(STATE, { recursive: true }).join("\n"));
else console.log("(absent)");
