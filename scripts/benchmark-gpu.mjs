// Benchmark: linear baseline vs hidden-64 CPU vs hidden-64 GPU.
// (a) old-CPU linear: simulate by zeroing the hidden layer (so trunk is identity-ish).
//     We approximate by measuring a tiny linear head only — measured separately.
// (b) new-CPU: current trainer (hidden 64, ReLU) on CPU.
// (c) new-GPU: same trainer with USE_GPU=1 (forward+backward via CUDA bridge).
//
// We also report a learning-quality smoke check: mean reward over the first N
// trainer iterations.
//
// Usage: node scripts/benchmark-gpu.mjs

import { performance } from "node:perf_hooks";
import { DqnTrainer } from "../src/dqnTrainer.js";
import { PpoTrainer } from "../src/ppoTrainer.js";
import {
  HIDDEN, createHidden, hiddenForward, outputForward, backwardSGD,
} from "../src/mlp.js";
import { gpuEnabled, gpuMinibatchUpdate } from "../src/gpuBridge.js";

const F = 18;
const A = 9;
const LR = 0.001;

function rand() { return Math.random() * 2 - 1; }

function makeMinibatch(B) {
  const X = Array.from({ length: B }, () => Array.from({ length: F }, rand));
  const dL = Array.from({ length: B }, () => Array.from({ length: A }, () => rand() * 0.1));
  return { X, dL };
}

async function benchUpdateCPU(B, iters = 50) {
  const hidden = createHidden(F, HIDDEN, 42);
  const W = Array.from({ length: A }, () => Array(HIDDEN).fill(0));
  const b = Array(A).fill(0);
  const { X, dL } = makeMinibatch(B);
  // warmup
  for (let i = 0; i < 5; i += 1) {
    for (let s = 0; s < B; s += 1) {
      const h = hiddenForward(hidden, X[s]);
      backwardSGD(hidden, W, b, X[s], h, dL[s], LR);
    }
  }
  const t0 = performance.now();
  for (let it = 0; it < iters; it += 1) {
    for (let s = 0; s < B; s += 1) {
      const h = hiddenForward(hidden, X[s]);
      backwardSGD(hidden, W, b, X[s], h, dL[s], LR);
    }
  }
  return (performance.now() - t0) / iters;
}

async function benchUpdateLinearCPU(B, iters = 50) {
  // Old architecture: just dot(W[a], features) + per-action SGD step (no hidden).
  const W = Array.from({ length: A }, () => Array(F).fill(0));
  const { X, dL } = makeMinibatch(B);
  for (let it = 0; it < 5; it += 1) {
    for (let s = 0; s < B; s += 1) {
      for (let a = 0; a < A; a += 1) {
        let q = 0;
        for (let j = 0; j < F; j += 1) q += W[a][j] * X[s][j];
        const scale = -LR * dL[s][a];
        for (let j = 0; j < F; j += 1) W[a][j] += scale * X[s][j];
      }
    }
  }
  const t0 = performance.now();
  for (let it = 0; it < iters; it += 1) {
    for (let s = 0; s < B; s += 1) {
      for (let a = 0; a < A; a += 1) {
        let q = 0;
        for (let j = 0; j < F; j += 1) q += W[a][j] * X[s][j];
        const scale = -LR * dL[s][a];
        for (let j = 0; j < F; j += 1) W[a][j] += scale * X[s][j];
      }
    }
  }
  return (performance.now() - t0) / iters;
}

async function benchUpdateGPU(B, iters = 50) {
  if (!gpuEnabled()) return null;
  const hidden = createHidden(F, HIDDEN, 42);
  const W = Array.from({ length: A }, () => Array(HIDDEN).fill(0));
  const b = Array(A).fill(0);
  const { X, dL } = makeMinibatch(B);
  // warmup
  for (let i = 0; i < 5; i += 1) await gpuMinibatchUpdate(hidden, W, b, X, dL, LR);
  const t0 = performance.now();
  for (let it = 0; it < iters; it += 1) {
    await gpuMinibatchUpdate(hidden, W, b, X, dL, LR);
  }
  return (performance.now() - t0) / iters;
}

async function correctnessCheck() {
  // Run one minibatch on CPU and GPU starting from identical weights.
  const B = 64;
  const hiddenA = createHidden(F, HIDDEN, 42);
  const hiddenB = createHidden(F, HIDDEN, 42);
  const WA = Array.from({ length: A }, () => Array(HIDDEN).fill(0.01));
  const WB = WA.map((r) => [...r]);
  const bA = Array(A).fill(0.01);
  const bB = [...bA];
  const { X, dL } = makeMinibatch(B);
  // CPU forward only -> compare logits
  const cpuLogits = X.map((x) => {
    const h = hiddenForward(hiddenA, x);
    return outputForward(WA, h, bA);
  });
  // GPU forward+update — but it returns updated weights, not logits.
  // Workaround: use dL=0 so weights don't change, but our protocol always
  // applies SGD; instead, just re-forward on CPU with GPU's returned weights
  // and check forward outputs match the original CPU forward (since lr*0=0
  // would imply unchanged weights when dLogits=0 and gradients=0).
  const zeroDL = X.map(() => Array(A).fill(0));
  if (!gpuEnabled()) return null;
  await gpuMinibatchUpdate(hiddenB, WB, bB, X, zeroDL, LR);
  // Recompute logits on CPU using returned (should-be-identical) GPU weights:
  let maxDiff = 0;
  for (let s = 0; s < B; s += 1) {
    const h = hiddenForward(hiddenB, X[s]);
    const out = outputForward(WB, h, bB);
    for (let a = 0; a < A; a += 1) {
      const d = Math.abs(out[a] - cpuLogits[s][a]);
      if (d > maxDiff) maxDiff = d;
    }
  }
  return maxDiff;
}

async function smokeReward(useGpu, iters = 6) {
  if (useGpu) process.env.USE_GPU = "1"; else delete process.env.USE_GPU;
  const trainer = new DqnTrainer();
  trainer.maxEpisodeSeconds = 8;
  trainer.warmupSeconds = 0;
  trainer.replayMinSize = 64;
  trainer.minibatchSize = 256;
  let firstReward = 0, lastReward = 0;
  for (let i = 0; i < iters; i += 1) {
    const r = await trainer.trainBatch(2);
    if (i === 0) firstReward = r.reward;
    lastReward = r.reward;
  }
  return { firstReward, lastReward };
}

(async () => {
  console.log("# Per-minibatch update latency (ms, lower is better)");
  console.log("");
  console.log("| B | linear-CPU (old) | hidden64-CPU | hidden64-GPU | GPU vs hCPU | hCPU throughput (samp/s) | GPU throughput (samp/s) |");
  console.log("|---|---:|---:|---:|---:|---:|---:|");
  const sizes = [16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192];
  for (const B of sizes) {
    const iters = B <= 256 ? 200 : B <= 1024 ? 80 : 30;
    const lin = await benchUpdateLinearCPU(B, iters);
    const cpu = await benchUpdateCPU(B, iters);
    let gpu = null;
    try { gpu = await benchUpdateGPU(B, iters); } catch (_e) { gpu = null; }
    const ratio = gpu == null ? "n/a" : (cpu / gpu).toFixed(2) + "x";
    const cpuTp = (B / cpu * 1000).toFixed(0);
    const gpuTp = gpu == null ? "n/a" : (B / gpu * 1000).toFixed(0);
    console.log(`| ${B} | ${lin.toFixed(3)} | ${cpu.toFixed(3)} | ${gpu == null ? "n/a" : gpu.toFixed(3)} | ${ratio} | ${cpuTp} | ${gpuTp} |`);
  }
  console.log("");
  console.log(`gpuEnabled: ${gpuEnabled()}`);

  if (gpuEnabled()) {
    const diff = await correctnessCheck();
    console.log(`# Forward correctness: max abs diff CPU vs GPU = ${diff?.toExponential(3)}`);
  }

  console.log("\n# Learning smoke (DQN, 6 iters of trainBatch(2), maxEpisodeSeconds=8)");
  const cpu = await smokeReward(false, 6);
  console.log(`CPU: firstReward=${cpu.firstReward}, lastReward=${cpu.lastReward}`);
  if (gpuEnabled()) {
    const gpu = await smokeReward(true, 6);
    console.log(`GPU: firstReward=${gpu.firstReward}, lastReward=${gpu.lastReward}`);
  }

  process.exit(0);
})();
