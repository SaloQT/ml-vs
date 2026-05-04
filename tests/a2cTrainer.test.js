import test from "node:test";
import assert from "node:assert/strict";

import { A2cTrainer } from "../src/a2cTrainer.js";

test("A2C smoke trains two iterations and produces finite metrics", () => {
  const trainer = new A2cTrainer();
  trainer.maxEpisodeSeconds = 4;
  trainer.warmupSeconds = 0;
  trainer.batchSize = 1;

  const first = trainer.trainBatch(1);
  const second = trainer.trainBatch(1);

  for (const point of [first, second]) {
    assert.equal(Number.isFinite(point.reward), true);
    assert.equal(Number.isFinite(point.score), true);
    assert.equal(Number.isFinite(point.seconds), true);
    assert.equal(Number.isFinite(point.deathRate), true);
    assert.equal(Number.isFinite(point.ticksPerSecond), true);
    assert.equal(Number.isFinite(point.valueLoss), true);
    assert.equal(Number.isFinite(point.entropy), true);
  }
  assert.equal(second.iteration, 2);
});

test("A2C exportModel includes value head and round-trips via importModel", () => {
  const trainer = new A2cTrainer();
  trainer.maxEpisodeSeconds = 3;
  trainer.warmupSeconds = 0;
  trainer.trainBatch(1);

  const model = trainer.exportModel();
  assert.equal(model.format, "space-survivors-a2c");
  assert.equal(model.version, 1);
  assert.equal(model.algorithm, "A2C");
  assert.equal(Array.isArray(model.valueWeights), true);
  assert.equal(model.valueWeights.length > 0, true);
  assert.equal(model.valueWeights.every(Number.isFinite), true);
  assert.equal(model.iteration, 1);
  assert.equal(typeof model.hyperparams, "object");

  const restored = new A2cTrainer();
  restored.importModel(JSON.parse(JSON.stringify(model)));

  assert.equal(restored.iteration, trainer.iteration);
  const round = (m) => JSON.parse(JSON.stringify(m.map((row) => (Array.isArray(row) ? row.map((v) => Number(v.toFixed(9))) : Number(row.toFixed(9))))));
  assert.deepEqual(round(restored.valueWeights.map((v) => v)), round(trainer.valueWeights.map((v) => v)));
  assert.deepEqual(round(restored.weights), round(trainer.weights));
  assert.deepEqual(round(restored.aimWeights), round(trainer.aimWeights));
  assert.deepEqual(round(restored.upgradeWeights), round(trainer.upgradeWeights));
});

test("A2C policy probabilities are normalized and finite", () => {
  const trainer = new A2cTrainer();
  trainer.maxEpisodeSeconds = 2;
  trainer.warmupSeconds = 0;
  const episode = trainer.runEpisode(123);
  const features = episode.trajectory.find((s) => s.kind === "move")?.features;
  assert.ok(features);
  const probs = trainer.probabilities(features);
  const aim = trainer.aimProbabilities(features);
  assert.equal(probs.every(Number.isFinite), true);
  assert.equal(aim.every(Number.isFinite), true);
  assert.equal(Number(probs.reduce((a, b) => a + b, 0).toFixed(10)), 1);
  assert.equal(Number(aim.reduce((a, b) => a + b, 0).toFixed(10)), 1);
});
