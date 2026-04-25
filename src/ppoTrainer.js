import { GAME } from "./config.js";
import { normalizeMetaProgress } from "./metaProgression.js";
import { GameSimulation } from "./simulation.js";

const ACTIONS = [
  [0, -1],
  [0.7, -0.7],
  [1, 0],
  [0.7, 0.7],
  [0, 1],
  [-0.7, 0.7],
  [-1, 0],
  [-0.7, -0.7],
];

export class PpoTrainer {
  constructor({ metaProgress = null } = {}) {
    this.metaProgress = normalizeMetaProgress(metaProgress ?? {});
    this.iteration = 0;
    this.weights = Array.from({ length: ACTIONS.length }, () => Array(7).fill(0));
    this.history = [];
    this.running = false;
  }

  trainBatch(batchSize = 8) {
    const episodes = [];
    for (let i = 0; i < batchSize; i += 1) {
      episodes.push(this.runEpisode(9000 + this.iteration * 97 + i));
    }

    const meanReward = mean(episodes.map((episode) => episode.reward));
    const meanSeconds = mean(episodes.map((episode) => episode.seconds));
    const meanKills = mean(episodes.map((episode) => episode.kills));
    const meanDamage = mean(episodes.map((episode) => episode.damageDealt));
    const meanDamageTaken = mean(episodes.map((episode) => episode.damageTaken));
    const meanScore = mean(episodes.map((episode) => episode.score));
    const deathRate = mean(episodes.map((episode) => (episode.dead ? 1 : 0))) * 100;
    this.updatePolicy(episodes, meanReward);
    this.iteration += 1;
    const point = {
      iteration: this.iteration,
      reward: Math.round(meanReward),
      seconds: Math.round(meanSeconds),
      kills: Math.round(meanKills),
      damage: Math.round(meanDamage),
      damageTaken: Math.round(meanDamageTaken),
      score: Math.round(meanScore),
      deathRate: Math.round(deathRate),
      episodes: episodes.length,
    };
    this.history.push(point);
    return point;
  }

  runEpisode(seed) {
    const sim = new GameSimulation({ seed, localPlayerId: "ppo", metaProgress: this.metaProgress });
    const playerId = sim.localPlayerId;
    let previousKills = 0;
    let previousTotalEnemyHp = 0;
    let previousHp = null;
    let reward = 0;
    let damageDealt = 0;
    let damageTaken = 0;
    const trajectory = [];

    for (let tick = 0; tick < GAME.ppoMaxEpisodeSeconds * 30 && sim.state !== "gameover"; tick += 1) {
      const snapshot = sim.getSnapshot();
      const player = snapshot.players[0];
      if (!player) break;
      previousTotalEnemyHp = totalEnemyHp(snapshot);
      previousHp ??= player.hp;
      const features = this.features(snapshot, player);
      const { action, probability } = this.sampleAction(features, seed + tick);
      sim.applyInput(playerId, { moveX: ACTIONS[action][0], moveY: ACTIONS[action][1] });
      sim.step(1 / 30);

      const nextSnapshot = sim.getSnapshot();
      const nextPlayer = nextSnapshot.players[0];
      const kills = nextPlayer?.kills ?? previousKills;
      const currentTotalEnemyHp = totalEnemyHp(nextSnapshot);
      const damageStep = Math.max(0, previousTotalEnemyHp - currentTotalEnemyHp);
      const takenStep = Math.max(0, previousHp - (nextPlayer?.hp ?? 0));
      damageDealt += damageStep;
      damageTaken += takenStep;
      const stepReward = 0.035 + (kills - previousKills) * 5 + damageStep * 0.015 - takenStep * 0.08 + (nextPlayer?.hp ?? 0) / 9000;
      reward += stepReward;
      previousKills = kills;
      previousHp = nextPlayer?.hp ?? 0;
      trajectory.push({ features, action, probability, reward: stepReward });
      if (sim.state === "upgrade") sim.chooseUpgrade(sim.pendingUpgradeChoices[0]?.id);
    }

    const final = sim.getSnapshot();
    const player = final.players[0];
    const dead = final.state === "gameover" || (player?.hp ?? 0) <= 0;
    const score = final.elapsed * 10 + (player?.kills ?? 0) * 45 + damageDealt * 0.35 - damageTaken * 2 + (player?.level ?? 1) * 100;
    reward += final.elapsed * 0.2 + (player?.level ?? 1) * 12 - (dead ? 20 : 0);
    return {
      reward,
      seconds: final.elapsed,
      kills: player?.kills ?? 0,
      damageDealt,
      damageTaken,
      dead,
      score,
      trajectory,
    };
  }

  updatePolicy(episodes, baseline) {
    const learningRate = 0.018;
    const clip = 0.18;
    for (const episode of episodes) {
      const advantage = Math.max(-80, Math.min(80, episode.reward - baseline));
      for (const step of episode.trajectory) {
        const probabilities = this.probabilities(step.features);
        for (let actionIndex = 0; actionIndex < ACTIONS.length; actionIndex += 1) {
          const indicator = actionIndex === step.action ? 1 : 0;
          const ratio = probabilities[actionIndex] / Math.max(step.probability, 0.0001);
          const clippedRatio = Math.max(1 - clip, Math.min(1 + clip, ratio));
          const gradient = (indicator - probabilities[actionIndex]) * advantage * clippedRatio;
          for (let j = 0; j < step.features.length; j += 1) {
            this.weights[actionIndex][j] += learningRate * gradient * step.features[j];
          }
        }
      }
    }
  }

  features(snapshot, player) {
    const nearestEnemy = nearest(player, snapshot.enemies);
    const nearestPickup = nearest(player, snapshot.pickups);
    return [
      1,
      clamp01(player.hp / player.stats.maxHp),
      clampSigned((nearestEnemy?.x - player.x) / 900),
      clampSigned((nearestEnemy?.y - player.y) / 900),
      clampSigned((nearestPickup?.x - player.x) / 700),
      clampSigned((nearestPickup?.y - player.y) / 700),
      clamp01(snapshot.enemies.length / 100),
    ];
  }

  sampleAction(features, seed) {
    const probabilities = this.probabilities(features);
    const random = seeded(seed);
    let roll = random;
    for (let i = 0; i < probabilities.length; i += 1) {
      roll -= probabilities[i];
      if (roll <= 0) return { action: i, probability: probabilities[i] };
    }
    return { action: probabilities.length - 1, probability: probabilities.at(-1) };
  }

  probabilities(features) {
    const logits = this.weights.map((weights) => dot(weights, features));
    const maxLogit = Math.max(...logits);
    const exp = logits.map((value) => Math.exp(value - maxLogit));
    const total = exp.reduce((sum, value) => sum + value, 0);
    return exp.map((value) => value / total);
  }
}

function nearest(origin, items) {
  let best = null;
  let bestDistance = Infinity;
  for (const item of items) {
    const dx = item.x - origin.x;
    const dy = item.y - origin.y;
    const dist = dx * dx + dy * dy;
    if (dist < bestDistance) {
      bestDistance = dist;
      best = item;
    }
  }
  return best;
}

function dot(a, b) {
  return a.reduce((sum, value, index) => sum + value * b[index], 0);
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

function totalEnemyHp(snapshot) {
  return snapshot.enemies.reduce((sum, enemy) => sum + Math.max(0, enemy.hp), 0);
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function clampSigned(value) {
  return Math.max(-1, Math.min(1, value));
}

function seeded(seed) {
  let state = seed >>> 0;
  state = (1664525 * state + 1013904223) >>> 0;
  return state / 0x100000000;
}
