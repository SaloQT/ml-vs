import test from "node:test";
import assert from "node:assert/strict";

import { DqnTrainer } from "../src/dqnTrainer.js";

test("DQN smoke: trainBatch produces finite metrics over 2 iterations", () => {
  const trainer = new DqnTrainer();
  trainer.maxEpisodeSeconds = 4;
  trainer.warmupSeconds = 0;
  trainer.replayMinSize = 16;
  trainer.minibatchSize = 16;

  const first = trainer.trainBatch(2);
  const second = trainer.trainBatch(2);

  for (const point of [first, second]) {
    assert.equal(Number.isFinite(point.reward), true);
    assert.equal(Number.isFinite(point.score), true);
    assert.equal(Number.isFinite(point.kills), true);
    assert.equal(Number.isFinite(point.damage), true);
    assert.equal(Number.isFinite(point.damageTaken), true);
    assert.equal(Number.isFinite(point.seconds), true);
    assert.equal(point.deathRate >= 0 && point.deathRate <= 100, true);
    assert.equal(Number.isFinite(point.ticksPerSecond), true);
    assert.equal(Number.isFinite(point.epsilon), true);
    assert.equal(Number.isFinite(point.tdLoss), true);
  }
  assert.equal(second.iteration, 2);
});

test("DQN exportModel/importModel round-trip preserves Q-weights and history", () => {
  const trainer = new DqnTrainer();
  trainer.maxEpisodeSeconds = 4;
  trainer.warmupSeconds = 0;
  trainer.replayMinSize = 8;
  trainer.minibatchSize = 8;
  trainer.trainBatch(1);

  const model = JSON.parse(JSON.stringify(trainer.exportModel()));
  assert.equal(model.format, DqnTrainer.MODEL_FORMAT);
  assert.equal(model.version, DqnTrainer.MODEL_VERSION);
  assert.equal(model.algorithm, "DQN");
  assert.equal(typeof model.iteration, "number");
  assert.equal(Array.isArray(model.qWeights), true);
  assert.equal(Array.isArray(model.qAimWeights), true);
  assert.equal(Array.isArray(model.qUpgradeWeights), true);

  const restored = new DqnTrainer();
  restored.importModel(model);
  assert.equal(restored.iteration, trainer.iteration);
  const round = (rows) => rows.map((row) => row.map((v) => Number(v.toFixed(9))));
  assert.deepEqual(round(restored.qWeights), round(trainer.qWeights));
  assert.deepEqual(round(restored.qAimWeights), round(trainer.qAimWeights));
  assert.deepEqual(round(restored.qUpgradeWeights), round(trainer.qUpgradeWeights));
  assert.deepEqual(restored.history, trainer.history);
});

test("DQN replay buffer is ephemeral and never serialized", () => {
  const trainer = new DqnTrainer();
  trainer.maxEpisodeSeconds = 4;
  trainer.warmupSeconds = 0;
  trainer.replayMinSize = 8;
  trainer.minibatchSize = 8;
  trainer.trainBatch(1);

  assert.equal(trainer._replay.length > 0, true, "replay buffer should be populated after training");

  const exported = trainer.exportModel();
  const json = JSON.stringify(exported);
  assert.equal(json.includes("_replay"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(exported, "replay"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(exported, "_replay"), false);
});

test("DQN model import rejects incompatible model data", () => {
  const trainer = new DqnTrainer();
  assert.throws(() => trainer.importModel({ format: "wrong", version: DqnTrainer.MODEL_VERSION }), /format/);
  assert.throws(
    () => trainer.importModel({ format: DqnTrainer.MODEL_FORMAT, version: DqnTrainer.MODEL_VERSION, qWeights: [[0]] }),
    /action space/,
  );
});
