// Sweep high N for PPO vectorized rollout — find where it tops out.
import { PpoTrainer } from "../src/ppoTrainer.js";

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

async function rolloutBench() {
  console.log("=== PPO rollout-only TPS (12s episodes) ===");
  console.log("   N | seq TPS | vec TPS | speedup | seq ms | vec ms");
  for (const N of [128, 256, 384, 512, 768, 1024, 1536, 2048]) {
    const seqT = new PpoTrainer({ useOrt: true });
    seqT.maxEpisodeSeconds = 12; seqT.warmupSeconds = 1;
    const vecT = new PpoTrainer({ useOrt: true });
    vecT.maxEpisodeSeconds = 12; vecT.warmupSeconds = 1;
    vecT.useVectorizedRollout = true;
    await vecT.runEpisodeBatchVectorized([1]); // warmup ORT
    const seeds = Array.from({ length: N }, (_, i) => 9000 + i);
    const seq = await timeIt(() => seqT.runEpisodeBatch(seeds));
    const vec = await timeIt(() => vecT.runEpisodeBatchVectorized(seeds));
    const seqTps = Math.round(ticks(seq.result) / (seq.ms / 1000));
    const vecTps = Math.round(ticks(vec.result) / (vec.ms / 1000));
    const sp = (vecTps / Math.max(1, seqTps)).toFixed(2);
    console.log(`${String(N).padStart(4)} | ${String(seqTps).padStart(7)} | ${String(vecTps).padStart(7)} | ${sp.padStart(6)}x | ${seq.ms.toFixed(0).padStart(6)} | ${vec.ms.toFixed(0).padStart(6)}`);
  }
}

async function fullIterBench() {
  console.log("\n=== PPO full-iter wall (4 iters, 8s episodes, vectorized) ===");
  console.log("   N | wall (s) | iter (s) | reward last");
  for (const N of [128, 256, 512, 1024, 2048]) {
    const t = new PpoTrainer({ useOrt: true });
    t.maxEpisodeSeconds = 8;
    t.warmupSeconds = 1;
    t.useVectorizedRollout = true;
    await t.trainBatch(N); // warmup
    const t0 = performance.now();
    let lastReward = 0;
    for (let i = 0; i < 4; i += 1) {
      const p = await t.trainBatch(N);
      lastReward = p.reward;
    }
    const wall = (performance.now() - t0) / 1000;
    console.log(`${String(N).padStart(4)} | ${wall.toFixed(2).padStart(8)} | ${(wall / 4).toFixed(2).padStart(8)} | ${lastReward}`);
  }
}

async function main() {
  await rolloutBench();
  await fullIterBench();
}

main().catch((e) => { console.error(e); process.exit(1); });
