import { openSync, closeSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";

console.log("uid/gid:", spawnSync("id", { encoding: "utf8" }).stdout.trim());

try { console.log("/dev/pts/ptmx mode:", statSync("/dev/pts/ptmx").mode.toString(8)); }
catch (e) { console.log("/dev/pts/ptmx stat ERR:", e.code); }
try {
  const fd = openSync("/dev/pts/ptmx", "r+");
  console.log("open /dev/pts/ptmx: OK fd=" + fd);
  closeSync(fd);
} catch (e) {
  console.log("open /dev/pts/ptmx FAILED:", e.code, e.message);
}

// what mounts look like
console.log(spawnSync("cat", ["/proc/self/mountinfo"], { encoding: "utf8" }).stdout
  .split("\n").filter((l) => l.includes("/dev")).join("\n"));
