// Check probe server liveness.
import { readFileSync, readdirSync, existsSync } from "node:fs";

const R = "/home/shay/extensions/pi-wake";
let found = [];
for (const pid of readdirSync("/proc").filter((p) => /^\d+$/.test(p))) {
  try {
    const cl = readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ").trim();
    if (cl.includes("herdr")) found.push(pid + " " + cl.slice(0, 200));
  } catch {}
}
console.log("herdr processes:", found.length ? found.join("\n") : "(none)");

console.log("\nserver log tail:");
console.log(readFileSync(R + "/.probe/herdr-server.log", "utf8").slice(-2000));
console.log("\nsocket present:", existsSync(R + "/.probe/config/herdr/herdr.sock"));
console.log("probe config dir:", existsSync(R + "/.probe/config/herdr")
  ? readdirSync(R + "/.probe/config/herdr").join(", ") : "(absent)");
