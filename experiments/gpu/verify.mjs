// Read verify_data.bin (GPU output) and compare to a CPU recompute.
import fs from "node:fs";
const buf = fs.readFileSync(new URL("./verify_data.bin", import.meta.url));
let off = 0;
const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
const numCases = dv.getInt32(off, true); off += 4;
console.log(`Cases: ${numCases}`);

for (let c = 0; c < numCases; c++) {
  const B = dv.getInt32(off, true); off += 4;
  const M = dv.getInt32(off, true); off += 4;
  const N = dv.getInt32(off, true); off += 4;
  const X = new Float32Array(buf.buffer, buf.byteOffset + off, B * M); off += B * M * 4;
  const W = new Float32Array(buf.buffer, buf.byteOffset + off, N * M); off += N * M * 4;
  const Yg = new Float32Array(buf.buffer, buf.byteOffset + off, B * N); off += B * N * 4;

  const Yc = new Float32Array(B * N);
  for (let b = 0; b < B; b++) {
    for (let n = 0; n < N; n++) {
      let s = 0;
      for (let m = 0; m < M; m++) s += X[b * M + m] * W[n * M + m];
      Yc[b * N + n] = s;
    }
  }
  let maxAbs = 0, maxRel = 0;
  for (let i = 0; i < Yc.length; i++) {
    const d = Math.abs(Yg[i] - Yc[i]);
    if (d > maxAbs) maxAbs = d;
    const r = d / Math.max(1e-6, Math.abs(Yc[i]));
    if (r > maxRel) maxRel = r;
  }
  console.log(`B=${B} M=${M} N=${N}  maxAbsDiff=${maxAbs.toExponential(3)}  maxRelDiff=${maxRel.toExponential(3)}  pass<1e-3: ${maxAbs < 1e-3 ? "YES" : "NO"}`);
}
