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
const UPGRADE_FEATURE_COUNT = 15;
const UPGRADE_CHOICE_COUNT = 3;
const MODEL_FORMAT = "space-survivors-ppo";
const MODEL_VERSION = 1;
const STEP_DT = 1 / 30;

export class PpoTrainer {
  constructor({ metaProgress = null } = {}) {
    this.metaProgress = normalizeMetaProgress(metaProgress ?? {});
    this.iteration = 0;
    this.weights = initialWeights();
    this.upgradeWeights = initialUpgradeWeights();
    this.history = [];
    this.running = false;
    this.learningRate = 0.00004;
    this.clip = 0.12;
    this.gamma = 0.985;
    this.batchSize = 2;
    this.maxEpisodeSeconds = GAME.ppoMaxEpisodeSeconds;
    this.warmupSeconds = 3;
    this.advantageClamp = 3;
    this.killReward = 7.5;
    this.xpReward = 0.08;
    this.powerupReward = 0.7;
    this.damageTakenPenalty = 0.16;
    this.survivalBonus = 0.025;
    this.deathPenalty = 35;
  }

  trainBatch(batchSize = this.batchSize) {
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
    let killsScored = 0;
    let damageDealt = 0;
    let damageTaken = 0;
    const trajectory = [];
    const warmupTicks = Math.max(0, Math.round(this.warmupSeconds * 30));
    const maxTicks = warmupTicks + Math.max(1, Math.round(this.maxEpisodeSeconds * 30));
    let cachedEnemyHp = -1;

    for (let tick = 0; tick < maxTicks && sim.state !== "gameover"; tick += 1) {
      const player = sim.players.get(playerId);
      if (!player) break;
      const scoring = tick >= warmupTicks;

      if (sim.state === "upgrade") {
        const decision = this.chooseUpgrade(sim, seed + tick * 997);
        if (decision && scoring) trajectory.push({ kind: "upgrade", ...decision, reward: 0 });
        cachedEnemyHp = -1;
        continue;
      }

      previousTotalEnemyHp = cachedEnemyHp >= 0 ? cachedEnemyHp : totalEnemyHp(sim.enemies);
      previousHp ??= player.hp;
      previousShield = player.shield ?? 0;
      previousXp = player.xp;
      previousLevel = player.level;
      previousScrap = player.scrap ?? 0;
      const previousOverdrive = player.overdriveFor ?? 0;
      const previousMagnetBurst = player.magnetBurstFor ?? 0;
      const features = this.features(sim, player);
      const { action, probability } = this.sampleAction(features, seed + tick);
      sim.applyInput(playerId, { moveX: ACTIONS[action][0], moveY: ACTIONS[action][1] });
      sim.step(STEP_DT);

      const nextPlayer = sim.players.get(playerId);
      const kills = nextPlayer?.kills ?? previousKills;
      const currentTotalEnemyHp = totalEnemyHp(sim.enemies);
      cachedEnemyHp = currentTotalEnemyHp;
      const damageStep = Math.max(0, previousTotalEnemyHp - currentTotalEnemyHp);
      const takenStep = Math.max(0, previousHp - (nextPlayer?.hp ?? 0));
      const shieldStep = Math.max(0, (nextPlayer?.shield ?? 0) - previousShield);
      const xpStep = Math.max(0, (nextPlayer?.xp ?? 0) - previousXp);
      const levelStep = Math.max(0, (nextPlayer?.level ?? previousLevel) - previousLevel);
      const scrapStep = Math.max(0, (nextPlayer?.scrap ?? 0) - previousScrap);
      const powerupStep =
        Math.max(0, (nextPlayer?.overdriveFor ?? 0) - previousOverdrive) +
        Math.max(0, (nextPlayer?.magnetBurstFor ?? 0) - previousMagnetBurst) +
        (shieldStep > 0 ? 1 : 0) +
        (scrapStep > 0 ? 1 : 0);
      if (scoring) {
        killsScored += Math.max(0, kills - previousKills);
        damageDealt += damageStep;
        damageTaken += takenStep;
      }
      const healthRatio = nextPlayer ? nextPlayer.hp / nextPlayer.stats.maxHp : 0;
      const enemyPressure = nearestDistanceSq(nextPlayer, sim.enemies);
      const closeEnemyPenalty = enemyPressure < 150 ** 2 ? 0.055 : 0;
      const stepReward = scoring
        ? this.survivalBonus +
          (kills - previousKills) * this.killReward +
          damageStep * 0.025 +
          xpStep * this.xpReward +
          levelStep * 8 +
          scrapStep * 0.12 +
          powerupStep * this.powerupReward -
          takenStep * this.damageTakenPenalty -
          closeEnemyPenalty +
          healthRatio * 0.01
        : 0;
      if (scoring) reward += stepReward;
      previousKills = kills;
      previousHp = nextPlayer?.hp ?? 0;
      if (scoring) trajectory.push({ kind: "move", features, action, probability, reward: stepReward });
      if (sim.state === "upgrade") {
        const decision = this.chooseUpgrade(sim, seed + tick * 997 + 1);
        if (decision && scoring) trajectory.push({ kind: "upgrade", ...decision, reward: 0 });
        cachedEnemyHp = -1;
      }
    }

    const player = sim.players.get(playerId);
    const dead = sim.state === "gameover" || (player?.hp ?? 0) <= 0;
    const scoredSeconds = Math.max(0, sim.elapsed - this.warmupSeconds);
    const countedDead = dead && scoredSeconds > 0;
    const score = scoredSeconds * 10 + killsScored * 45 + damageDealt * 0.35 - damageTaken * 2 + (player?.level ?? 1) * 100;
    reward += scoredSeconds * 0.25 + (player?.level ?? 1) * 14 + (player?.scrap ?? 0) * 0.2 - (countedDead ? this.deathPenalty : 0);
    return {
      reward,
      seconds: scoredSeconds,
      kills: killsScored,
      damageDealt,
      damageTaken,
      dead: countedDead,
      score,
      trajectory,
    };
  }

  updatePolicy(episodes, baseline) {
    const learningRate = this.learningRate;
    const clip = this.clip;
    const movementSteps = [];
    const upgradeSteps = [];
    for (const episode of episodes) {
      let returnSoFar = episode.dead ? -this.deathPenalty * 0.23 : 0;
      for (let index = episode.trajectory.length - 1; index >= 0; index -= 1) {
        const step = episode.trajectory[index];
        returnSoFar = step.reward + returnSoFar * this.gamma;
        step.return = returnSoFar;
      }
      for (const step of episode.trajectory) {
        if (step.kind === "upgrade") upgradeSteps.push(step);
        else movementSteps.push(step);
      }
    }
    this.updateStepPolicy(movementSteps, this.weights, (features) => this.probabilities(features), learningRate, clip);
    this.updateUpgradePolicy(upgradeSteps, learningRate, clip);
  }

  updateStepPolicy(steps, weights, probabilityFn, learningRate, clip) {
    const stepCount = steps.length;
    if (!stepCount) return;
    let sum = 0;
    for (let i = 0; i < stepCount; i += 1) sum += steps[i].return;
    const averageReturn = sum / stepCount;
    let varSum = 0;
    for (let i = 0; i < stepCount; i += 1) {
      const d = steps[i].return - averageReturn;
      varSum += d * d;
    }
    const returnDeviation = Math.sqrt(varSum / stepCount) || 1;
    const advantageClamp = this.advantageClamp;
    const lowClip = 1 - clip;
    const highClip = 1 + clip;
    const actionCount = weights.length;
    for (let s = 0; s < stepCount; s += 1) {
      const step = steps[s];
      const features = step.features;
      const featureCount = features.length;
      const action = step.action;
      const probabilities = probabilityFn(features);
      const ratio = probabilities[action] / Math.max(step.probability, 0.0001);
      const clippedRatio = ratio < lowClip ? lowClip : ratio > highClip ? highClip : ratio;
      const rawAdvantage = (step.return - averageReturn) / returnDeviation;
      const advantage =
        rawAdvantage < -advantageClamp ? -advantageClamp : rawAdvantage > advantageClamp ? advantageClamp : rawAdvantage;
      const advClipRatio = advantage * clippedRatio;
      for (let a = 0; a < actionCount; a += 1) {
        const indicator = a === action ? 1 : 0;
        const gradient = (indicator - probabilities[a]) * advClipRatio;
        const scale = learningRate * gradient;
        const row = weights[a];
        for (let j = 0; j < featureCount; j += 1) {
          row[j] += scale * features[j];
        }
      }
    }
  }

  updateUpgradePolicy(steps, learningRate, clip) {
    const stepCount = steps.length;
    if (!stepCount) return;
    let sum = 0;
    for (let i = 0; i < stepCount; i += 1) sum += steps[i].return;
    const averageReturn = sum / stepCount;
    let varSum = 0;
    for (let i = 0; i < stepCount; i += 1) {
      const d = steps[i].return - averageReturn;
      varSum += d * d;
    }
    const returnDeviation = Math.sqrt(varSum / stepCount) || 1;
    const advantageClamp = this.advantageClamp;
    const lowClip = 1 - clip;
    const highClip = 1 + clip;
    const upgradeWeights = this.upgradeWeights;
    const actionCount = upgradeWeights.length;
    for (let s = 0; s < stepCount; s += 1) {
      const step = steps[s];
      const action = step.action;
      const probabilities = this.upgradeProbabilities(step.features);
      const ratio = probabilities[action] / Math.max(step.probability, 0.0001);
      const clippedRatio = ratio < lowClip ? lowClip : ratio > highClip ? highClip : ratio;
      const rawAdvantage = (step.return - averageReturn) / returnDeviation;
      const advantage =
        rawAdvantage < -advantageClamp ? -advantageClamp : rawAdvantage > advantageClamp ? advantageClamp : rawAdvantage;
      const advClipRatio = advantage * clippedRatio;
      for (let a = 0; a < actionCount; a += 1) {
        const indicator = a === action ? 1 : 0;
        const gradient = (indicator - probabilities[a]) * advClipRatio;
        const scale = learningRate * gradient;
        const features = step.features[a] ?? Array(UPGRADE_FEATURE_COUNT).fill(0);
        const row = upgradeWeights[a];
        const featureCount = features.length;
        for (let j = 0; j < featureCount; j += 1) {
          row[j] += scale * features[j];
        }
      }
    }
  }

  features(source, player) {
    const enemies = iterableValues(source.enemies);
    const pickups = iterableValues(source.pickups);
    const enemyResult = nearestWithDistSq(player, enemies);
    const pickupResult = nearestWithDistSq(player, pickups);
    const nearestEnemy = enemyResult.item;
    const nearestPickup = pickupResult.item;
    const nearestEnemyDistance = nearestEnemy ? Math.sqrt(enemyResult.distSq) : 1200;
    const nearestPickupDistance = nearestPickup ? Math.sqrt(pickupResult.distSq) : 900;
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

  act(sim) {
    const player = sim.players.get(sim.localPlayerId);
    if (!player) return { moveX: 0, moveY: 0 };
    if (sim.state === "upgrade") {
      this.chooseUpgrade(sim, Date.now() + sim.tick);
      return { moveX: 0, moveY: 0 };
    }
    const features = this.features(sim, player);
    const { action } = this.sampleAction(features, Date.now() + sim.tick);
    const [moveX, moveY] = ACTIONS[action];
    return { moveX, moveY };
  }

  chooseUpgrade(sim, seed = Date.now()) {
    if (sim.state !== "upgrade" || !sim.pendingUpgradeChoices?.length) return null;
    const player = sim.players.get(sim.localPlayerId);
    if (!player) return null;
    const choiceFeatures = this.upgradeChoiceFeatures(sim, player);
    const { action, probability } = this.sampleUpgradeAction(choiceFeatures, seed);
    const upgrade = sim.pendingUpgradeChoices[action] ?? sim.pendingUpgradeChoices[0];
    if (!upgrade) return null;
    sim.chooseUpgrade(upgrade.id);
    return { features: choiceFeatures, action, probability };
  }

  observation(sim) {
    const player = sim.players.get(sim.localPlayerId);
    if (!player) return { movement: Array(FEATURE_COUNT).fill(0), upgradeChoices: [] };
    return {
      movement: this.features(sim, player),
      upgradeChoices: sim.state === "upgrade" ? this.upgradeChoiceFeatures(sim, player) : [],
    };
  }

  upgradeChoiceFeatures(sim, player) {
    const choices = sim.pendingUpgradeChoices ?? [];
    return Array.from({ length: UPGRADE_CHOICE_COUNT }, (_, index) => upgradeFeatures(choices[index], index, player));
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
    const weights = this.weights;
    const n = weights.length;
    const out = new Array(n);
    let maxLogit = -Infinity;
    for (let i = 0; i < n; i += 1) {
      const logit = dot(weights[i], features);
      out[i] = logit;
      if (logit > maxLogit) maxLogit = logit;
    }
    let total = 0;
    for (let i = 0; i < n; i += 1) {
      const e = Math.exp(out[i] - maxLogit);
      out[i] = e;
      total += e;
    }
    for (let i = 0; i < n; i += 1) out[i] /= total;
    return out;
  }

  upgradeProbabilities(choiceFeatures) {
    const upgradeWeights = this.upgradeWeights;
    for (const weights of upgradeWeights) {
      while (weights.length < UPGRADE_FEATURE_COUNT) weights.push(0);
    }
    const n = choiceFeatures.length;
    const out = new Array(n);
    const available = new Array(n);
    let maxLogit = -Infinity;
    for (let i = 0; i < n; i += 1) {
      const item = choiceFeatures[i] ?? Array(UPGRADE_FEATURE_COUNT).fill(0);
      const logit = dot(upgradeWeights[i], item);
      out[i] = logit;
      available[i] = item[0] > 0;
      if (logit > maxLogit) maxLogit = logit;
    }
    let total = 0;
    for (let i = 0; i < n; i += 1) {
      const e = available[i] ? Math.exp(out[i] - maxLogit) : 0;
      out[i] = e;
      total += e;
    }
    if (total <= 0) {
      for (let i = 0; i < n; i += 1) out[i] = i === 0 ? 1 : 0;
      return out;
    }
    for (let i = 0; i < n; i += 1) out[i] /= total;
    return out;
  }

  sampleUpgradeAction(choiceFeatures, seed) {
    const probabilities = this.upgradeProbabilities(choiceFeatures);
    const random = seeded(seed);
    let roll = random;
    for (let i = 0; i < probabilities.length; i += 1) {
      roll -= probabilities[i];
      if (roll <= 0) return { action: i, probability: probabilities[i] };
    }
    const action = Math.max(0, probabilities.findLastIndex((value) => value > 0));
    return { action, probability: probabilities[action] };
  }

  ensureWeightsForFeatureCount(featureCount) {
    for (const weights of this.weights) {
      while (weights.length < featureCount) weights.push(0);
    }
  }

  exportModel() {
    return {
      format: MODEL_FORMAT,
      version: MODEL_VERSION,
      exportedAt: new Date().toISOString(),
      iteration: this.iteration,
      featureCount: this.weights[0]?.length ?? FEATURE_COUNT,
      actionCount: ACTIONS.length,
      upgradeFeatureCount: this.upgradeWeights[0]?.length ?? UPGRADE_FEATURE_COUNT,
      upgradeActionCount: UPGRADE_CHOICE_COUNT,
      weights: this.weights.map((row) => [...row]),
      upgradeWeights: this.upgradeWeights.map((row) => [...row]),
      history: this.history.map((point) => ({ ...point })),
    };
  }

  importModel(model) {
    const normalized = normalizeModel(model);
    this.iteration = normalized.iteration;
    this.weights = normalized.weights;
    this.upgradeWeights = normalized.upgradeWeights;
    this.history = normalized.history;
    return this;
  }
}

PpoTrainer.MODEL_FORMAT = MODEL_FORMAT;
PpoTrainer.MODEL_VERSION = MODEL_VERSION;

function nearest(origin, items) {
  return nearestWithDistSq(origin, items).item;
}

function nearestWithDistSq(origin, items) {
  let best = null;
  let bestDistance = Infinity;
  const ox = origin.x;
  const oy = origin.y;
  for (const item of items) {
    const dx = item.x - ox;
    const dy = item.y - oy;
    const dist = dx * dx + dy * dy;
    if (dist < bestDistance) {
      bestDistance = dist;
      best = item;
    }
  }
  return { item: best, distSq: bestDistance };
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
  let sum = 0;
  const n = a.length;
  for (let i = 0; i < n; i += 1) sum += a[i] * b[i];
  return sum;
}

function mean(values) {
  let sum = 0;
  const n = values.length;
  for (let i = 0; i < n; i += 1) sum += values[i];
  return sum / Math.max(1, n);
}

function totalEnemyHp(enemies) {
  let total = 0;
  for (const enemy of enemies.values()) {
    const hp = enemy.hp;
    if (hp > 0) total += hp;
  }
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

function initialUpgradeWeights() {
  return Array.from({ length: UPGRADE_CHOICE_COUNT }, (_, index) => {
    const weights = Array(UPGRADE_FEATURE_COUNT).fill(0);
    weights[0] = 0.4;
    weights[1] = 0.05;
    weights[2] = 0.16;
    weights[3] = 0.28;
    weights[4] = 0.42;
    weights[14] = -0.03 * index;
    return weights;
  });
}

function upgradeFeatures(upgrade, index, player) {
  if (!upgrade) return Array(UPGRADE_FEATURE_COUNT).fill(0);
  const text = `${upgrade.id} ${upgrade.name} ${upgrade.description}`.toLowerCase();
  const stacks = player.upgradeStacks?.get(upgrade.id) ?? 0;
  const healthRatio = player.hp / Math.max(1, player.stats.maxHp);
  return [
    1,
    upgrade.rarity === "common" ? 1 : 0,
    upgrade.rarity === "rare" ? 1 : 0,
    upgrade.rarity === "epic" ? 1 : 0,
    clamp01(1 - stacks / Math.max(1, upgrade.maxStacks)),
    clamp01(1 - healthRatio),
    hasAny(text, ["damage", "hit", "critical", "chain", "singularity", "gravity", "bolts", "projectile"]) ? 1 : 0,
    hasAny(text, ["hull", "shield", "armor", "regen", "restore", "repair"]) ? 1 : 0,
    hasAny(text, ["xp", "scrap", "salvage", "collect", "cores", "magnet"]) ? 1 : 0,
    hasAny(text, ["move", "thruster", "faster", "speed"]) ? 1 : 0,
    hasAny(text, ["fire", "volley", "splitter", "reactor", "overclock"]) ? 1 : 0,
    hasAny(text, ["drone", "well", "singularity", "array"]) ? 1 : 0,
    clamp01((player.level - 1) / 8),
    clamp01(player.xp / Math.max(1, player.nextLevelXp)),
    index / Math.max(1, UPGRADE_CHOICE_COUNT - 1),
  ];
}

function hasAny(text, words) {
  return words.some((word) => text.includes(word));
}

function nowMs() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function normalizeModel(model) {
  if (!model || typeof model !== "object") {
    throw new Error("PPO model file is not valid JSON data.");
  }
  if (model.format !== MODEL_FORMAT) {
    throw new Error("PPO model format is not supported.");
  }
  if (model.version !== MODEL_VERSION) {
    throw new Error("PPO model version is not supported.");
  }
  const weights = normalizeWeights(model.weights);
  return {
    iteration: clampNonNegativeInteger(model.iteration, 0),
    weights,
    upgradeWeights: normalizeUpgradeWeights(model.upgradeWeights),
    history: normalizeHistory(model.history),
  };
}

function normalizeWeights(rawWeights) {
  if (!Array.isArray(rawWeights) || rawWeights.length !== ACTIONS.length) {
    throw new Error("PPO model weights do not match the action space.");
  }
  const featureCount = Math.max(FEATURE_COUNT, ...rawWeights.map((row) => (Array.isArray(row) ? row.length : 0)));
  return rawWeights.map((row) => {
    if (!Array.isArray(row)) throw new Error("PPO model weights are malformed.");
    const weights = row.map((value) => {
      const number = Number(value);
      if (!Number.isFinite(number)) throw new Error("PPO model weights contain invalid values.");
      return number;
    });
    while (weights.length < featureCount) weights.push(0);
    return weights;
  });
}

function normalizeUpgradeWeights(rawWeights) {
  if (rawWeights == null) return initialUpgradeWeights();
  if (!Array.isArray(rawWeights) || rawWeights.length !== UPGRADE_CHOICE_COUNT) {
    throw new Error("PPO model upgrade weights do not match the upgrade action space.");
  }
  return rawWeights.map((row) => {
    if (!Array.isArray(row)) throw new Error("PPO model upgrade weights are malformed.");
    const weights = row.map((value) => {
      const number = Number(value);
      if (!Number.isFinite(number)) throw new Error("PPO model upgrade weights contain invalid values.");
      return number;
    });
    while (weights.length < UPGRADE_FEATURE_COUNT) weights.push(0);
    return weights;
  });
}

function normalizeHistory(rawHistory) {
  if (!Array.isArray(rawHistory)) return [];
  return rawHistory.slice(-400).map((point) => ({
    iteration: clampNonNegativeInteger(point?.iteration, 0),
    reward: finiteNumber(point?.reward, 0),
    seconds: finiteNumber(point?.seconds, 0),
    kills: finiteNumber(point?.kills, 0),
    damage: finiteNumber(point?.damage, 0),
    damageTaken: finiteNumber(point?.damageTaken, 0),
    score: finiteNumber(point?.score, 0),
    deathRate: finiteNumber(point?.deathRate, 0),
    episodes: clampNonNegativeInteger(point?.episodes, 0),
    ticks: clampNonNegativeInteger(point?.ticks, 0),
    ticksPerSecond: clampNonNegativeInteger(point?.ticksPerSecond, 0),
  }));
}

function clampNonNegativeInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
}

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}
