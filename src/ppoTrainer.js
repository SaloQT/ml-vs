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

const FEATURE_COUNT = 14;
const STEP_DT = 1 / 30;

export class PpoTrainer {
  constructor({ metaProgress = null } = {}) {
    this.metaProgress = normalizeMetaProgress(metaProgress ?? {});
    this.iteration = 0;
    this.weights = initialWeights();
    this.history = [];
    this.running = false;
  }

  trainBatch(batchSize = 8) {
    const episodes = [];
    const startedAt = nowMs();
    for (let i = 0; i < batchSize; i += 1) {
      episodes.push(this.runEpisode(9000 + this.iteration * 97 + i));
    }
    const elapsedMs = Math.max(0.001, nowMs() - startedAt);

    const meanReward = mean(episodes.map((episode) => episode.reward));
    const meanSeconds = mean(episodes.map((episode) => episode.seconds));
    const meanKills = mean(episodes.map((episode) => episode.kills));
    const meanDamage = mean(episodes.map((episode) => episode.damageDealt));
    const meanDamageTaken = mean(episodes.map((episode) => episode.damageTaken));
    const meanScore = mean(episodes.map((episode) => episode.score));
    const deathRate = mean(episodes.map((episode) => (episode.dead ? 1 : 0))) * 100;
    const ticks = episodes.reduce((sum, episode) => sum + Math.round(episode.seconds * 30), 0);
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
      ticks,
      ticksPerSecond: Math.round(ticks / (elapsedMs / 1000)),
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
    let previousShield = 0;
    let previousXp = 0;
    let previousLevel = 1;
    let previousScrap = 0;
    let reward = 0;
    let damageDealt = 0;
    let damageTaken = 0;
    const trajectory = [];
    const maxTicks = GAME.ppoMaxEpisodeSeconds * 30;

    for (let tick = 0; tick < maxTicks && sim.state !== "gameover"; tick += 1) {
      const player = sim.players.get(playerId);
      if (!player) break;
      previousTotalEnemyHp = totalEnemyHp(sim.enemies);
      previousHp ??= player.hp;
      previousShield = player.shield ?? 0;
      previousXp = player.xp;
      previousLevel = player.level;
      previousScrap = player.scrap ?? 0;
      const features = this.features(sim, player);
      const { action, probability } = this.sampleAction(features, seed + tick);
      sim.applyInput(playerId, { moveX: ACTIONS[action][0], moveY: ACTIONS[action][1] });
      sim.step(STEP_DT);

      const nextPlayer = sim.players.get(playerId);
      const kills = nextPlayer?.kills ?? previousKills;
      const currentTotalEnemyHp = totalEnemyHp(sim.enemies);
      const damageStep = Math.max(0, previousTotalEnemyHp - currentTotalEnemyHp);
      const takenStep = Math.max(0, previousHp - (nextPlayer?.hp ?? 0));
      const shieldStep = Math.max(0, (nextPlayer?.shield ?? 0) - previousShield);
      const xpStep = Math.max(0, (nextPlayer?.xp ?? 0) - previousXp);
      const levelStep = Math.max(0, (nextPlayer?.level ?? previousLevel) - previousLevel);
      const scrapStep = Math.max(0, (nextPlayer?.scrap ?? 0) - previousScrap);
      damageDealt += damageStep;
      damageTaken += takenStep;
      const healthRatio = nextPlayer ? nextPlayer.hp / nextPlayer.stats.maxHp : 0;
      const enemyPressure = nearestDistanceSq(nextPlayer, sim.enemies);
      const closeEnemyPenalty = enemyPressure < 150 ** 2 ? 0.055 : 0;
      const stepReward =
        0.025 +
        (kills - previousKills) * 7.5 +
        damageStep * 0.025 +
        xpStep * 0.08 +
        levelStep * 8 +
        scrapStep * 0.12 +
        shieldStep * 0.035 -
        takenStep * 0.16 -
        closeEnemyPenalty +
        healthRatio * 0.01;
      reward += stepReward;
      previousKills = kills;
      previousHp = nextPlayer?.hp ?? 0;
      trajectory.push({ features, action, probability, reward: stepReward });
      if (sim.state === "upgrade") sim.chooseUpgrade(sim.pendingUpgradeChoices[0]?.id);
    }

    const player = sim.players.get(playerId);
    const dead = sim.state === "gameover" || (player?.hp ?? 0) <= 0;
    const score = sim.elapsed * 10 + (player?.kills ?? 0) * 45 + damageDealt * 0.35 - damageTaken * 2 + (player?.level ?? 1) * 100;
    reward += sim.elapsed * 0.25 + (player?.level ?? 1) * 14 + (player?.scrap ?? 0) * 0.2 - (dead ? 35 : 0);
    return {
      reward,
      seconds: sim.elapsed,
      kills: player?.kills ?? 0,
      damageDealt,
      damageTaken,
      dead,
      score,
      trajectory,
    };
  }

  updatePolicy(episodes, baseline) {
    const learningRate = 0.00004;
    const clip = 0.12;
    const allSteps = [];
    for (const episode of episodes) {
      let returnSoFar = episode.dead ? -8 : 0;
      for (let index = episode.trajectory.length - 1; index >= 0; index -= 1) {
        const step = episode.trajectory[index];
        returnSoFar = step.reward + returnSoFar * 0.985;
        step.return = returnSoFar;
      }
      for (const step of episode.trajectory) {
        allSteps.push(step);
      }
    }
    const averageReturn = mean(allSteps.map((step) => step.return));
    const returnDeviation = Math.sqrt(mean(allSteps.map((step) => (step.return - averageReturn) ** 2))) || 1;

    for (const step of allSteps) {
      const probabilities = this.probabilities(step.features);
      const ratio = probabilities[step.action] / Math.max(step.probability, 0.0001);
      const clippedRatio = Math.max(1 - clip, Math.min(1 + clip, ratio));
      for (let actionIndex = 0; actionIndex < ACTIONS.length; actionIndex += 1) {
        const indicator = actionIndex === step.action ? 1 : 0;
        const advantage = Math.max(-3, Math.min(3, (step.return - averageReturn) / returnDeviation));
        const gradient = (indicator - probabilities[actionIndex]) * advantage * clippedRatio;
        for (let j = 0; j < step.features.length; j += 1) {
          this.weights[actionIndex][j] += learningRate * gradient * step.features[j];
        }
      }
    }
  }

  features(source, player) {
    const enemies = iterableValues(source.enemies);
    const pickups = iterableValues(source.pickups);
    const nearestEnemy = nearest(player, enemies);
    const nearestPickup = nearest(player, pickups);
    const nearestEnemyDistance = nearestEnemy ? Math.hypot(nearestEnemy.x - player.x, nearestEnemy.y - player.y) : 1200;
    const nearestPickupDistance = nearestPickup ? Math.hypot(nearestPickup.x - player.x, nearestPickup.y - player.y) : 900;
    const maxHp = Math.max(1, player.stats.maxHp);
    const nextLevelXp = Math.max(1, player.nextLevelXp);
    const enemyCount = source.enemies?.size ?? source.enemies?.length ?? 0;
    const pickupCount = source.pickups?.size ?? source.pickups?.length ?? 0;
    return [
      1,
      clamp01(player.hp / maxHp),
      clamp01((player.shield ?? 0) / 60),
      clampSigned(((nearestEnemy?.x ?? player.x) - player.x) / 900),
      clampSigned(((nearestEnemy?.y ?? player.y) - player.y) / 900),
      clamp01(nearestEnemyDistance / 1200),
      clampSigned(((nearestPickup?.x ?? player.x) - player.x) / 700),
      clampSigned(((nearestPickup?.y ?? player.y) - player.y) / 700),
      clamp01(nearestPickupDistance / 900),
      clamp01(enemyCount / 100),
      clamp01(pickupCount / 80),
      clamp01(player.xp / nextLevelXp),
      clamp01((player.level - 1) / 8),
      clamp01((player.overdriveFor ?? 0) / 5),
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
    this.ensureWeightsForFeatureCount(features.length);
    const logits = this.weights.map((weights) => dot(weights, features));
    const maxLogit = Math.max(...logits);
    const exp = logits.map((value) => Math.exp(value - maxLogit));
    const total = exp.reduce((sum, value) => sum + value, 0);
    return exp.map((value) => value / total);
  }

  ensureWeightsForFeatureCount(featureCount) {
    for (const weights of this.weights) {
      while (weights.length < featureCount) weights.push(0);
    }
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

function nearestDistanceSq(origin, items) {
  if (!origin) return Infinity;
  let best = Infinity;
  for (const item of items.values()) {
    const dx = item.x - origin.x;
    const dy = item.y - origin.y;
    const dist = dx * dx + dy * dy;
    if (dist < best) best = dist;
  }
  return best;
}

function iterableValues(items) {
  return typeof items?.values === "function" ? items.values() : items ?? [];
}

function dot(a, b) {
  return a.reduce((sum, value, index) => sum + value * b[index], 0);
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

function totalEnemyHp(enemies) {
  let total = 0;
  for (const enemy of enemies.values()) total += Math.max(0, enemy.hp);
  return total;
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

function initialWeights() {
  return ACTIONS.map(([moveX, moveY]) => {
    const weights = Array(FEATURE_COUNT).fill(0);
    weights[3] = -0.22 * moveX;
    weights[4] = -0.22 * moveY;
    weights[6] = 0.08 * moveX;
    weights[7] = 0.08 * moveY;
    return weights;
  });
}

function nowMs() {
  return globalThis.performance?.now?.() ?? Date.now();
}
