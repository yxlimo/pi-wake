// Q2 step A: observe what `herdr --session probe agent list` does.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";

function sh(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 30000 });
  return { code: r.status, out: ((r.stdout || "") + "\n" + (r.stderr || "")).trim() };
}

const cfg = "/home/shay/.config/herdr";
console.log("--- before: ~/.config/herdr listing");
console.log(readdirSync(cfg).join("\n"));

console.log("--- run: herdr --session probe agent list");
const r = sh("herdr", ["--session", "probe", "agent", "list"]);
console.log("exit:", r.code);
console.log(r.out.slice(0, 2000));

console.log("--- after: ~/.config/herdr listing");
console.log(readdirSync(cfg).join("\n"));

console.log("--- probe-related sockets/files");
for (const d of ["/home/shay/.config/herdr", "/home/shay/.local/state/herdr", "/home/shay/.local/share/herdr"]) {
  if (existsSync(d)) console.log(d, "->", readdirSync(d).join(", "));
}

console.log("--- processes matching herdr (ps via /proc scan)");
for (const pid of readdirSync("/proc").filter((p) => /^\d+$/.test(p))) {
  try {
    const cl = readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ").trim();
    if (cl.includes("herdr")) console.log(pid, cl.slice(0, 160));
  } catch {}
}
