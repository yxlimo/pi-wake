// Q4: seed a session file with prior context and pi-wake schedule entries.
import { writeFileSync } from "node:fs";

const FILE = new URL("./state/q4.jsonl", import.meta.url).pathname;
const now = Date.now();
const id = (n) => `q4seed${n}`;

const entries = [
  { type: "session", version: 3, id: "01a1f0aa-0000-4000-8000-q4seed000001", timestamp: new Date(now - 3600000).toISOString(), cwd: "/home/shay/extensions/pi-wake/.probe/cwd" },
  { type: "message", id: "a1", parentId: null, timestamp: now - 3600000, message: { role: "user", content: [{ type: "text", text: "Remember this marker for later: Q4-MAGIC-7391" }], timestamp: now - 3600000 } },
  // Two overdue one-shots: should arm and fire immediately on reopen.
  { type: "custom", customType: "wake_up", data: { id: "w1", dueAt: now - 60000, prompt: "State the magic number you were told.", armedAt: now - 120000 } },
  { type: "custom", customType: "wake_up", data: { id: "w2", dueAt: now - 30000, prompt: "Second overdue wake-up.", armedAt: now - 90000 } },
  // Future one-shot: must NOT fire.
  { type: "custom", customType: "wake_up", data: { id: "w3", dueAt: now + 3600000, prompt: "Future wake-up, must not fire now.", armedAt: now } },
];

writeFileSync(FILE, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
console.log("seeded", FILE, "entries:", entries.length, "at", new Date().toISOString());
