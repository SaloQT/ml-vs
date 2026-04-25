import test from "node:test";
import assert from "node:assert/strict";

import { PpoTrainer } from "../src/ppoTrainer.js";

function episodeSummary(episode) {
  return {
    reward: Number(episode.reward.toFixed(6)),
    seconds: Number(episode.seconds.toFixed(6)),
    kills: episode.kills,
    damageDealt: Number(episode.damageDealt.toFixed(6)),
    damageTaken: Number(episode.damageTaken.toFixed(6)),
    dead: episode.dead,
    score: Number(episode.score.toFixed(6)),
    trajectoryLength: episode.trajectory.length,
    firstAction: episode.trajectory[0]?.action,
    lastAction: episode.trajectory.at(-1)?.action,
  };
}

function batchSummary(point) {
  return {
    iteration: point.iteration,
    reward: point.reward,
    seconds: point.seconds,
    kills: point.kills,
    damage: point.damage,
    damageTaken: point.damageTaken,
    score: point.score,
    deathRate: point.deathRate,
    episodes: point.episodes,
    ticks: point.ticks,
  };
}

function roundedWeights(trainer) {
  return trainer.weights.map((row) => row.map((value) => Number(value.toFixed(9))));
}

test("PPO episodes are deterministic for fixed seeds", () => {
  const firstTrainer = new PpoTrainer();
  const secondTrainer = new PpoTrainer();

  assert.deepEqual(episodeSummary(firstTrainer.runEpisode(24680)), episodeSummary(secondTrainer.runEpisode(24680)));
  assert.notDeepEqual(episodeSummary(firstTrainer.runEpisode(24680)), episodeSummary(secondTrainer.runEpisode(13579)));
});

test("PPO trainBatch is deterministic apart from wall-clock throughput", () => {
  const firstTrainer = new PpoTrainer();
  const secondTrainer = new PpoTrainer();

  const firstPoint = firstTrainer.trainBatch(2);
  const secondPoint = secondTrainer.trainBatch(2);

  assert.deepEqual(batchSummary(firstPoint), batchSummary(secondPoint));
  assert.deepEqual(roundedWeights(firstTrainer), roundedWeights(secondTrainer));
  assert.equal(firstPoint.ticksPerSecond > 0, true);
});

test("PPO feature and policy outputs stay finite and normalized", () => {
  const trainer = new PpoTrainer();
  const episode = trainer.runEpisode(11223);
  const features = episode.trajectory[0].features;
  const probabilities = trainer.probabilities(features);

  assert.equal(features.length, trainer.weights[0].length);
  assert.equal(features.every(Number.isFinite), true);
  assert.equal(probabilities.every(Number.isFinite), true);
  assert.equal(Number(probabilities.reduce((sum, value) => sum + value, 0).toFixed(12)), 1);
});
