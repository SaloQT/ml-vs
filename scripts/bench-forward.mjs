// Microbenchmark: hidden-64 forward at B=1 across variants.
// Compares: current JS (array-of-arrays), tight JS (flat F32, fused), ORT B=1.

import { createHidden, hiddenForward, outputForward } from "../src/mlp.js";
import { forwardFastJs, softmaxInto } from "../src/mlpFast.js";

const F = 18;
const H = 64;
const A = 9;
const ITERS = 200_000;

const hidden = createHidden(F, H, 1234);
// Build a fake outRows (A x H) like trainers do.
const outRows = Array.from({ length: A }, (_, a) => {
  const row = new Array(H);
  for (let i = 0; i < H; i += 1) row[i] = Math.sin(a * 31 + i) * 0.1;
  return row;
});
const outBias = new Array(A).fill(0).map((_, i) => 0.01 * i);

const features = new Array(F);
for (let i = 0; i < F; i += 1) features[i] = Math.cos(i) * 0.5;
const hScratch = new Array(H);
const outScratch = new Array(A);
const probsScratch = new Array(A);

// Warmup
for (let i = 0; i < 5_000; i += 1) {
  const h = hiddenForward(hidden, features);
  outputForward(outRows, h, outBias);
  forwardFastJs(hidden, outRows, outBias, features, hScratch, outScratch);
}

function timeIt(label, fn) {
  const t0 = process.hrtime.bigint();
  fn();
  const t1 = process.hrtime.bigint();
  const ns = Number(t1 - t0);
  const perCall = ns / ITERS;
  console.log(`${label.padEnd(28)} total=${(ns / 1e6).toFixed(2)}ms  per-call=${perCall.toFixed(2)}ns  (${(1e9 / perCall).toFixed(0)} calls/s)`);
}

timeIt("current JS (arr-of-arr)", () => {
  let s = 0;
  for (let i = 0; i < ITERS; i += 1) {
    const h = hiddenForward(hidden, features);
    const o = outputForward(outRows, h, outBias);
    s += o[0];
  }
  if (Number.isNaN(s)) console.log(s);
});

timeIt("fast JS (preallocated buf)", () => {
  let s = 0;
  for (let i = 0; i < ITERS; i += 1) {
    forwardFastJs(hidden, outRows, outBias, features, hScratch, outScratch);
    s += outScratch[0];
  }
  if (Number.isNaN(s)) console.log(s);
});

// With softmax (matches probabilities() / aimProbabilities()).
timeIt("current JS + softmax", () => {
  let s = 0;
  for (let i = 0; i < ITERS; i += 1) {
    const h = hiddenForward(hidden, features);
    const o = outputForward(outRows, h, outBias);
    // mimic softmaxLogits
    let mx = -Infinity;
    for (let k = 0; k < A; k++) if (o[k] > mx) mx = o[k];
    let total = 0;
    for (let k = 0; k < A; k++) { o[k] = Math.exp(o[k] - mx); total += o[k]; }
    for (let k = 0; k < A; k++) o[k] /= total;
    s += o[0];
  }
  if (Number.isNaN(s)) console.log(s);
});
timeIt("fast JS + softmax-into", () => {
  let s = 0;
  for (let i = 0; i < ITERS; i += 1) {
    forwardFastJs(hidden, outRows, outBias, features, hScratch, outScratch);
    softmaxInto(outScratch, probsScratch);
    s += probsScratch[0];
  }
  if (Number.isNaN(s)) console.log(s);
});

// Numerical check.
{
  const h = hiddenForward(hidden, features);
  const o = outputForward(outRows, h, outBias);
  forwardFastJs(hidden, outRows, outBias, features, hScratch, outScratch);
  let maxDiff = 0;
  for (let i = 0; i < A; i += 1) {
    const d = Math.abs(o[i] - outScratch[i]);
    if (d > maxDiff) maxDiff = d;
  }
  console.log(`numerical max abs diff vs current: ${maxDiff.toExponential(2)}`);
}

// Optional: ORT B=1 (only if env says so; spinning up sessions is slow).
if (process.env.BENCH_ORT === "1") {
  const ort = await import("../src/ortMlp.js");
  const session = await ort.createOrtMlp({ F, H, A });
  const wFlat = new Float32Array(H * F);
  for (let i = 0; i < H; i += 1) for (let j = 0; j < F; j += 1) wFlat[i * F + j] = hidden.W[i][j];
  const bFlat = new Float32Array(hidden.b);
  const oFlat = new Float32Array(A * H);
  for (let a = 0; a < A; a += 1) for (let i = 0; i < H; i += 1) oFlat[a * H + i] = outRows[a][i];
  const oBias = new Float32Array(outBias);
  const ITERS_ORT = 5_000;
  const xBuf = new Float32Array(F);
  for (let i = 0; i < F; i += 1) xBuf[i] = features[i];
  // warmup
  for (let i = 0; i < 50; i += 1) await session.forward(xBuf, wFlat, bFlat, oFlat, oBias, 1);
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < ITERS_ORT; i += 1) await session.forward(xBuf, wFlat, bFlat, oFlat, oBias, 1);
  const t1 = process.hrtime.bigint();
  const ns = Number(t1 - t0);
  console.log(`ORT B=1                       total=${(ns / 1e6).toFixed(2)}ms  per-call=${(ns / ITERS_ORT).toFixed(0)}ns`);
}
