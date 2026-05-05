// Summarize a v8 .cpuprofile: top self-time functions.
import { readFileSync } from "node:fs";
const path = process.argv[2];
const top = Number(process.argv[3] ?? 25);
const prof = JSON.parse(readFileSync(path, "utf8"));
const nodes = prof.nodes;
const samples = prof.samples;
const deltas = prof.timeDeltas;
const byId = new Map();
for (const n of nodes) byId.set(n.id, n);
const selfUs = new Map();
for (let i = 0; i < samples.length; i += 1) {
  const id = samples[i];
  const dt = deltas[i] || 0;
  selfUs.set(id, (selfUs.get(id) || 0) + dt);
}
const totalUs = deltas.reduce((a, b) => a + b, 0);
const rows = [];
for (const [id, t] of selfUs) {
  const n = byId.get(id);
  if (!n) continue;
  const f = n.callFrame;
  const name = `${f.functionName || "(anon)"} @ ${f.url?.split("/").slice(-1)[0] || ""}:${f.lineNumber + 1}`;
  rows.push({ name, selfUs: t, pct: (t / totalUs) * 100 });
}
rows.sort((a, b) => b.selfUs - a.selfUs);
console.log(`total samples=${samples.length}  totalUs=${totalUs}`);
for (const r of rows.slice(0, top)) {
  console.log(`${r.pct.toFixed(2).padStart(6)}%  ${(r.selfUs / 1000).toFixed(2).padStart(8)}ms  ${r.name}`);
}
