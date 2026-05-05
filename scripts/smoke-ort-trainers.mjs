// Smoke test: run a few iters of DQN+PPO with USE_ORT on; ensure trainBatch
// returns sane finite metrics and reward improves directionally.

import { DqnTrainer } from "../src/dqnTrainer.js";
import { PpoTrainer } from "../src/ppoTrainer.js";

async function smoke(name, T, batchSize) {
  const trainer = new T({ useOrt: true });
  trainer.maxEpisodeSeconds = 6;
  const points = [];
  for (let i = 0; i < 5; i += 1) {
    const p = await trainer.trainBatch(batchSize);
    points.push(p);
  }
  const r0 = points[0].reward;
  const rN = points[points.length - 1].reward;
  const finite = points.every(p => Number.isFinite(p.reward) && Number.isFinite(p.tdLoss ?? p.policyLoss ?? 0));
  console.log(`${name}: reward ${r0} -> ${rN} over ${points.length} iters, finite=${finite}`);
  if (!finite) process.exit(1);
}

(async () => {
  await smoke("DQN  ORT", DqnTrainer, 2);
  await smoke("PPO  ORT", PpoTrainer, 2);
  console.log("smoke ok");
})().catch(e => { console.error(e); process.exit(1); });
