import { readFileSync, readdirSync, existsSync } from "node:fs";
let found = [];
for (const pid of readdirSync("/proc").filter((p) => /^\d+$/.test(p))) {
  try {
    const cl = readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ").trim();
    if (cl.includes("herdr") || cl.includes("bin/pi") || cl.includes("ptyrelay")) found.push(pid + " " + cl.slice(0, 160));
  } catch {}
}
console.log("processes matching herdr/pi/ptyrelay:");
console.log(found.length ? found.join("\n") : "(none)");

for (const s of [
  "/home/shay/extensions/pi-wake/.probe/config/herdr/herdr.sock",
  "/home/shay/extensions/pi-wake/.probe/config/herdr/sessions/probe/herdr.sock",
]) console.log(s, existsSync(s) ? "PRESENT" : "absent");
