// Verify ORT forward+backward+SGD matches JS reference (batched semantics).
// Reference: per-sample forward + backward, accumulate grads (NOT update in-place
// per-sample), then apply once. ORT path: forwardBatch + backwardBatch + applySgd.
// Both should produce the same updated weights to within ~1e-5.

import { createHidden, hiddenForward, outputForward } from "../src/mlp.js";
import { OrtMlpSession, ortAvailable } from "../src/ortMlp.js";

const F = 18, H = 64, A = 8, B = 256;

function makeInput(B, seed) {
  let s = seed >>> 0;
  const X = new Float32Array(B * F);
  for (let i = 0; i < X.length; i += 1) {
    s = (1664525 * s + 1013904223) >>> 0;
    X[i] = (s / 0x100000000) * 2 - 1;
  }
  return X;
}

function refUpdate(hidden, outRows, outBias, X, B, dLogits, lr) {
  // Accumulate grads in flat buffers, then apply one SGD step.
  const gWh = new Float32Array(H * F);
  const gBh = new Float32Array(H);
  const gWo = new Float32Array(A * H);
  const gBo = new Float32Array(A);
  for (let s = 0; s < B; s += 1) {
    const feat = Array.from(X.subarray(s * F, s * F + F));
    const h = hiddenForward(hidden, feat);
    const dl = dLogits.subarray(s * A, s * A + A);
    // gWo[a][i] += dl[a] * h[i]; gBo[a] += dl[a]
    for (let a = 0; a < A; a += 1) {
      const v = dl[a];
      if (v === 0) continue;
      gBo[a] += v;
      for (let i = 0; i < H; i += 1) gWo[a * H + i] += v * h[i];
    }
    // dh[i] = sum_a outRows[a][i]*dl[a] * (h[i]>0)
    const dh = new Float32Array(H);
    for (let a = 0; a < A; a += 1) {
      const v = dl[a];
      if (v === 0) continue;
      const row = outRows[a];
      for (let i = 0; i < H; i += 1) dh[i] += row[i] * v;
    }
    for (let i = 0; i < H; i += 1) if (h[i] <= 0) dh[i] = 0;
    for (let i = 0; i < H; i += 1) {
      const g = dh[i];
      if (g === 0) continue;
      gBh[i] += g;
      for (let f = 0; f < F; f += 1) gWh[i * F + f] += g * feat[f];
    }
  }
  // SGD: W -= lr * grad
  for (let a = 0; a < A; a += 1) {
    for (let i = 0; i < H; i += 1) outRows[a][i] -= lr * gWo[a * H + i];
    outBias[a] -= lr * gBo[a];
  }
  for (let i = 0; i < H; i += 1) {
    for (let f = 0; f < F; f += 1) hidden.W[i][f] -= lr * gWh[i * F + f];
    hidden.b[i] -= lr * gBh[i];
  }
}

function clone(h) { return { W: h.W.map(r => [...r]), b: [...h.b], hidden: h.hidden, featureCount: h.featureCount }; }

(async () => {
  if (!(await ortAvailable())) { console.error("ORT unavailable"); process.exit(2); }
  const sess = new OrtMlpSession({ F, H, A });
  const ok = await sess.init();
  if (!ok) { console.error("session.init failed"); process.exit(2); }

  const seed = 1234;
  const hiddenA = createHidden(F, H, seed);
  const hiddenB = clone(hiddenA);
  const outA = Array.from({ length: A }, (_, a) => Array.from({ length: H }, (_, i) => 0.01 * Math.sin(a * 7 + i)));
  const outB = outA.map(r => [...r]);
  const biasA = new Array(A).fill(0.01);
  const biasB = [...biasA];

  const X = makeInput(B, 42);
  // Make a sparse-ish dLogits: pick one action per sample, value in [-1,1].
  const dLogits = new Float32Array(B * A);
  for (let s = 0; s < B; s += 1) {
    const a = s % A;
    const v = Math.sin(s * 0.31) * 0.5;
    dLogits[s * A + a] = v;
  }
  const lr = 1e-3;

  // Reference update
  refUpdate(hiddenA, outA, biasA, X, B, dLogits, lr);

  // ORT update
  const fwd = await sess.forwardBatch(X, B, hiddenB, outB, biasB);
  const grads = await sess.backwardBatch(X, B, fwd.H, outB, dLogits);
  sess.applySgd(hiddenB, outB, biasB, grads, lr);

  let maxDiff = 0;
  for (let i = 0; i < H; i += 1) {
    for (let f = 0; f < F; f += 1) {
      maxDiff = Math.max(maxDiff, Math.abs(hiddenA.W[i][f] - hiddenB.W[i][f]));
    }
    maxDiff = Math.max(maxDiff, Math.abs(hiddenA.b[i] - hiddenB.b[i]));
  }
  for (let a = 0; a < A; a += 1) {
    for (let i = 0; i < H; i += 1) {
      maxDiff = Math.max(maxDiff, Math.abs(outA[a][i] - outB[a][i]));
    }
    maxDiff = Math.max(maxDiff, Math.abs(biasA[a] - biasB[a]));
  }
  console.log(`max abs diff JS-ref vs ORT updated weights: ${maxDiff.toExponential(3)}`);
  if (maxDiff > 1e-3) {
    console.error("FAIL: diff too large");
    process.exit(1);
  }
  console.log("OK");
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
