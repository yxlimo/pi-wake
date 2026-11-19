// Discover herdr CLI surface + socket location logic. Read-only.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

function run(args, env = {}) {
  const r = spawnSync("herdr", args, {
    encoding: "utf8",
    timeout: 15000,
    env: { ...process.env, ...env },
  });
  return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
}

console.log("=== herdr --help (trimmed) ===");
const h = run(["--help"]);
console.log(h.out.split("\n").slice(0, 60).join("\n"));

console.log("=== herdr agent --help ===");
const a = run(["agent", "--help"]);
console.log(a.out.split("\n").slice(0, 40).join("\n"));

console.log("=== herdr pane --help ===");
const p = run(["pane", "--help"]);
console.log(p.out.split("\n").slice(0, 40).join("\n"));

console.log("=== socket files present ===");
for (const p2 of [
  "/home/shay/.config/herdr/herdr.sock",
  "/home/shay/.local/state/herdr/herdr.sock",
  process.cwd() + "/.probe/herdr/herdr.sock",
]) {
  console.log(p2, existsSync(p2) ? "PRESENT" : "absent");
}
