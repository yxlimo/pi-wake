// Q1a: two concurrent JSONL appenders on one file, then validate.
import { openSync, writeSync, closeSync, readFileSync } from "node:fs";

const FILE = new URL("./state/q1a.jsonl", import.meta.url).pathname;

function appender(id, n) {
  return new Promise((resolve) => {
    const fd = openSync(FILE, "a"); // O_APPEND
    let i = 0;
    function step() {
      if (i >= n) {
        closeSync(fd);
        resolve(`writer-${id} done: ${n} lines`);
        return;
      }
      const line = JSON.stringify({ writer: id, seq: i, ts: Date.now(), pad: "x".repeat(80) }) + "\n";
      writeSync(fd, line); // one line per write call, like a session append
      i++;
      setTimeout(step, 1);
    }
    step();
  });
}

const N = 200;
const [r1, r2] = await Promise.all([appender("A", N), appender("B", N)]);
console.log(r1);
console.log(r2);

const text = readFileSync(FILE, "utf8");
const lines = text.split("\n");
const trailingEmpty = lines[lines.length - 1] === "" ? (lines.pop(), 1) : 0;
let bad = 0, counts = { A: 0, B: 0 };
for (const l of lines) {
  try {
    const o = JSON.parse(l);
    counts[o.writer]++;
  } catch {
    bad++;
    if (bad <= 3) console.log("BAD LINE:", JSON.stringify(l.slice(0, 120)));
  }
}
console.log(JSON.stringify({ totalLines: lines.length, expected: 2 * N, badLines: bad, perWriter: counts, trailingEmpty }));
console.log(bad === 0 && lines.length === 2 * N && counts.A === N && counts.B === N ? "VERDICT q1a: no interleaving, no truncation, no lost writes" : "VERDICT q1a: CORRUPTION OBSERVED");
