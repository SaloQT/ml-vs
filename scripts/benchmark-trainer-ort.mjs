// Bench: per-minibatch update latency JS vs ORT for the move head used by DQN/PPO.
// Also: end-to-end trainer TPS USE_ORT=0 vs USE_ORT=1.

import { performance } from "node:perf_hooks";
import { createHidden, hiddenForward, outputForward, backwardSGD } from "../src/mlp.js";
import { OrtMlpSession, ortAvailable } from "../src/ortMlp.js";
import { DqnTrainer } from "../src/dqnTrainer.js";
import { PpoTrainer } from "../src/ppoTrainer.js";

const F = 18, H = 64, A = 8;

function makeBatch(B, seed) {
  let s = seed >>> 0;
  const rand = () => { s = (1664525 * s + 1013904223) >>> 0; return s / 0x100000000; };
  const X = new Float32Array(B * F);
  for (let i = 0; i < X.length; i += 1) X[i] = rand() * 2 - 1;
  const dLogits = new Float32Array(B * A);
  for (let b = 0; b < B; b += 1) dLogits[b * A + (b % A)] = (rand() * 2 - 1) * 0.5;
  return { X, dLogits };
}

function jsMinibatchUpdate(hidden, outRows, outBias, X, B, dLogits, lr) {
  for (let s = 0; s < B; s += 1) {
    const feat = Array.from(X.subarray(s * F, s * F + F));
    const h = hiddenForward(hidden, feat);
    outputForward(outRows, h, outBias);
    const dl = Array.from(dLogits.subarray(s * A, s * A + A));
    backwardSGD(hidden, outRows, outBias, feat, h, dl, lr);
  }
}

async function ortMinibatchUpdate(session, hidden, outRows, outBias, X, B, dLogits, lr) {
  const fwd = await session.forwardBatch(X, B, hidden, outRows, outBias);
  const grads = await session.backwardBatch(X, B, fwd.H, outRows, dLogits);
  session.applySgd(hidden, outRows, outBias, grads, lr / B);
}

async function benchUpdateLatency() {
  console.log("# Per-minibatch update latency (ms median of 50, post-warmup) — F=18 H=64 A=8");
  console.log("| B | JS ms | JS samp/s | ORT ms | ORT samp/s | speedup |");
  console.log("|---|---:|---:|---:|---:|---:|");
  const sess = new OrtMlpSession({ F, H, A });
  if (!await sess.init()) { console.log("(ORT unavailable)"); return; }
  const ITERS = 50;
  const lr = 1e-4;
  for (const B of [64, 256, 512, 1024, 2048]) {
    const { X, dLogits } = makeBatch(B, 42);
    // Fresh weights per measurement so updates don't blow up
    const hiddenJs = createHidden(F, H, 1);
    const outRowsJs = Array.from({ length: A }, () => new Array(H).fill(0).map((_, i) => 0.001 * i));
    const outBiasJs = new Array(A).fill(0);
    const hiddenOrt = createHidden(F, H, 1);
    const outRowsOrt = outRowsJs.map(r => [...r]);
    const outBiasOrt = [...outBiasJs];
    // warm
    for (let i = 0; i < 5; i += 1) jsMinibatchUpdate(hiddenJs, outRowsJs, outBiasJs, X, B, dLogits, lr);
    for (let i = 0; i < 5; i += 1) await ortMinibatchUpdate(sess, hiddenOrt, outRowsOrt, outBiasOrt, X, B, dLogits, lr);
    const sJs = []; const sOrt = [];
    for (let i = 0; i < ITERS; i += 1) {
      const t0 = performance.now(); jsMinibatchUpdate(hiddenJs, outRowsJs, outBiasJs, X, B, dLogits, lr); sJs.push(performance.now() - t0);
      const t1 = performance.now(); await ortMinibatchUpdate(sess, hiddenOrt, outRowsOrt, outBiasOrt, X, B, dLogits, lr); sOrt.push(performance.now() - t1);
    }
    sJs.sort((a, b) => a - b); sOrt.sort((a, b) => a - b);
    const mJs = sJs[Math.floor(ITERS / 2)];
    const mOrt = sOrt[Math.floor(ITERS / 2)];
    console.log(`| ${B} | ${mJs.toFixed(3)} | ${(B / mJs * 1000).toFixed(0)} | ${mOrt.toFixed(3)} | ${(B / mOrt * 1000).toFixed(0)} | ${(mJs / mOrt).toFixed(2)}× |`);
  }
}

async function benchTrainerTps() {
  console.log("\n# End-to-end trainer TPS (3 warmup + 6 measured iters, batchSize=2, maxEpisodeSeconds=8)");
  console.log("| Trainer | Mode | iter ms | ticks/s |");
  console.log("|---|---|---:|---:|");
  for (const [name, T] of [["DQN", DqnTrainer], ["PPO", PpoTrainer]]) {
    for (const mode of ["js", "ort"]) {
      const trainer = new T({ useOrt: mode === "ort" });
      trainer.maxEpisodeSeconds = 8;
      // warmup
      for (let i = 0; i < 3; i += 1) await trainer.trainBatch(2);
      const t0 = performance.now();
      let ticks = 0;
      const N = 6;
      for (let i = 0; i < N; i += 1) {
        const p = await trainer.trainBatch(2);
        ticks += p.ticks;
      }
      const ms = (performance.now() - t0) / N;
      console.log(`| ${name} | ${mode} | ${ms.toFixed(0)} | ${(ticks / ((performance.now() - t0) / 1000)).toFixed(0)} |`);
    }
  }
}

(async () => {
  if (!(await ortAvailable())) { console.error("ORT unavailable"); process.exit(2); }
  await benchUpdateLatency();
  await benchTrainerTps();
})().catch(e => { console.error(e); process.exit(1); });
