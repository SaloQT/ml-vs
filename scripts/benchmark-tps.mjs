import { PpoTrainer } from "../src/ppoTrainer.js";
import { ReinforceTrainer } from "../src/reinforceTrainer.js";
import { A2cTrainer } from "../src/a2cTrainer.js";
import { DqnTrainer } from "../src/dqnTrainer.js";

const ITERS = 5;
const BATCH = 1;

const ALGOS = [
  { name: "PPO", Trainer: PpoTrainer },
  { name: "REINFORCE", Trainer: ReinforceTrainer },
  { name: "A2C", Trainer: A2cTrainer },
  { name: "DQN", Trainer: DqnTrainer },
];

for (const algo of ALGOS) {
  const trainer = new algo.Trainer();
  const tpsList = [];
  for (let i = 0; i < ITERS; i += 1) {
    const r = await trainer.trainBatch(BATCH);
    tpsList.push(r.ticksPerSecond);
  }
  const mean = tpsList.reduce((a, b) => a + b, 0) / tpsList.length;
  console.log(`${algo.name.padEnd(10)} tps=[${tpsList.join(", ")}] mean=${mean.toFixed(0)}`);
}
