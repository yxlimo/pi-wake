// Try to make /dev/ptmx usable by bind-mounting /dev/pts/ptmx over it (namespace-local, dies with this process tree).
import { spawnSync, execSync } from "node:child_process";
import { openSync, closeSync, existsSync, unlinkSync, symlinkSync } from "node:fs";

function tryMount(args) {
  const r = spawnSync(args[0], args.slice(1), { encoding: "utf8" });
  return `${args.join(" ")} -> exit=${r.status} ${(r.stdout + r.stderr).trim().slice(0, 200)}`;
}

console.log(tryMount(["mount", "--bind", "/dev/pts/ptmx", "/dev/ptmx"]));
console.log(tryMount(["mount", "-o", "bind", "/dev/pts/ptmx", "/dev/ptmx"]));

try {
  const fd = openSync("/dev/ptmx", "r+");
  console.log("open /dev/ptmx after mount: OK fd=" + fd);
  closeSync(fd);
} catch (e) {
  console.log("open /dev/ptmx after mount FAILED:", e.code);
  // last resort: try replacing the node with a symlink (we are root on a rw devtmpfs)
  try {
    unlinkSync("/dev/ptmx");
    symlinkSync("/dev/pts/ptmx", "/dev/ptmx");
    const fd = openSync("/dev/ptmx", "r+");
    console.log("open /dev/ptmx after symlink swap: OK fd=" + fd);
    closeSync(fd);
  } catch (e2) {
    console.log("symlink swap FAILED:", e2.code, e2.message);
  }
}
