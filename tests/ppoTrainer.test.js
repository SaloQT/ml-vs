import test from "node:test";
import assert from "node:assert/strict";

import { GAME } from "../src/config.js";
import { createEnemy } from "../src/entities.js";
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

function roundedAimWeights(trainer) {
  return trainer.aimWeights.map((row) => row.map((value) => Number(value.toFixed(9))));
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

test("PPO can train from externally rolled out episodes", () => {
  const directTrainer = new PpoTrainer();
  const splitTrainer = new PpoTrainer();

  const directPoint = directTrainer.trainBatch(3);
  const episodes = splitTrainer.runEpisodeBatch(splitTrainer.batchSeeds(3));
  const splitPoint = splitTrainer.trainBatchFromEpisodes(episodes, 1);

  assert.deepEqual(batchSummary(splitPoint), batchSummary(directPoint));
  assert.deepEqual(roundedWeights(splitTrainer), roundedWeights(directTrainer));
  assert.deepEqual(roundedAimWeights(splitTrainer), roundedAimWeights(directTrainer));
  assert.deepEqual(roundedUpgradeWeights(splitTrainer), roundedUpgradeWeights(directTrainer));
});

test("PPO training state carries weights, meta progress, and hyperparameters to workers", () => {
  const trainer = new PpoTrainer({ metaProgress: { scrap: 12 } });
  trainer.learningRate = 0.001;
  trainer.maxEpisodeSeconds = 17;
  trainer.filterDeathEpisodes = true;
  trainer.trainBatch(1);

  const restored = new PpoTrainer().importTrainingState(JSON.parse(JSON.stringify(trainer.exportTrainingState())));

  assert.equal(restored.metaProgress.scrap, 12);
  assert.equal(restored.learningRate, 0.001);
  assert.equal(restored.maxEpisodeSeconds, 17);
  assert.equal(restored.filterDeathEpisodes, true);
  assert.deepEqual(roundedWeights(restored), roundedWeights(trainer));
  assert.deepEqual(roundedAimWeights(restored), roundedAimWeights(trainer));
  assert.deepEqual(roundedUpgradeWeights(restored), roundedUpgradeWeights(trainer));
});

test("PPO can exclude death episodes from policy updates while keeping batch stats", () => {
  const trainer = new PpoTrainer();
  const episodes = [
    { reward: -20, seconds: 5, kills: 0, damageDealt: 0, damageTaken: 30, score: -10, dead: true, trajectory: [] },
    { reward: 40, seconds: 12, kills: 2, damageDealt: 120, damageTaken: 0, score: 240, dead: false, trajectory: [] },
  ];
  const trainedEpisodes = [];
  trainer.filterDeathEpisodes = true;
  trainer.runEpisode = (seed) => episodes[seed - 9000];
  trainer.updatePolicy = (batch) => {
    trainedEpisodes.push(...batch);
  };

  const point = trainer.trainBatch(2);

  assert.deepEqual(trainedEpisodes, [episodes[1]]);
  assert.equal(point.episodes, 2);
  assert.equal(point.trainedEpisodes, 1);
  assert.equal(point.deathRate, 50);
});

test("PPO game length hyperparameter controls episode horizon", () => {
  const trainer = new PpoTrainer();
  trainer.maxEpisodeSeconds = 10;

  const episode = trainer.runEpisode(1234);

  assert.equal(episode.seconds <= 10 + GAME.fixedStep, true);
  assert.equal(episode.trajectory.length <= 10 * Math.round(1 / GAME.fixedStep) * 2 + 10, true);
});

test("PPO treats normal run victory as terminal before long horizons", () => {
  const previousNormalRunSeconds = GAME.normalRunSeconds;
  const previousOverrunStartsAt = GAME.overrunStartsAt;
  GAME.normalRunSeconds = 1;
  GAME.overrunStartsAt = 1;
  try {
    const trainer = new PpoTrainer();
    trainer.maxEpisodeSeconds = 10;
    trainer.warmupSeconds = 0;

    const episode = trainer.runEpisode(1234);

    assert.equal(episode.victory, true);
    assert.equal(episode.outcome, "victory");
    assert.equal(episode.dead, false);
    assert.equal(episode.seconds <= 1 + GAME.fixedStep, true);
  } finally {
    GAME.normalRunSeconds = previousNormalRunSeconds;
    GAME.overrunStartsAt = previousOverrunStartsAt;
  }
});

test("PPO warmup excludes early seconds from reported stats and trajectory", () => {
  const trainer = new PpoTrainer();
  trainer.maxEpisodeSeconds = 8;
  trainer.warmupSeconds = 5;

  const episode = trainer.runEpisode(1234);

  assert.equal(episode.seconds <= 8 + GAME.fixedStep, true);
  assert.equal(episode.trajectory.length <= 8 * Math.round(1 / GAME.fixedStep) * 2 + 10, true);
});

test("PPO rollouts use player-rate fixed steps and run events", () => {
  const trainer = new PpoTrainer();
  trainer.maxEpisodeSeconds = 30;
  trainer.warmupSeconds = 0;

  const episode = trainer.runEpisode(1234);

  assert.equal(episode.runEventsEnabled, true);
  assert.equal(episode.stepDt, GAME.fixedStep);
  assert.equal(episode.tickRate, Math.round(1 / GAME.fixedStep));
  assert.equal(episode.runEventsTriggered > 0, true);
});

test("PPO XP and powerup reward hyperparameters affect episode rewards", () => {
  const baseline = new PpoTrainer();
  const pickupBiased = new PpoTrainer();
  baseline.maxEpisodeSeconds = 30;
  pickupBiased.maxEpisodeSeconds = 30;
  pickupBiased.xpReward = 1.2;
  pickupBiased.powerupReward = 4;

  assert.notEqual(
    Number(pickupBiased.runEpisode(900).reward.toFixed(6)),
    Number(baseline.runEpisode(900).reward.toFixed(6)),
  );
});

test("PPO feature and policy outputs stay finite and normalized", () => {
  const trainer = new PpoTrainer();
  const episode = trainer.runEpisode(11223);
  const features = episode.trajectory[0].features;
  const probabilities = trainer.probabilities(features);
  const aimProbabilities = trainer.aimProbabilities(features);

  assert.equal(features.length, trainer.weights[0].length);
  assert.equal(features.every(Number.isFinite), true);
  assert.equal(probabilities.every(Number.isFinite), true);
  assert.equal(aimProbabilities.every(Number.isFinite), true);
  assert.equal(Number(probabilities.reduce((sum, value) => sum + value, 0).toFixed(12)), 1);
  assert.equal(Number(aimProbabilities.reduce((sum, value) => sum + value, 0).toFixed(12)), 1);
});

test("PPO watch aim rotates persistent player aim toward enemies instead of snapping", () => {
  const trainer = new PpoTrainer();
  const simulation = new GameSimulation({ seed: 42, localPlayerId: "ppo" });
  const player = simulation.players.get("ppo");
  const angle = (90 * Math.PI) / 180;
  const distance = 300;
  player.x = 0;
  player.y = 0;
  player.aimX = 1;
  player.aimY = 0;
  simulation.enemies.clear();
  simulation.enemies.set("aim-target", createEnemy("aim-target", "drone", Math.cos(angle) * distance, Math.sin(angle) * distance, 1));

  const action = trainer.act(simulation);
  const length = Math.hypot(action.aimX, action.aimY);
  const rotated = Math.atan2(action.aimY, action.aimX);

  assert.equal(Number(length.toFixed(6)), 1);
  assert.equal(rotated > 0 && rotated < angle, true, "aim should rotate toward enemy without snapping");
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
  assert.deepEqual(roundedAimWeights(restored), roundedAimWeights(trained));
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
