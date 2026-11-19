import { spawnSync } from "node:child_process";
for (const c of ["cc", "gcc", "zig", "tcc", "setsid", "script"]) {
  const r = spawnSync(c, ["--version"], { encoding: "utf8", timeout: 10000 });
  console.log(c, "exit=" + r.status, ((r.stdout || r.stderr || "").trim().split("\n")[0] || "").slice(0, 90));
}
// setsid has no --version; probe it separately
const s = spawnSync("setsid", ["true"], { encoding: "utf8" });
console.log("setsid true exit=" + s.status);
