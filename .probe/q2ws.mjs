import { spawnSync } from "node:child_process";
for (const args of [["workspace", "--help"], ["workspace", "create", "--help"]]) {
  const r = spawnSync("herdr", args, { encoding: "utf8", timeout: 15000 });
  console.log("===", args.join(" "), "===");
  console.log(((r.stdout || "") + (r.stderr || "")).trim().slice(0, 900), "\n");
}
