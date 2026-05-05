// End-to-end TPS comparison: sequential runEpisodeBatch vs runEpisodeBatchVectorized.
// Reports ticks-per-second and per-tick batched-forward latency for PPO and DQN
// at batchSize ∈ {2,4,8,16}, with ORT enabled.

import { PpoTrainer } from "../src/ppoTrainer.js";
import { DqnTrainer } from "../src/dqnTrainer.js";

const STEP_HZ = 60;

async function timeIt(fn) {
  const t0 = performance.now();
  const result = await fn();
  return { ms: performance.now() - t0, result };
}

function ticks(eps) {
  let t = 0;
  for (const e of eps) t += Math.round(e.seconds * STEP_HZ);
  return t;
}

async function benchTrainer(label, makeTrainer, sizes) {
  console.log(`\n=== ${label} ===`);
  console.log("size | sequential TPS | vectorized TPS | speedup | seq ms | vec ms");
  for (const N of sizes) {
    const seqT = makeTrainer();
    seqT.maxEpisodeSeconds = 12; // shorter for benchmark
    seqT.warmupSeconds = 1;
    const vecT = makeTrainer();
    vecT.maxEpisodeSeconds = 12;
    vecT.warmupSeconds = 1;
    vecT.useVectorizedRollout = true;
    // Warmup ORT init (vectorized path only).
    await vecT.runEpisodeBatchVectorized([1]);

    const seeds = Array.from({ length: N }, (_, i) => 9000 + i);
    const seq = await timeIt(() => seqT.runEpisodeBatch(seeds));
    const vec = await timeIt(() => vecT.runEpisodeBatchVectorized(seeds));
    const seqTps = Math.round(ticks(seq.result) / (seq.ms / 1000));
    const vecTps = Math.round(ticks(vec.result) / (vec.ms / 1000));
    const speedup = (vecTps / Math.max(1, seqTps)).toFixed(2);
    console.log(
      `${String(N).padStart(4)} | ${String(seqTps).padStart(14)} | ${String(vecTps).padStart(14)} | ${speedup.padStart(7)}x | ${seq.ms.toFixed(0).padStart(6)} | ${vec.ms.toFixed(0).padStart(6)}`,
    );
  }
}

async function measureForwardLatency(N) {
  const t = new PpoTrainer({ useGpu: false, useOrt: true });
  await t._ensureOrtSessions();
  const F = 18;
  const X = new Float32Array(N * F);
  for (let i = 0; i < X.length; i += 1) X[i] = (i % 7) * 0.1;
  // Warmup
  for (let i = 0; i < 5; i += 1) await t._ortMove.forwardBatch(X, N, t.moveHidden, t.weights, t.weightsBias);
  const iters = 200;
  const t0 = performance.now();
  for (let i = 0; i < iters; i += 1) {
    await t._ortMove.forwardBatch(X, N, t.moveHidden, t.weights, t.weightsBias);
  }
  const us = ((performance.now() - t0) / iters) * 1000;
  return us;
}

async function main() {
  const sizes = [4, 8, 16, 32, 64, 128, 256];
  await benchTrainer("PPO", () => new PpoTrainer({ useGpu: false, useOrt: true }), sizes);
  await benchTrainer("DQN", () => new DqnTrainer({ useGpu: false, useOrt: true }), sizes);

  console.log("\n=== Per-batched-forward latency (move head, B=N) ===");
  console.log("   B | latency (us) | per-sample ns");
  for (const B of [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024]) {
    const us = await measureForwardLatency(B);
    const perSample = (us * 1000) / B;
    console.log(`${String(B).padStart(4)} | ${us.toFixed(1).padStart(12)} | ${perSample.toFixed(0).padStart(12)}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
