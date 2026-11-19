// Q2 step C: can XDG_CONFIG_HOME relocate the probe session? + session list + attach without TTY.
import { spawnSync } from "node:child_process";
import { readdirSync, existsSync } from "node:fs";

function sh(cmd, args, env = {}, timeout = 20000) {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout, env: { ...process.env, ...env } });
  return `exit=${r.status}\n${((r.stdout || "") + (r.stderr || "")).trim()}`;
}

const CFG = "/home/shay/extensions/pi-wake/.probe/config";

console.log("=== XDG_CONFIG_HOME redirected: herdr --session probe agent list ===");
console.log(sh("herdr", ["--session", "probe", "agent", "list"], { XDG_CONFIG_HOME: CFG }));

console.log("\n=== herdr session list (default config, harmless read) ===");
console.log(sh("herdr", ["session", "list"]));

console.log("\n=== herdr session attach probe (no TTY, 12s cap) ===");
const r = spawnSync("herdr", ["session", "attach", "probe"], {
  encoding: "utf8", timeout: 12000,
  env: { ...process.env, TERM: "dumb" },
});
console.log("exit=" + r.status);
console.log(((r.stdout || "") + (r.stderr || "")).trim().slice(0, 1500));

console.log("\n=== socket after attach attempt ===");
console.log(existsSync("/home/shay/.config/herdr/sessions/probe/herdr.sock") ? "probe socket PRESENT" : "probe socket absent");

console.log("\n=== herdr --session probe agent list after attach attempt ===");
console.log(sh("herdr", ["--session", "probe", "agent", "list"]));

console.log("\n=== session list again ===");
console.log(sh("herdr", ["session", "list"]));
