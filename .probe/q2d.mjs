// Q2 step D: agent start / pane split syntax.
import { spawnSync } from "node:child_process";

function sh(cmd, args, env = {}, timeout = 20000) {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout, env: { ...process.env, ...env } });
  return `exit=${r.status}\n${((r.stdout || "") + (r.stderr || "")).trim()}`;
}

console.log("=== herdr agent start --help ===");
console.log(sh("herdr", ["agent", "start", "--help"]));

console.log("\n=== herdr pane split --help ===");
console.log(sh("herdr", ["pane", "split", "--help"]));

console.log("\n=== herdr agent prompt --help ===");
console.log(sh("herdr", ["agent", "prompt", "--help"]));

console.log("\n=== herdr agent wait --help ===");
console.log(sh("herdr", ["agent", "wait", "--help"]));

console.log("\n=== herdr agent list --help ===");
console.log(sh("herdr", ["agent", "list", "--help"]));

console.log("\n=== herdr session stop --help ===");
console.log(sh("herdr", ["session", "stop", "--help"]));
