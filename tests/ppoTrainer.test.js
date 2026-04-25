import test from "node:test";
import assert from "node:assert/strict";

import { PpoTrainer } from "../src/ppoTrainer.js";
import { GameSimulation } from "../src/simulation.js";

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

function roundedUpgradeWeights(trainer) {
  return trainer.upgradeWeights.map((row) => row.map((value) => Number(value.toFixed(9))));
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

test("PPO game length hyperparameter controls episode horizon", () => {
  const trainer = new PpoTrainer();
  trainer.maxEpisodeSeconds = 10;

  const episode = trainer.runEpisode(1234);

  assert.equal(episode.seconds <= 10 + 1 / 30, true);
  assert.equal(episode.trajectory.length <= 10 * 30 + 10, true);
});

test("PPO warmup excludes early seconds from reported stats and trajectory", () => {
  const trainer = new PpoTrainer();
  trainer.maxEpisodeSeconds = 8;
  trainer.warmupSeconds = 5;

  const episode = trainer.runEpisode(1234);

  assert.equal(episode.seconds <= 8 + 1 / 30, true);
  assert.equal(episode.trajectory.length <= 8 * 30 + 10, true);
});

test("PPO XP and powerup reward hyperparameters affect episode rewards", () => {
  const baseline = new PpoTrainer();
  const pickupBiased = new PpoTrainer();
  baseline.maxEpisodeSeconds = 20;
  pickupBiased.maxEpisodeSeconds = 20;
  pickupBiased.xpReward = 1.2;
  pickupBiased.powerupReward = 4;

  assert.notEqual(
    Number(pickupBiased.runEpisode(24680).reward.toFixed(6)),
    Number(baseline.runEpisode(24680).reward.toFixed(6)),
  );
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

test("PPO observes pending upgrade choices and can choose one during watch", () => {
  const trainer = new PpoTrainer();
  const simulation = new GameSimulation({ seed: 42, localPlayerId: "ppo" });
  const player = simulation.players.get("ppo");

  simulation.gainXp(player, player.nextLevelXp);
  const observation = trainer.observation(simulation);
  const upgradeProbabilities = trainer.upgradeProbabilities(observation.upgradeChoices);

  assert.equal(simulation.state, "upgrade");
  assert.equal(observation.upgradeChoices.length, 3);
  assert.equal(observation.upgradeChoices.every((features) => features.length === trainer.upgradeWeights[0].length), true);
  assert.equal(observation.upgradeChoices.every((features) => features[0] === 1), true);
  assert.equal(upgradeProbabilities.every(Number.isFinite), true);
  assert.equal(Number(upgradeProbabilities.reduce((sum, value) => sum + value, 0).toFixed(12)), 1);

  trainer.act(simulation);

  assert.equal(simulation.state, "playing");
  assert.equal(simulation.pendingUpgradeChoices.length, 0);
  assert.equal(player.ownedUpgrades.size, 1);
});

test("PPO models export and import trained weights and history", () => {
  const trained = new PpoTrainer();
  trained.trainBatch(2);
  const model = trained.exportModel();
  const restored = new PpoTrainer();

  restored.importModel(JSON.parse(JSON.stringify(model)));

  assert.equal(model.format, PpoTrainer.MODEL_FORMAT);
  assert.equal(model.version, PpoTrainer.MODEL_VERSION);
  assert.equal(restored.iteration, trained.iteration);
  assert.deepEqual(roundedWeights(restored), roundedWeights(trained));
  assert.deepEqual(roundedUpgradeWeights(restored), roundedUpgradeWeights(trained));
  assert.deepEqual(restored.history, trained.history);
  assert.deepEqual(episodeSummary(restored.runEpisode(24680)), episodeSummary(trained.runEpisode(24680)));
});

test("PPO model import rejects incompatible model data", () => {
  const trainer = new PpoTrainer();

  assert.throws(() => trainer.importModel({ format: "wrong", version: PpoTrainer.MODEL_VERSION }), /format/);
  assert.throws(
    () => trainer.importModel({ format: PpoTrainer.MODEL_FORMAT, version: PpoTrainer.MODEL_VERSION, weights: [[0]] }),
    /action space/,
  );
});
