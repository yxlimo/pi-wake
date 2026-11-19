// PTY availability probe.
import { openSync, closeSync, readdirSync, statSync } from "node:fs";

console.log("/dev listing:");
for (const n of ["ptmx", "pts", "tty", "console"]) {
  try { console.log(" /dev/" + n, statSync("/dev/" + n).mode.toString(8)); }
  catch (e) { console.log(" /dev/" + n, "ERR", e.code); }
}
try { console.log("/dev/pts contents:", readdirSync("/dev/pts").join(", ")); }
catch (e) { console.log("/dev/pts unreadable:", e.code); }

try {
  const fd = openSync("/dev/ptmx", "r+");
  console.log("open /dev/ptmx: OK fd=" + fd);
  closeSync(fd);
} catch (e) {
  console.log("open /dev/ptmx FAILED:", e.code, e.message);
}
