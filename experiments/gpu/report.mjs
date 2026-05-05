// Merge CPU + GPU results and emit a Markdown table.
import fs from "node:fs";

const cpu = JSON.parse(fs.readFileSync(new URL("./cpu_results.json", import.meta.url), "utf8"));
const gpu = JSON.parse(fs.readFileSync(new URL("./gpu_results.json", import.meta.url), "utf8"));

function key(r) {
  if (r.kind === "matmul") return `matmul|${r.case}|${r.B}`;
  if (r.kind === "mlp") return `mlp|${r.case}|${r.B}`;
  if (r.kind === "softmax") return `softmax|${r.N}|${r.B}`;
  return null;
}

const cMap = new Map(cpu.map((r) => [key(r), r]));
const gMap = new Map(gpu.map((r) => [key(r), r]));

const rows = [];
const allKeys = new Set([...cMap.keys(), ...gMap.keys()]);
for (const k of allKeys) {
  const c = cMap.get(k);
  const g = gMap.get(k);
  rows.push({ k, c, g });
}

// Group by kind
function fmt(n) { return n == null ? "—" : n.toFixed(4); }
function speedup(cpu_ms, gpu_ms) {
  if (cpu_ms == null || gpu_ms == null || gpu_ms <= 0) return "—";
  const r = cpu_ms / gpu_ms;
  return (r >= 1 ? r.toFixed(2) + "x" : (1 / r).toFixed(2) + "x slower");
}

const sections = { matmul: [], mlp: [], softmax: [] };
for (const { c, g } of rows) {
  const r = c || g;
  if (!r) continue;
  sections[r.kind].push({ c, g, r });
}

const lines = [];
lines.push("# CPU vs GPU benchmark results", "");
lines.push("Hardware: RTX 2080 SUPER (48 SMs), Node 20, WSL2.\n");
lines.push("- `gpu_kernel_ms` = device-only via CUDA events (post-warmup, median of 100).");
lines.push("- `gpu_e2e_ms`    = wallclock incl. one H->D copy of X and one D->H copy of Y.");
lines.push("- `cpu_ms`        = plain-JS Float32Array, median after warmup, adaptive iters.\n");
lines.push("Cells marked '—' = skipped (cpu would take >5 s) or N/A.\n");

for (const kind of ["matmul", "mlp", "softmax"]) {
  lines.push(`## ${kind}`, "");
  lines.push("| case | shape | B | cpu_ms | gpu_kernel_ms | gpu_e2e_ms | speedup (kernel) | speedup (e2e) |");
  lines.push("|---|---|---:|---:|---:|---:|---:|---:|");
  const items = sections[kind];
  items.sort((a, b) => {
    const ra = a.r, rb = b.r;
    const ca = (ra.case || `N${ra.N}`); const cb = (rb.case || `N${rb.N}`);
    if (ca !== cb) return ca.localeCompare(cb);
    return ra.B - rb.B;
  });
  for (const { c, g, r } of items) {
    const cpu_ms = c?.cpu_ms ?? null;
    const gk = g?.gpu_kernel_ms ?? null;
    const ge = g?.gpu_e2e_ms ?? null;
    let shape;
    if (kind === "matmul") shape = `${r.M}->${r.N}`;
    else if (kind === "mlp") shape = `${r.M}->${r.H}->${r.N}`;
    else shape = `N=${r.N}`;
    const caseName = r.case || `softmax_${r.N}`;
    lines.push(`| ${caseName} | ${shape} | ${r.B} | ${fmt(cpu_ms)} | ${fmt(gk)} | ${fmt(ge)} | ${speedup(cpu_ms, gk)} | ${speedup(cpu_ms, ge)} |`);
  }
  lines.push("");
}

const out = lines.join("\n");
fs.writeFileSync(new URL("./RESULTS.md", import.meta.url), out);
process.stdout.write(out);
