// 30-iter learning smoke check for vectorized vs sequential rollout.
import { PpoTrainer } from "../src/ppoTrainer.js";
import { DqnTrainer } from "../src/dqnTrainer.js";

async function run(label, trainer, iters, batchSize) {
  trainer.maxEpisodeSeconds = 8;
  trainer.warmupSeconds = 1;
  const rewards = [];
  const t0 = performance.now();
  for (let i = 0; i < iters; i += 1) {
    const point = await trainer.trainBatch(batchSize);
    rewards.push(point.reward);
  }
  const wall = (performance.now() - t0) / 1000;
  const first3 = rewards.slice(0, 3).reduce((a, b) => a + b, 0) / 3;
  const last3 = rewards.slice(-3).reduce((a, b) => a + b, 0) / 3;
  console.log(`${label} (B=${batchSize}, ${iters} iters): first3=${first3.toFixed(1)} last3=${last3.toFixed(1)} delta=${(last3 - first3).toFixed(1)} wall=${wall.toFixed(1)}s`);
}

async function main() {
  for (const N of [2, 32, 128]) {
    const ppoSeq = new PpoTrainer({ useOrt: true });
    await run(`PPO seq N=${N}`, ppoSeq, 6, N);
    const ppoVec = new PpoTrainer({ useOrt: true });
    ppoVec.useVectorizedRollout = true;
    await run(`PPO vec N=${N}`, ppoVec, 6, N);

    const dqnSeq = new DqnTrainer({ useOrt: true });
    await run(`DQN seq N=${N}`, dqnSeq, 6, N);
    const dqnVec = new DqnTrainer({ useOrt: true });
    dqnVec.useVectorizedRollout = true;
    await run(`DQN vec N=${N}`, dqnVec, 6, N);
    console.log("");
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
