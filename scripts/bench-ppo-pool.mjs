// Benchmark PPO worker-pool stacking: N worker threads x M vec envs each.
//
// Sweeps (W, M) at fixed batchSize. Reports rollout TPS and full-iter wall.
import { PpoTrainer } from "../src/ppoTrainer.js";
import { PpoNodeWorkerPool } from "../src/ppoNodeWorkerPool.js";

const STEP_HZ = 60;

function ticks(eps) {
  let t = 0;
  for (const e of eps) t += Math.round(e.seconds * STEP_HZ);
  return t;
}

async function timeIt(fn) {
  const t0 = performance.now();
  const result = await fn();
  return { ms: performance.now() - t0, result };
}

async function rolloutRow({ W, M, batchSize, episodeSeconds }) {
  const trainer = new PpoTrainer();
  trainer.maxEpisodeSeconds = episodeSeconds;
  trainer.warmupSeconds = 1;
  trainer.useVectorizedRollout = true;
  if (W === 1) {
    // single-thread vec or seq
    const seeds = trainer.batchSeeds(batchSize);
    if (M === 0) {
      // sequential, no vec
      trainer.useVectorizedRollout = false;
      // warmup
      await trainer.runEpisodeBatch(seeds.slice(0, 8));
      const r = await timeIt(() => trainer.runEpisodeBatch(seeds));
      return { tps: Math.round(ticks(r.result) / (r.ms / 1000)), ms: r.ms };
    }
    // single-thread vec — warmup ORT
    await trainer.runEpisodeBatchVectorized([1]);
    const r = await timeIt(() => trainer.runEpisodeBatchVectorized(seeds));
    return { tps: Math.round(ticks(r.result) / (r.ms / 1000)), ms: r.ms };
  }
  const pool = new PpoNodeWorkerPool({ workerCount: W });
  // warmup: run small batch first so each worker initializes ORT
  await pool.runEpisodes(trainer, W * 2);
  const r = await timeIt(() => pool.runEpisodes(trainer, batchSize));
  pool.terminate();
  return { tps: Math.round(ticks(r.result.episodes) / (r.ms / 1000)), ms: r.ms };
}

async function fullIterRow({ W, M, batchSize, episodeSeconds, iters = 4 }) {
  const trainer = new PpoTrainer();
  trainer.maxEpisodeSeconds = episodeSeconds;
  trainer.warmupSeconds = 1;
  trainer.useVectorizedRollout = M > 0;
  let pool = null;
  if (W > 1) pool = new PpoNodeWorkerPool({ workerCount: W });
  // warmup
  if (pool) await pool.trainBatch(trainer, batchSize);
  else await trainer.trainBatch(batchSize);
  const t0 = performance.now();
  let last = null;
  for (let i = 0; i < iters; i += 1) {
    last = pool ? await pool.trainBatch(trainer, batchSize) : await trainer.trainBatch(batchSize);
  }
  const wall = (performance.now() - t0) / 1000;
  if (pool) pool.terminate();
  return { wall, perIter: wall / iters, reward: last?.reward ?? 0, tps: last?.ticksPerSecond ?? 0 };
}

async function sweep(batchSize, episodeSeconds) {
  console.log(`\n=== batchSize=${batchSize}, episode=${episodeSeconds}s ===`);
  console.log("config                     | rollout TPS | rollout ms | iter s | reward");
  console.log("---------------------------|-------------|-----------:|-------:|-------");
  const configs = [
    { label: "W=1 seq           ", W: 1, M: 0 },
    { label: "W=1 vec M=full    ", W: 1, M: batchSize },
    { label: "W=2 vec M=full/2  ", W: 2, M: Math.ceil(batchSize / 2) },
    { label: "W=4 vec M=full/4  ", W: 4, M: Math.ceil(batchSize / 4) },
    { label: "W=8 vec M=full/8  ", W: 8, M: Math.ceil(batchSize / 8) },
  ];
  for (const c of configs) {
    if (c.W * c.M < batchSize && c.M > 0) continue;
    try {
      const ro = await rolloutRow({ ...c, batchSize, episodeSeconds });
      const fi = await fullIterRow({ ...c, batchSize, episodeSeconds, iters: 3 });
      console.log(
        `${c.label} | ${String(ro.tps).padStart(11)} | ${ro.ms.toFixed(0).padStart(10)} | ${fi.perIter.toFixed(2).padStart(6)} | ${fi.reward}`,
      );
    } catch (e) {
      console.log(`${c.label} | ERROR: ${e.message}`);
    }
  }
}

async function sweepFixedM(M, episodeSeconds) {
  console.log(`\n=== fixed M=${M} per worker, episode=${episodeSeconds}s ===`);
  console.log("config              | batch | rollout TPS | rollout ms | iter s");
  for (const W of [1, 2, 4, 8, 12, 16]) {
    const batchSize = W * M;
    const c = { label: `W=${W} M=${M}`.padEnd(18), W, M };
    try {
      const ro = await rolloutRow({ ...c, batchSize, episodeSeconds });
      const fi = await fullIterRow({ ...c, batchSize, episodeSeconds, iters: 3 });
      console.log(`${c.label} | ${String(batchSize).padStart(5)} | ${String(ro.tps).padStart(11)} | ${ro.ms.toFixed(0).padStart(10)} | ${fi.perIter.toFixed(2).padStart(6)}`);
    } catch (e) {
      console.log(`${c.label} | ERROR: ${e.message}`);
    }
  }
}

async function main() {
  await sweep(256, 8);
  await sweep(1024, 8);
  // Pin per-worker M near sweet spot, vary W (batchSize scales W*M)
  await sweepFixedM(256, 8);
  await sweepFixedM(128, 8);
  await sweepFixedM(64, 8);
}

main().catch((e) => { console.error(e); process.exit(1); });
