import { GAME } from "./config.js";
import { normalize } from "./math.js";
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

const AIM_TURN_DELTAS = [
  0,
  -Math.PI / 128,
  Math.PI / 128,
  -Math.PI / 32,
  Math.PI / 32,
  -Math.PI / 12,
  Math.PI / 12,
  -Math.PI / 6,
  Math.PI / 6,
  -Math.PI / 3,
  Math.PI / 3,
  Math.PI,
];

const FEATURE_COUNT = 18;
const UPGRADE_FEATURE_COUNT = 15;
const UPGRADE_CHOICE_COUNT = 3;
const MODEL_FORMAT = "space-survivors-dqn";
const MODEL_VERSION = 1;
const STEP_DT = GAME.fixedStep;
const STEPS_PER_SECOND = Math.round(1 / STEP_DT);

export class DqnTrainer {
  constructor({ metaProgress = null } = {}) {
    this.metaProgress = normalizeMetaProgress(metaProgress ?? {});
    this.iteration = 0;
    this.name = "DQN";
    this.qWeights = initialMoveWeights();
    this.qAimWeights = initialAimWeights();
    this.qUpgradeWeights = initialUpgradeWeights();
    this.targetWeights = cloneWeights(this.qWeights);
    this.targetAimWeights = cloneWeights(this.qAimWeights);
    this.targetUpgradeWeights = cloneWeights(this.qUpgradeWeights);
    this.history = [];
    this.running = false;
    // Hyperparameters
    this.learningRate = 0.0005;
    this.gamma = 0.985;
    this.batchSize = 2;
    this.maxEpisodeSeconds = GAME.ppoMaxEpisodeSeconds;
    this.warmupSeconds = 3;
    this.epsilonStart = 1.0;
    this.epsilonEnd = 0.05;
    this.epsilonDecaySteps = 5000;
    this.replayCapacity = 20000;
    this.replayMinSize = 200;
    this.targetSyncEvery = 100;
    this.minibatchSize = 64;
    // Reward shaping (mirror PPO)
    this.killReward = 7.5;
    this.xpReward = 0.08;
    this.damageReward = 0.025;
    this.powerupReward = 0.7;
    this.damageTakenPenalty = 0.16;
    this.survivalBonus = 0.025;
    this.deathPenalty = 35;
    this.enemyHealthMultiplier = 1;
    this.enemySpeedMultiplier = 1;
    this.enemySpawnMultiplier = 1;
    this.filterDeathEpisodes = false;
    // Replay state (ephemeral, never serialized)
    this._replay = []; // movement transitions
    this._replayAim = [];
    this._replayUpgrade = [];
    this._totalSteps = 0;
    this._updateCount = 0;
  }

  currentEpsilon() {
    const t = Math.min(1, this._totalSteps / Math.max(1, this.epsilonDecaySteps));
    return this.epsilonStart + (this.epsilonEnd - this.epsilonStart) * t;
  }

  trainBatch(batchSize = this.batchSize) {
    const startedAt = nowMs();
    const episodes = this.runEpisodeBatch(this.batchSeeds(batchSize));
    const elapsedMs = Math.max(0.001, nowMs() - startedAt);
    return this.trainBatchFromEpisodes(episodes, elapsedMs);
  }

  batchSeeds(batchSize = this.batchSize) {
    return Array.from({ length: batchSize }, (_, i) => 9000 + this.iteration * 97 + i);
  }

  runEpisodeBatch(seeds) {
    return seeds.map((seed) => this.runEpisode(seed));
  }

  trainBatchFromEpisodes(episodes, elapsedMs = 0.001) {
    let sumReward = 0;
    let sumSeconds = 0;
    let sumKills = 0;
    let sumDamage = 0;
    let sumDamageTaken = 0;
    let sumScore = 0;
    let sumDead = 0;
    let ticks = 0;
    const episodeCount = episodes.length;
    for (let i = 0; i < episodeCount; i += 1) {
      const ep = episodes[i];
      sumReward += ep.reward;
      sumSeconds += ep.seconds;
      sumKills += ep.kills;
      sumDamage += ep.damageDealt;
      sumDamageTaken += ep.damageTaken;
      sumScore += ep.score;
      if (ep.dead) sumDead += 1;
      ticks += Math.round(ep.seconds * STEPS_PER_SECOND);
      // Push transitions into replay
      for (const tr of ep.transitions ?? []) {
        if (tr.kind === "move") this._pushReplay(this._replay, tr);
        else if (tr.kind === "aim") this._pushReplay(this._replayAim, tr);
        else if (tr.kind === "upgrade") this._pushReplay(this._replayUpgrade, tr);
      }
    }
    const denom = Math.max(1, episodeCount);
    const trainingEpisodes = this.filterDeathEpisodes ? episodes.filter((e) => !e.dead) : episodes;
    const tdLoss = this._learnFromReplay();
    this.iteration += 1;
    const point = {
      iteration: this.iteration,
      reward: Math.round(sumReward / denom),
      seconds: Math.round(sumSeconds / denom),
      kills: Math.round(sumKills / denom),
      damage: Math.round(sumDamage / denom),
      damageTaken: Math.round(sumDamageTaken / denom),
      score: Math.round(sumScore / denom),
      deathRate: Math.round((sumDead / denom) * 100),
      episodes: episodes.length,
      trainedEpisodes: trainingEpisodes.length,
      ticks,
      ticksPerSecond: Math.round(ticks / (elapsedMs / 1000)),
      epsilon: Number(this.currentEpsilon().toFixed(4)),
      tdLoss: Number(tdLoss.toFixed(6)),
    };
    this.history.push(point);
    return point;
  }

  _pushReplay(buffer, transition) {
    if (buffer.length >= this.replayCapacity) {
      buffer.shift();
    }
    buffer.push(transition);
  }

  _learnFromReplay() {
    let totalLoss = 0;
    let count = 0;
    if (this._replay.length >= this.replayMinSize) {
      totalLoss += this._updateQ(this._replay, this.qWeights, this.targetWeights, ACTIONS.length);
      count += 1;
      this._updateCount += 1;
      if (this._updateCount % this.targetSyncEvery === 0) {
        this.targetWeights = cloneWeights(this.qWeights);
      }
    }
    if (this._replayAim.length >= this.replayMinSize) {
      totalLoss += this._updateQ(this._replayAim, this.qAimWeights, this.targetAimWeights, AIM_TURN_DELTAS.length);
      count += 1;
      if (this._updateCount % this.targetSyncEvery === 0) {
        this.targetAimWeights = cloneWeights(this.qAimWeights);
      }
    }
    if (this._replayUpgrade.length >= Math.min(16, this.replayMinSize)) {
      totalLoss += this._updateUpgradeQ(this._replayUpgrade);
      count += 1;
      if (this._updateCount % this.targetSyncEvery === 0) {
        this.targetUpgradeWeights = cloneWeights(this.qUpgradeWeights);
      }
    }
    return count > 0 ? totalLoss / count : 0;
  }

  _updateQ(buffer, weights, target, actionCount) {
    const sampleCount = Math.min(this.minibatchSize, buffer.length);
    let lossSum = 0;
    const lr = this.learningRate;
    for (let i = 0; i < sampleCount; i += 1) {
      const idx = Math.floor(seeded(this._totalSteps * 7919 + i * 31 + this.iteration * 13) * buffer.length) % buffer.length;
      const tr = buffer[idx];
      const features = tr.features;
      const nextFeatures = tr.nextFeatures;
      const action = tr.action;
      // Q(s,a)
      const q = dot(weights[action], features);
      // max_a' Q_target(s', a')
      let maxNext = 0;
      if (!tr.done && nextFeatures) {
        maxNext = -Infinity;
        for (let a = 0; a < actionCount; a += 1) {
          const v = dot(target[a], nextFeatures);
          if (v > maxNext) maxNext = v;
        }
        if (!Number.isFinite(maxNext)) maxNext = 0;
      }
      const td = tr.reward + this.gamma * maxNext - q;
      lossSum += td * td;
      const row = weights[action];
      const fc = features.length;
      // Clip TD to keep linear updates stable
      const clipped = td > 5 ? 5 : td < -5 ? -5 : td;
      const scale = lr * clipped;
      for (let j = 0; j < fc; j += 1) row[j] += scale * features[j];
    }
    return sampleCount > 0 ? lossSum / sampleCount : 0;
  }

  _updateUpgradeQ(buffer) {
    const sampleCount = Math.min(this.minibatchSize, buffer.length);
    let lossSum = 0;
    const lr = this.learningRate;
    for (let i = 0; i < sampleCount; i += 1) {
      const idx = Math.floor(seeded(this._totalSteps * 6151 + i * 41 + this.iteration * 17) * buffer.length) % buffer.length;
      const tr = buffer[idx];
      const action = tr.action;
      const choiceFeatures = tr.choiceFeatures ?? [];
      const item = choiceFeatures[action] ?? Array(UPGRADE_FEATURE_COUNT).fill(0);
      const q = dot(this.qUpgradeWeights[action], item);
      const td = tr.reward - q; // upgrade is treated as terminal one-step
      lossSum += td * td;
      const clipped = td > 5 ? 5 : td < -5 ? -5 : td;
      const scale = lr * clipped;
      const row = this.qUpgradeWeights[action];
      const fc = item.length;
      for (let j = 0; j < fc; j += 1) row[j] += scale * item[j];
    }
    return sampleCount > 0 ? lossSum / sampleCount : 0;
  }

  runEpisode(seed) {
    const sim = new GameSimulation({
      seed,
      localPlayerId: "dqn",
      metaProgress: this.metaProgress,
      headless: true,
      enableRunEvents: true,
      enemyHealthMultiplier: this.enemyHealthMultiplier,
      enemySpeedMultiplier: this.enemySpeedMultiplier,
      enemySpawnMultiplier: this.enemySpawnMultiplier,
    });
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
    const transitions = [];
    const warmupTicks = Math.max(0, Math.round(this.warmupSeconds * STEPS_PER_SECOND));
    const maxTicks = warmupTicks + Math.max(1, Math.round(this.maxEpisodeSeconds * STEPS_PER_SECOND));
    let cachedEnemyHp = -1;
    let prevMoveFeatures = null;
    let prevMoveAction = -1;
    let prevAimFeatures = null;
    let prevAimAction = -1;

    for (let tick = 0; tick < maxTicks && !isTerminalState(sim.state); tick += 1) {
      const player = sim.players.get(playerId);
      if (!player) break;
      const scoring = tick >= warmupTicks;

      if (sim.state === "upgrade") {
        const decision = this.chooseUpgrade(sim, seed + tick * 997);
        if (decision && scoring) {
          transitions.push({ kind: "upgrade", choiceFeatures: decision.choiceFeatures, action: decision.action, reward: 0 });
        }
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
      const epsilon = this.currentEpsilon();
      const moveAction = this.epsilonGreedy(features, this.qWeights, ACTIONS.length, epsilon, seed + tick * 11);
      const aimAction = this.epsilonGreedy(features, this.qAimWeights, AIM_TURN_DELTAS.length, epsilon, seed + tick * 37 + 17);
      const aim = rotateAim(player.aimX ?? player.facingX ?? 1, player.aimY ?? player.facingY ?? 0, AIM_TURN_DELTAS[aimAction] ?? 0);
      sim.applyInput(playerId, { moveX: ACTIONS[moveAction][0], moveY: ACTIONS[moveAction][1], aimX: aim.x, aimY: aim.y });
      sim.step(STEP_DT);

      const nextPlayer = sim.players.get(playerId);
      const kills = nextPlayer?.kills ?? previousKills;
      const post = postStepEnemyScan(nextPlayer, sim.enemies);
      cachedEnemyHp = post.totalHp;
      const damageStep = Math.max(0, previousTotalEnemyHp - post.totalHp);
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
      const killsDelta = Math.max(0, kills - previousKills);
      if (scoring) {
        killsScored += killsDelta;
        damageDealt += damageStep;
        damageTaken += takenStep;
      }
      const healthRatio = nextPlayer ? nextPlayer.hp / nextPlayer.stats.maxHp : 0;
      const closeEnemyPenalty = post.nearestDistSq < 22500 ? 0.055 : 0;
      const stepReward = scoring
        ? this.survivalBonus +
          killsDelta * this.killReward +
          damageStep * this.damageReward +
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

      const nextFeatures = nextPlayer ? this.features(sim, nextPlayer) : null;
      const done = isTerminalState(sim.state) || !nextPlayer || nextPlayer.hp <= 0;
      if (scoring) {
        transitions.push({ kind: "move", features, action: moveAction, reward: stepReward, nextFeatures, done });
        transitions.push({ kind: "aim", features, action: aimAction, reward: stepReward, nextFeatures, done });
        this._totalSteps += 1;
      }

      if (sim.state === "upgrade") {
        const decision = this.chooseUpgrade(sim, seed + tick * 997 + 1);
        if (decision && scoring) {
          transitions.push({ kind: "upgrade", choiceFeatures: decision.choiceFeatures, action: decision.action, reward: 0 });
        }
        cachedEnemyHp = -1;
      }
    }

    const player = sim.players.get(playerId);
    const victory = sim.state === "victory";
    const dead = sim.state === "gameover" || (player?.hp ?? 0) <= 0;
    const scoredSeconds = Math.max(0, sim.elapsed - this.warmupSeconds);
    const countedDead = dead && scoredSeconds > 0;
    const score = scoredSeconds * 10 + killsScored * 45 + damageDealt * 0.35 - damageTaken * 2 + (player?.level ?? 1) * 100;
    reward +=
      scoredSeconds * 0.25 +
      (player?.level ?? 1) * 14 +
      (player?.scrap ?? 0) * 0.2 +
      (victory ? 100 : 0) -
      (countedDead ? this.deathPenalty : 0);
    return {
      reward,
      seconds: scoredSeconds,
      kills: killsScored,
      damageDealt,
      damageTaken,
      dead: countedDead,
      victory,
      outcome: sim.outcome,
      score,
      transitions,
      runEventsEnabled: sim.runEvents.enabled,
      runEventsTriggered: sim.runEvents.sequence,
      stepDt: STEP_DT,
      tickRate: STEPS_PER_SECOND,
    };
  }

  epsilonGreedy(features, weights, actionCount, epsilon, seed) {
    const r = seeded(seed);
    if (r < epsilon) {
      const r2 = seeded(seed * 2654435761 + 1);
      return Math.floor(r2 * actionCount) % actionCount;
    }
    let bestAction = 0;
    let bestQ = -Infinity;
    for (let a = 0; a < actionCount; a += 1) {
      const q = dot(weights[a], features);
      if (q > bestQ) {
        bestQ = q;
        bestAction = a;
      }
    }
    return bestAction;
  }

  chooseUpgrade(sim, seed = Date.now(), { greedy = false } = {}) {
    if (sim.state !== "upgrade" || !sim.pendingUpgradeChoices?.length) return null;
    const player = sim.players.get(sim.localPlayerId);
    if (!player) return null;
    const choiceFeatures = this.upgradeChoiceFeatures(sim, player);
    let action = 0;
    const epsilon = greedy ? 0 : this.currentEpsilon();
    if (seeded(seed) < epsilon) {
      action = Math.floor(seeded(seed * 1103515245 + 12345) * UPGRADE_CHOICE_COUNT) % UPGRADE_CHOICE_COUNT;
    } else {
      let best = -Infinity;
      for (let i = 0; i < UPGRADE_CHOICE_COUNT; i += 1) {
        const item = choiceFeatures[i] ?? Array(UPGRADE_FEATURE_COUNT).fill(0);
        if (item[0] <= 0) continue;
        const q = dot(this.qUpgradeWeights[i], item);
        if (q > best) {
          best = q;
          action = i;
        }
      }
    }
    const upgrade = sim.pendingUpgradeChoices[action] ?? sim.pendingUpgradeChoices[0];
    if (!upgrade) return null;
    sim.chooseUpgrade(upgrade.id);
    return { choiceFeatures, action };
  }

  upgradeChoiceFeatures(sim, player) {
    const choices = sim.pendingUpgradeChoices ?? [];
    return Array.from({ length: UPGRADE_CHOICE_COUNT }, (_, index) => upgradeFeatures(choices[index], index, player));
  }

  features(source, player) {
    const px = player.x;
    const py = player.y;
    let nearestEnemy = null;
    let nearestEnemyDistSq = Infinity;
    const enemies = source.enemies;
    if (enemies?.values) {
      for (const e of enemies.values()) {
        const dx = e.x - px;
        const dy = e.y - py;
        const d = dx * dx + dy * dy;
        if (d < nearestEnemyDistSq) {
          nearestEnemyDistSq = d;
          nearestEnemy = e;
        }
      }
    }
    let nearestPickup = null;
    let nearestPickupDistSq = Infinity;
    const pickups = source.pickups;
    if (pickups?.values) {
      for (const p of pickups.values()) {
        const dx = p.x - px;
        const dy = p.y - py;
        const d = dx * dx + dy * dy;
        if (d < nearestPickupDistSq) {
          nearestPickupDistSq = d;
          nearestPickup = p;
        }
      }
    }
    const nearestEnemyDistance = nearestEnemy ? Math.sqrt(nearestEnemyDistSq) : 1200;
    const nearestPickupDistance = nearestPickup ? Math.sqrt(nearestPickupDistSq) : 900;
    const maxHp = Math.max(1, player.stats.maxHp);
    const nextLevelXp = Math.max(1, player.nextLevelXp);
    const enemyCount = source.enemies?.size ?? source.enemies?.length ?? 0;
    const pickupCount = source.pickups?.size ?? source.pickups?.length ?? 0;
    const aimX = player.aimX ?? player.facingX ?? 1;
    const aimY = player.aimY ?? player.facingY ?? 0;
    const aimLen = Math.hypot(aimX, aimY) || 1;
    const aimNx = aimX / aimLen;
    const aimNy = aimY / aimLen;
    let alignment = 0;
    let cross = 0;
    if (nearestEnemy && nearestEnemyDistance > 0.0001) {
      const ndx = (nearestEnemy.x - player.x) / nearestEnemyDistance;
      const ndy = (nearestEnemy.y - player.y) / nearestEnemyDistance;
      alignment = aimNx * ndx + aimNy * ndy;
      cross = aimNx * ndy - aimNy * ndx;
    }
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
      clampSigned(aimNx),
      clampSigned(aimNy),
      clampSigned(alignment),
      clampSigned(cross),
    ];
  }

  act(sim) {
    const player = sim.players.get(sim.localPlayerId);
    if (!player) return { moveX: 0, moveY: 0 };
    if (sim.state === "upgrade") {
      this.chooseUpgrade(sim, Date.now() + sim.tick, { greedy: true });
      return { moveX: 0, moveY: 0, aimX: player.aimX ?? player.facingX ?? 1, aimY: player.aimY ?? player.facingY ?? 0 };
    }
    const features = this.features(sim, player);
    const moveAction = this.epsilonGreedy(features, this.qWeights, ACTIONS.length, 0, 1);
    const aimAction = this.epsilonGreedy(features, this.qAimWeights, AIM_TURN_DELTAS.length, 0, 1);
    const [moveX, moveY] = ACTIONS[moveAction];
    const aim = rotateAim(player.aimX ?? player.facingX ?? 1, player.aimY ?? player.facingY ?? 0, AIM_TURN_DELTAS[aimAction] ?? 0);
    return { moveX, moveY, aimX: aim.x, aimY: aim.y };
  }

  exportModel() {
    return {
      format: MODEL_FORMAT,
      version: MODEL_VERSION,
      algorithm: "DQN",
      exportedAt: new Date().toISOString(),
      iteration: this.iteration,
      featureCount: this.qWeights[0]?.length ?? FEATURE_COUNT,
      actionCount: ACTIONS.length,
      aimActionCount: AIM_TURN_DELTAS.length,
      upgradeFeatureCount: this.qUpgradeWeights[0]?.length ?? UPGRADE_FEATURE_COUNT,
      upgradeActionCount: UPGRADE_CHOICE_COUNT,
      qWeights: cloneWeights(this.qWeights),
      qAimWeights: cloneWeights(this.qAimWeights),
      qUpgradeWeights: cloneWeights(this.qUpgradeWeights),
      targetWeights: cloneWeights(this.targetWeights),
      targetAimWeights: cloneWeights(this.targetAimWeights),
      targetUpgradeWeights: cloneWeights(this.targetUpgradeWeights),
      history: this.history.map((p) => ({ ...p })),
      hyperparams: {
        learningRate: this.learningRate,
        gamma: this.gamma,
        batchSize: this.batchSize,
        maxEpisodeSeconds: this.maxEpisodeSeconds,
        warmupSeconds: this.warmupSeconds,
        epsilonStart: this.epsilonStart,
        epsilonEnd: this.epsilonEnd,
        epsilonDecaySteps: this.epsilonDecaySteps,
        replayCapacity: this.replayCapacity,
        replayMinSize: this.replayMinSize,
        targetSyncEvery: this.targetSyncEvery,
        minibatchSize: this.minibatchSize,
        killReward: this.killReward,
        xpReward: this.xpReward,
        damageReward: this.damageReward,
        powerupReward: this.powerupReward,
        damageTakenPenalty: this.damageTakenPenalty,
        survivalBonus: this.survivalBonus,
        deathPenalty: this.deathPenalty,
      },
    };
  }

  importModel(model) {
    if (!model || typeof model !== "object") throw new Error("DQN model file is not valid JSON data.");
    if (model.format !== MODEL_FORMAT) throw new Error("DQN model format is not supported.");
    if (model.version !== MODEL_VERSION) throw new Error("DQN model version is not supported.");
    if (!Array.isArray(model.qWeights) || model.qWeights.length !== ACTIONS.length) {
      throw new Error("DQN model weights do not match the action space.");
    }
    this.iteration = clampNonNegativeInteger(model.iteration, 0);
    this.qWeights = normalizeWeightRows(model.qWeights, ACTIONS.length, FEATURE_COUNT);
    this.qAimWeights = normalizeWeightRows(model.qAimWeights, AIM_TURN_DELTAS.length, FEATURE_COUNT);
    this.qUpgradeWeights = normalizeWeightRows(model.qUpgradeWeights, UPGRADE_CHOICE_COUNT, UPGRADE_FEATURE_COUNT);
    this.targetWeights = normalizeWeightRows(model.targetWeights ?? model.qWeights, ACTIONS.length, FEATURE_COUNT);
    this.targetAimWeights = normalizeWeightRows(model.targetAimWeights ?? model.qAimWeights, AIM_TURN_DELTAS.length, FEATURE_COUNT);
    this.targetUpgradeWeights = normalizeWeightRows(model.targetUpgradeWeights ?? model.qUpgradeWeights, UPGRADE_CHOICE_COUNT, UPGRADE_FEATURE_COUNT);
    this.history = Array.isArray(model.history) ? model.history.map((p) => ({ ...p })) : [];
    const hp = model.hyperparams ?? {};
    for (const key of [
      "learningRate", "gamma", "batchSize", "maxEpisodeSeconds", "warmupSeconds",
      "epsilonStart", "epsilonEnd", "epsilonDecaySteps", "replayCapacity", "replayMinSize",
      "targetSyncEvery", "minibatchSize", "killReward", "xpReward", "damageReward",
      "powerupReward", "damageTakenPenalty", "survivalBonus", "deathPenalty",
    ]) {
      const v = Number(hp[key]);
      if (Number.isFinite(v)) this[key] = v;
    }
    return this;
  }
}

DqnTrainer.MODEL_FORMAT = MODEL_FORMAT;
DqnTrainer.MODEL_VERSION = MODEL_VERSION;

function isTerminalState(state) {
  return state === "gameover" || state === "victory";
}

function rotateAim(x, y, delta) {
  const base = normalize(x, y);
  const cos = Math.cos(delta);
  const sin = Math.sin(delta);
  return normalize(base.x * cos - base.y * sin, base.x * sin + base.y * cos);
}

function dot(a, b) {
  let sum = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) sum += a[i] * b[i];
  return sum;
}

function postStepEnemyScan(player, enemies) {
  let totalHp = 0;
  let nearestDistSq = Infinity;
  if (!enemies?.values) return { totalHp, nearestDistSq };
  const px = player?.x ?? 0;
  const py = player?.y ?? 0;
  const havePlayer = Boolean(player);
  for (const enemy of enemies.values()) {
    const hp = enemy.hp;
    if (hp > 0) totalHp += hp;
    if (havePlayer) {
      const dx = enemy.x - px;
      const dy = enemy.y - py;
      const d = dx * dx + dy * dy;
      if (d < nearestDistSq) nearestDistSq = d;
    }
  }
  return { totalHp, nearestDistSq };
}

function totalEnemyHp(enemies) {
  let total = 0;
  for (const enemy of enemies.values()) {
    const hp = enemy.hp;
    if (hp > 0) total += hp;
  }
  return total;
}

function clamp01(value) { return Math.max(0, Math.min(1, value)); }
function clampSigned(value) { return Math.max(-1, Math.min(1, value)); }

function seeded(seed) {
  let state = (seed >>> 0) || 1;
  state = (1664525 * state + 1013904223) >>> 0;
  return state / 0x100000000;
}

function cloneWeights(weights) {
  return weights.map((row) => [...row]);
}

function clampNonNegativeInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
}

function normalizeWeightRows(rawRows, expectedRows, minFeatures) {
  if (!Array.isArray(rawRows) || rawRows.length !== expectedRows) {
    throw new Error("DQN model weights are malformed.");
  }
  const featureCount = Math.max(minFeatures, ...rawRows.map((r) => (Array.isArray(r) ? r.length : 0)));
  return rawRows.map((row) => {
    if (!Array.isArray(row)) throw new Error("DQN model weights are malformed.");
    const w = row.map((v) => {
      const n = Number(v);
      if (!Number.isFinite(n)) throw new Error("DQN model weights contain invalid values.");
      return n === 0 ? 0 : n;
    });
    while (w.length < featureCount) w.push(0);
    return w;
  });
}

function initialMoveWeights() {
  return ACTIONS.map(([moveX, moveY]) => {
    const w = Array(FEATURE_COUNT).fill(0);
    w[3] = -0.22 * moveX;
    w[4] = -0.22 * moveY;
    w[6] = 0.08 * moveX;
    w[7] = 0.08 * moveY;
    return w;
  });
}

function initialAimWeights() {
  return AIM_TURN_DELTAS.map((delta) => {
    const w = Array(FEATURE_COUNT).fill(0);
    w[0] = delta === 0 ? 0.25 : -Math.abs(delta) * 0.05;
    w[17] = delta > 0 ? 0.6 : delta < 0 ? -0.6 : 0;
    w[16] = delta === 0 ? 0.4 : -0.05;
    return w;
  });
}

function initialUpgradeWeights() {
  return Array.from({ length: UPGRADE_CHOICE_COUNT }, (_, index) => {
    const w = Array(UPGRADE_FEATURE_COUNT).fill(0);
    w[0] = 0.4;
    w[1] = 0.05;
    w[2] = 0.16;
    w[3] = 0.28;
    w[4] = 0.42;
    w[14] = -0.03 * index;
    return w;
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
