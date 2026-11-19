// Q4b: seed a session with marker + THREE overdue one-shot wakes (storm test).
import { writeFileSync } from "node:fs";

const FILE = "/home/shay/extensions/pi-wake/.probe/state/q4b.jsonl";
const now = Date.now();

const entries = [
  { type: "session", version: 3, id: "01a1f0aa-0000-4000-8000-q4seedb00001", timestamp: new Date(now - 3600000).toISOString(), cwd: "/home/shay/extensions/pi-wake/.probe/cwd" },
  { type: "message", id: "a1", parentId: null, timestamp: now - 3600000, message: { role: "user", content: [{ type: "text", text: "Remember this marker for later: Q4MAGIC-7391" }], timestamp: now - 3600000 } },
  { type: "custom", customType: "wake_up", data: { id: "w1", dueAt: now - 60000, prompt: "Wake one: say WAKEONE-ACK.", armedAt: now - 120000 } },
  { type: "custom", customType: "wake_up", data: { id: "w2", dueAt: now - 45000, prompt: "Wake two: say WAKETWO-ACK.", armedAt: now - 105000 } },
  { type: "custom", customType: "wake_up", data: { id: "w3", dueAt: now - 30000, prompt: "Wake three: say WAKETHREE-ACK.", armedAt: now - 90000 } },
];

writeFileSync(FILE, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
console.log("seeded", FILE, "entries:", entries.length);
