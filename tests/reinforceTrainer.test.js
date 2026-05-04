import test from "node:test";
import assert from "node:assert/strict";

import { ReinforceTrainer } from "../src/reinforceTrainer.js";

test("REINFORCE trainBatch produces a finite reward and tracks history", () => {
  const trainer = new ReinforceTrainer();
  trainer.maxEpisodeSeconds = 6;
  trainer.warmupSeconds = 1;

  const first = trainer.trainBatch(2);
  const second = trainer.trainBatch(2);

  assert.equal(Number.isFinite(first.reward), true);
  assert.equal(Number.isFinite(second.reward), true);
  assert.equal(first.iteration, 1);
  assert.equal(second.iteration, 2);
  for (const key of [
    "iteration",
    "reward",
    "score",
    "kills",
    "damage",
    "damageTaken",
    "seconds",
    "deathRate",
    "ticksPerSecond",
    "elapsedMs",
  ]) {
    assert.ok(key in first, `point should include ${key}`);
  }
  assert.equal(trainer.history.length, 2);
  assert.equal(trainer.name, "REINFORCE");
});

test("REINFORCE exportModel/importModel round-trip preserves state", () => {
  const trainer = new ReinforceTrainer();
  trainer.maxEpisodeSeconds = 4;
  trainer.warmupSeconds = 1;
  trainer.trainBatch(2);

  const model = trainer.exportModel();
  assert.equal(model.format, "space-survivors-reinforce");
  assert.equal(model.version, 1);
  assert.equal(model.algorithm, "REINFORCE");
  assert.ok(model.hyperparams);

  const restored = new ReinforceTrainer();
  restored.importModel(JSON.parse(JSON.stringify(model)));

  assert.equal(restored.iteration, trainer.iteration);
  const round = (matrix) => matrix.map((row) => row.map((value) => Number(value.toFixed(9))));
  assert.deepEqual(round(restored.weights), round(trainer.weights));
  assert.deepEqual(round(restored.aimWeights), round(trainer.aimWeights));
  assert.deepEqual(round(restored.upgradeWeights), round(trainer.upgradeWeights));
  assert.deepEqual(restored.history, trainer.history);
  assert.equal(restored.baseline, trainer.baseline);
});
