// Q2 step F: probe server topology + start a scratch pi agent.
import { cli } from "./herdr-cli.mjs";

console.log("=== workspace list ===");
console.log(cli(["workspace", "list"]).stdout.trim() || cli(["workspace", "list"]).stderr.trim());

console.log("\n=== pane list ===");
let pl = cli(["pane", "list"]);
console.log((pl.stdout + pl.stderr).trim().slice(0, 800));

// create a workspace if empty
if (!pl.stdout.includes("pane_id")) {
  console.log("\n=== workspace create probe-ws ===");
  const wc = cli(["workspace", "create", "probe-ws"]);
  console.log((wc.stdout + wc.stderr).trim().slice(0, 1200));
  pl = cli(["pane", "list"]);
  console.log("\n=== pane list after create ===");
  console.log((pl.stdout + pl.stderr).trim().slice(0, 800));
}

const paneId = (pl.stdout.match(/"pane_id":"([^"]+)"/) || [])[1];
console.log("\nroot pane:", paneId);

if (paneId) {
  console.log("\n=== agent start wakeprobe (pi) in pane", paneId, "===");
  const st = cli(
    ["agent", "start", "wakeprobe", "--kind", "pi", "--pane", paneId, "--timeout", "60000",
     "--", "--provider", "buddy", "--model", "coder-c", "--session", "/home/shay/extensions/pi-wake/.probe/state/q2.jsonl"],
    90000,
  );
  console.log("exit:", st.code);
  console.log((st.stdout + st.stderr).trim().slice(0, 1500));
}
