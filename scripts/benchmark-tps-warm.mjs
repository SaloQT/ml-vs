import { PpoTrainer } from "../src/ppoTrainer.js";
import { ReinforceTrainer } from "../src/reinforceTrainer.js";
import { A2cTrainer } from "../src/a2cTrainer.js";
import { DqnTrainer } from "../src/dqnTrainer.js";

const WARMUP = 4;
const MEASURE = 8;
const BATCH = 1;

const ALGOS = [
  { name: "PPO", Trainer: PpoTrainer },
  { name: "REINFORCE", Trainer: ReinforceTrainer },
  { name: "A2C", Trainer: A2cTrainer },
  { name: "DQN", Trainer: DqnTrainer },
];

for (const algo of ALGOS) {
  const trainer = new algo.Trainer();
  for (let i = 0; i < WARMUP; i += 1) await trainer.trainBatch(BATCH);
  const tpsList = [];
  for (let i = 0; i < MEASURE; i += 1) {
    const r = await trainer.trainBatch(BATCH);
    tpsList.push(r.ticksPerSecond);
  }
  tpsList.sort((a, b) => a - b);
  const trimmed = tpsList.slice(1, -1);
  const mean = trimmed.reduce((a, b) => a + b, 0) / trimmed.length;
  console.log(`${algo.name.padEnd(10)} median=${tpsList[Math.floor(tpsList.length/2)]} trimmedMean=${mean.toFixed(0)} min=${tpsList[0]} max=${tpsList[tpsList.length-1]}`);
}
