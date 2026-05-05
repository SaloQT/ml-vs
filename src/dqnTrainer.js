import { GAME } from "./config.js";
import { normalize } from "./math.js";
import { normalizeMetaProgress } from "./metaProgression.js";
import { GameSimulation } from "./simulation.js";
import { HIDDEN, createHidden, hiddenForward, outputForward, backwardSGD, cloneHidden, serializeHidden, deserializeHidden } from "./mlp.js";
import { forwardFastJs } from "./mlpFast.js";
import { OrtMlpSession, ortAvailable } from "./ortMlp.js";

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
const MODEL_VERSION = 2;
const STEP_DT = GAME.fixedStep;
const STEPS_PER_SECOND = Math.round(1 / STEP_DT);

export class DqnTrainer {
  constructor({ metaProgress = null, useGpu = false, useOrt = true } = {}) {
    this.metaProgress = normalizeMetaProgress(metaProgress ?? {});
    this.iteration = 0;
    this.name = "DQN";
    const _env = (typeof process !== "undefined" && process.env) ? process.env : {};
    this.useGpu = Boolean(useGpu) || _env.USE_GPU === "1";
    this.useOrt = useOrt !== false && _env.USE_ORT !== "0";
    this.useVectorizedRollout = _env.VEC_ROLLOUT === "1";
    this._ortMove = null; // OrtMlpSession for move head (lazy)
    this._ortAim = null;
    this._ortReady = false;
    this._ortInitPromise = null;
    // Shared hidden trunk for move + aim heads (per-head still has its own output layer).
    this.moveHidden = createHidden(FEATURE_COUNT, HIDDEN, 1001);
    this.aimHidden = createHidden(FEATURE_COUNT, HIDDEN, 1002);
    this.qWeights = initialOutputWeights(ACTIONS.length, HIDDEN);
    this.qAimWeights = initialOutputWeights(AIM_TURN_DELTAS.length, HIDDEN);
    this.qWeightsBias = new Array(ACTIONS.length).fill(0);
    this.qAimWeightsBias = new Array(AIM_TURN_DELTAS.length).fill(0);
    this.qUpgradeWeights = initialUpgradeWeights();
    this.targetMoveHidden = cloneHidden(this.moveHidden);
    this.targetAimHidden = cloneHidden(this.aimHidden);
    this.targetWeights = cloneWeights(this.qWeights);
    this.targetAimWeights = cloneWeights(this.qAimWeights);
    this.targetWeightsBias = [...this.qWeightsBias];
    this.targetAimWeightsBias = [...this.qAimWeightsBias];
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
    this.replayMinSize = 256;
    this.targetSyncEvery = 100;
    this.minibatchSize = 256;
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
    this._hScratch = new Array(HIDDEN);
    this._moveQ = new Array(ACTIONS.length);
    this._aimQ = new Array(AIM_TURN_DELTAS.length);
  }

  _epsilonGreedyFast(features, hidden, weights, bias, qOut, actionCount, epsilon, seed) {
    const r = seeded(seed);
    if (r < epsilon) {
      const r2 = seeded(seed * 2654435761 + 1);
      return Math.floor(r2 * actionCount) % actionCount;
    }
    forwardFastJs(hidden, weights, bias, features, this._hScratch, qOut);
    let bestAction = 0;
    let bestQ = qOut[0];
    for (let a = 1; a < actionCount; a += 1) {
      if (qOut[a] > bestQ) { bestQ = qOut[a]; bestAction = a; }
    }
    return bestAction;
  }

  currentEpsilon() {
    const t = Math.min(1, this._totalSteps / Math.max(1, this.epsilonDecaySteps));
    return this.epsilonStart + (this.epsilonEnd - this.epsilonStart) * t;
  }

  trainBatch(batchSize = this.batchSize) {
    const startedAt = nowMs();
    const seeds = this.batchSeeds(batchSize);
    if (this.useVectorizedRollout) {
      return this.runEpisodeBatchVectorized(seeds).then((episodes) => {
        const elapsedMs = Math.max(0.001, nowMs() - startedAt);
        return this.trainBatchFromEpisodes(episodes, elapsedMs);
      });
    }
    const episodes = this.runEpisodeBatch(seeds);
    const elapsedMs = Math.max(0.001, nowMs() - startedAt);
    return this.trainBatchFromEpisodes(episodes, elapsedMs);
  }

  batchSeeds(batchSize = this.batchSize) {
    return Array.from({ length: batchSize }, (_, i) => 9000 + this.iteration * 97 + i);
  }

  runEpisodeBatch(seeds) {
    return seeds.map((seed) => this.runEpisode(seed));
  }

  // Vectorized rollout: tick all N envs in lockstep, batching per-tick forward
  // through a single ORT call (B=N). RNG seed scheme matches sequential.
  async runEpisodeBatchVectorized(seeds) {
    const ok = await this._ensureOrtSessions();
    if (!ok) return seeds.map((seed) => this.runEpisode(seed));
    const F = FEATURE_COUNT;
    const moveActionCount = ACTIONS.length;
    const aimActionCount = AIM_TURN_DELTAS.length;
    const N = seeds.length;
    if (N === 0) return [];
    const warmupTicks = Math.max(0, Math.round(this.warmupSeconds * STEPS_PER_SECOND));
    const maxTicks = warmupTicks + Math.max(1, Math.round(this.maxEpisodeSeconds * STEPS_PER_SECOND));

    const envs = seeds.map((seed) => {
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
      return {
        seed,
        sim,
        playerId: sim.localPlayerId,
        previousKills: 0,
        previousHp: null,
        previousShield: 0,
        previousXp: 0,
        previousLevel: 1,
        previousScrap: 0,
        cachedEnemyHp: -1,
        reward: 0,
        killsScored: 0,
        damageDealt: 0,
        damageTaken: 0,
        transitions: [],
        lastFeatures: null,
        lastMoveAction: -1,
        lastAimAction: -1,
        lastStepReward: 0,
        lastScoring: false,
        done: false,
      };
    });

    const X = new Float32Array(N * F);
    for (let tick = 0; tick < maxTicks; tick += 1) {
      const liveIndices = [];
      const liveFeatures = [];
      let anyLive = false;
      for (let n = 0; n < N; n += 1) {
        const env = envs[n];
        if (env.done) continue;
        if (isTerminalState(env.sim.state)) { env.done = true; continue; }
        const player = env.sim.players.get(env.playerId);
        if (!player) { env.done = true; continue; }
        const scoring = tick >= warmupTicks;
        if (env.sim.state === "upgrade") {
          const decision = this.chooseUpgrade(env.sim, env.seed + tick * 997);
          if (decision && scoring) {
            env.transitions.push({ kind: "upgrade", choiceFeatures: decision.choiceFeatures, action: decision.action, reward: 0 });
          }
          env.cachedEnemyHp = -1;
          continue;
        }
        env.previousTotalEnemyHp = env.cachedEnemyHp >= 0 ? env.cachedEnemyHp : totalEnemyHp(env.sim.enemies);
        env.previousHp ??= player.hp;
        env.previousShield = player.shield ?? 0;
        env.previousXp = player.xp;
        env.previousLevel = player.level;
        env.previousScrap = player.scrap ?? 0;
        env.previousOverdrive = player.overdriveFor ?? 0;
        env.previousMagnetBurst = player.magnetBurstFor ?? 0;
        const features = this.features(env.sim, player);
        const slot = liveIndices.length;
        liveIndices.push(n);
        liveFeatures.push(features);
        for (let j = 0; j < F; j += 1) X[slot * F + j] = features[j];
        anyLive = true;
      }

      if (!anyLive) {
        let allDone = true;
        for (let n = 0; n < N; n += 1) if (!envs[n].done) { allDone = false; break; }
        if (allDone) break;
        continue;
      }

      const B = liveIndices.length;
      const fwdMove = await this._ortMove.forwardBatch(X.subarray(0, B * F), B, this.moveHidden, this.qWeights, this.qWeightsBias);
      const fwdAim = await this._ortAim.forwardBatch(X.subarray(0, B * F), B, this.aimHidden, this.qAimWeights, this.qAimWeightsBias);
      const moveQ = fwdMove.Logits;
      const aimQ = fwdAim.Logits;
      const epsilon = this.currentEpsilon();

      for (let s = 0; s < B; s += 1) {
        const n = liveIndices[s];
        const env = envs[n];
        const player = env.sim.players.get(env.playerId);
        const features = liveFeatures[s];
        // Epsilon-greedy: same RNG scheme as sequential path.
        const moveSeed = env.seed + tick * 11;
        const aimSeed = env.seed + tick * 37 + 17;
        let moveAction;
        if (seeded(moveSeed) < epsilon) {
          moveAction = Math.floor(seeded(moveSeed * 2654435761 + 1) * moveActionCount) % moveActionCount;
        } else {
          const off = s * moveActionCount;
          let bestA = 0; let bestQ = moveQ[off];
          for (let a = 1; a < moveActionCount; a += 1) if (moveQ[off + a] > bestQ) { bestQ = moveQ[off + a]; bestA = a; }
          moveAction = bestA;
        }
        let aimAction;
        if (seeded(aimSeed) < epsilon) {
          aimAction = Math.floor(seeded(aimSeed * 2654435761 + 1) * aimActionCount) % aimActionCount;
        } else {
          const off = s * aimActionCount;
          let bestA = 0; let bestQ = aimQ[off];
          for (let a = 1; a < aimActionCount; a += 1) if (aimQ[off + a] > bestQ) { bestQ = aimQ[off + a]; bestA = a; }
          aimAction = bestA;
        }
        const aim = rotateAim(player.aimX ?? player.facingX ?? 1, player.aimY ?? player.facingY ?? 0, AIM_TURN_DELTAS[aimAction] ?? 0);
        const input = { moveX: ACTIONS[moveAction][0], moveY: ACTIONS[moveAction][1], aimX: aim.x, aimY: aim.y };
        env.sim.applyInput(env.playerId, input);
        env.sim.step(STEP_DT);

        const scoring = tick >= warmupTicks;
        const nextPlayer = env.sim.players.get(env.playerId);
        const kills = nextPlayer?.kills ?? env.previousKills;
        const post = postStepEnemyScan(nextPlayer, env.sim.enemies);
        env.cachedEnemyHp = post.totalHp;
        const damageStep = Math.max(0, env.previousTotalEnemyHp - post.totalHp);
        const takenStep = Math.max(0, env.previousHp - (nextPlayer?.hp ?? 0));
        const shieldStep = Math.max(0, (nextPlayer?.shield ?? 0) - env.previousShield);
        const xpStep = Math.max(0, (nextPlayer?.xp ?? 0) - env.previousXp);
        const levelStep = Math.max(0, (nextPlayer?.level ?? env.previousLevel) - env.previousLevel);
        const scrapStep = Math.max(0, (nextPlayer?.scrap ?? 0) - env.previousScrap);
        const powerupStep =
          Math.max(0, (nextPlayer?.overdriveFor ?? 0) - env.previousOverdrive) +
          Math.max(0, (nextPlayer?.magnetBurstFor ?? 0) - env.previousMagnetBurst) +
          (shieldStep > 0 ? 1 : 0) +
          (scrapStep > 0 ? 1 : 0);
        const killsDelta = Math.max(0, kills - env.previousKills);
        if (scoring) {
          env.killsScored += killsDelta;
          env.damageDealt += damageStep;
          env.damageTaken += takenStep;
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
        if (scoring) env.reward += stepReward;
        env.previousKills = kills;
        env.previousHp = nextPlayer?.hp ?? 0;

        const nextFeatures = nextPlayer ? this.features(env.sim, nextPlayer) : null;
        const done = isTerminalState(env.sim.state) || !nextPlayer || nextPlayer.hp <= 0;
        if (scoring) {
          env.transitions.push({ kind: "move", features, action: moveAction, reward: stepReward, nextFeatures, done });
          env.transitions.push({ kind: "aim", features, action: aimAction, reward: stepReward, nextFeatures, done });
          this._totalSteps += 1;
        }
        if (env.sim.state === "upgrade") {
          const decision = this.chooseUpgrade(env.sim, env.seed + tick * 997 + 1);
          if (decision && scoring) {
            env.transitions.push({ kind: "upgrade", choiceFeatures: decision.choiceFeatures, action: decision.action, reward: 0 });
          }
          env.cachedEnemyHp = -1;
        }
        if (isTerminalState(env.sim.state)) env.done = true;
      }

      let allDone = true;
      for (let n = 0; n < N; n += 1) if (!envs[n].done) { allDone = false; break; }
      if (allDone) break;
    }

    return envs.map((env) => {
      const player = env.sim.players.get(env.playerId);
      const victory = env.sim.state === "victory";
      const dead = env.sim.state === "gameover" || (player?.hp ?? 0) <= 0;
      const scoredSeconds = Math.max(0, env.sim.elapsed - this.warmupSeconds);
      const countedDead = dead && scoredSeconds > 0;
      const score = scoredSeconds * 10 + env.killsScored * 45 + env.damageDealt * 0.35 - env.damageTaken * 2 + (player?.level ?? 1) * 100;
      const reward = env.reward +
        scoredSeconds * 0.25 +
        (player?.level ?? 1) * 14 +
        (player?.scrap ?? 0) * 0.2 +
        (victory ? 100 : 0) -
        (countedDead ? this.deathPenalty : 0);
      return {
        reward,
        seconds: scoredSeconds,
        kills: env.killsScored,
        damageDealt: env.damageDealt,
        damageTaken: env.damageTaken,
        dead: countedDead,
        victory,
        outcome: env.sim.outcome,
        score,
        transitions: env.transitions,
        runEventsEnabled: env.sim.runEvents.enabled,
        runEventsTriggered: env.sim.runEvents.sequence,
        stepDt: STEP_DT,
        tickRate: STEPS_PER_SECOND,
      };
    });
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
    const buildPoint = (tdLoss) => {
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
        elapsedMs: Math.round(elapsedMs),
        epsilon: Number(this.currentEpsilon().toFixed(4)),
        tdLoss: Number(tdLoss.toFixed(6)),
      };
      this.history.push(point);
      return point;
    };
    if (this.useOrt) {
      return this._learnFromReplayOrt().then(buildPoint);
    }
    return buildPoint(this._learnFromReplay());
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
      totalLoss += this._updateQ(
        this._replay,
        this.moveHidden, this.qWeights, this.qWeightsBias,
        this.targetMoveHidden, this.targetWeights, this.targetWeightsBias,
        ACTIONS.length, 7919,
      );
      count += 1;
      this._updateCount += 1;
      if (this._updateCount % this.targetSyncEvery === 0) {
        this.targetMoveHidden = cloneHidden(this.moveHidden);
        this.targetWeights = cloneWeights(this.qWeights);
        this.targetWeightsBias = [...this.qWeightsBias];
      }
    }
    if (this._replayAim.length >= this.replayMinSize) {
      totalLoss += this._updateQ(
        this._replayAim,
        this.aimHidden, this.qAimWeights, this.qAimWeightsBias,
        this.targetAimHidden, this.targetAimWeights, this.targetAimWeightsBias,
        AIM_TURN_DELTAS.length, 9173,
      );
      count += 1;
      if (this._updateCount % this.targetSyncEvery === 0) {
        this.targetAimHidden = cloneHidden(this.aimHidden);
        this.targetAimWeights = cloneWeights(this.qAimWeights);
        this.targetAimWeightsBias = [...this.qAimWeightsBias];
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

  async _ensureOrtSessions() {
    if (this._ortReady) return true;
    if (!this._ortInitPromise) {
      this._ortInitPromise = (async () => {
        if (!(await ortAvailable())) return false;
        this._ortMove = new OrtMlpSession({ F: FEATURE_COUNT, H: HIDDEN, A: ACTIONS.length });
        this._ortAim = new OrtMlpSession({ F: FEATURE_COUNT, H: HIDDEN, A: AIM_TURN_DELTAS.length });
        const ok1 = await this._ortMove.init();
        const ok2 = await this._ortAim.init();
        this._ortReady = ok1 && ok2;
        return this._ortReady;
      })();
    }
    return this._ortInitPromise;
  }

  async _learnFromReplayOrt() {
    let totalLoss = 0;
    let count = 0;
    const okOrt = await this._ensureOrtSessions();
    if (!okOrt) return this._learnFromReplay(); // graceful fallback
    if (this._replay.length >= this.replayMinSize) {
      totalLoss += await this._updateQOrt(
        this._ortMove,
        this._replay,
        this.moveHidden, this.qWeights, this.qWeightsBias,
        this.targetMoveHidden, this.targetWeights, this.targetWeightsBias,
        ACTIONS.length, 7919,
      );
      count += 1;
      this._updateCount += 1;
      if (this._updateCount % this.targetSyncEvery === 0) {
        this.targetMoveHidden = cloneHidden(this.moveHidden);
        this.targetWeights = cloneWeights(this.qWeights);
        this.targetWeightsBias = [...this.qWeightsBias];
      }
    }
    if (this._replayAim.length >= this.replayMinSize) {
      totalLoss += await this._updateQOrt(
        this._ortAim,
        this._replayAim,
        this.aimHidden, this.qAimWeights, this.qAimWeightsBias,
        this.targetAimHidden, this.targetAimWeights, this.targetAimWeightsBias,
        AIM_TURN_DELTAS.length, 9173,
      );
      count += 1;
      if (this._updateCount % this.targetSyncEvery === 0) {
        this.targetAimHidden = cloneHidden(this.aimHidden);
        this.targetAimWeights = cloneWeights(this.qAimWeights);
        this.targetAimWeightsBias = [...this.qAimWeightsBias];
      }
    }
    // Upgrade head: small linear, JS path
    if (this._replayUpgrade.length >= Math.min(16, this.replayMinSize)) {
      totalLoss += this._updateUpgradeQ(this._replayUpgrade);
      count += 1;
      if (this._updateCount % this.targetSyncEvery === 0) {
        this.targetUpgradeWeights = cloneWeights(this.qUpgradeWeights);
      }
    }
    return count > 0 ? totalLoss / count : 0;
  }

  async _updateQOrt(session, buffer, hidden, weights, bias, tHidden, tWeights, tBias, actionCount, saltA) {
    const B = Math.min(this.minibatchSize, buffer.length);
    if (B === 0) return 0;
    const F = FEATURE_COUNT;
    const indices = new Array(B);
    for (let i = 0; i < B; i += 1) {
      indices[i] = Math.floor(seeded(this._totalSteps * saltA + i * 31 + this.iteration * 13) * buffer.length) % buffer.length;
    }
    // Build X (current features), Xn (next features), and a mask for terminal/no-next.
    const X = new Float32Array(B * F);
    const Xn = new Float32Array(B * F);
    const hasNext = new Uint8Array(B);
    const actions = new Int32Array(B);
    const rewards = new Float32Array(B);
    for (let i = 0; i < B; i += 1) {
      const tr = buffer[indices[i]];
      const feat = tr.features;
      for (let j = 0; j < F; j += 1) X[i * F + j] = feat[j];
      if (!tr.done && tr.nextFeatures) {
        hasNext[i] = 1;
        const nf = tr.nextFeatures;
        for (let j = 0; j < F; j += 1) Xn[i * F + j] = nf[j];
      }
      actions[i] = tr.action | 0;
      rewards[i] = tr.reward;
    }
    // Forward online net on X, target net on Xn (using a temp pseudo-session view by feeding target weights).
    const fwd = await session.forwardBatch(X, B, hidden, weights, bias);
    const fwdT = await session.forwardBatch(Xn, B, tHidden, tWeights, tBias);
    const Logits = fwd.Logits;
    const Tlog = fwdT.Logits;
    let lossSum = 0;
    const dLogits = new Float32Array(B * actionCount);
    for (let i = 0; i < B; i += 1) {
      const off = i * actionCount;
      const a = actions[i];
      const q = Logits[off + a];
      let maxNext = 0;
      if (hasNext[i]) {
        let m = -Infinity;
        for (let k = 0; k < actionCount; k += 1) if (Tlog[off + k] > m) m = Tlog[off + k];
        if (Number.isFinite(m)) maxNext = m;
      }
      const td = rewards[i] + this.gamma * maxNext - q;
      lossSum += td * td;
      const clipped = td > 5 ? 5 : td < -5 ? -5 : td;
      dLogits[off + a] = -clipped;
    }
    const grads = await session.backwardBatch(X, B, fwd.H, weights, dLogits);
    // Mini-batch SGD: divide LR by B so per-sample step magnitude matches JS path scale.
    session.applySgd(hidden, weights, bias, grads, this.learningRate / B);
    return B > 0 ? lossSum / B : 0;
  }

  _updateQ(buffer, hidden, weights, bias, tHidden, tWeights, tBias, actionCount, saltA) {
    const sampleCount = Math.min(this.minibatchSize, buffer.length);
    let lossSum = 0;
    const lr = this.learningRate;
    // Sample indices first so we have a clear minibatch (≥256 by default).
    const indices = new Array(sampleCount);
    for (let i = 0; i < sampleCount; i += 1) {
      indices[i] = Math.floor(
        seeded(this._totalSteps * saltA + i * 31 + this.iteration * 13) * buffer.length,
      ) % buffer.length;
    }
    for (let i = 0; i < sampleCount; i += 1) {
      const tr = buffer[indices[i]];
      const features = tr.features;
      const action = tr.action;
      // Forward online net Q(s, .)
      const h = hiddenForward(hidden, features);
      const q = outputForward(weights, h, bias)[action];
      // Target Q(s', .)
      let maxNext = 0;
      if (!tr.done && tr.nextFeatures) {
        const tH = hiddenForward(tHidden, tr.nextFeatures);
        const tQ = outputForward(tWeights, tH, tBias);
        let m = -Infinity;
        for (let a = 0; a < actionCount; a += 1) if (tQ[a] > m) m = tQ[a];
        maxNext = Number.isFinite(m) ? m : 0;
      }
      const td = tr.reward + this.gamma * maxNext - q;
      lossSum += td * td;
      const clipped = td > 5 ? 5 : td < -5 ? -5 : td;
      // Loss = 0.5 * td^2; dQ = -td (since td = target - q). dLogits[action] = -clipped.
      const dLogits = new Array(actionCount).fill(0);
      dLogits[action] = -clipped;
      backwardSGD(hidden, weights, bias, features, h, dLogits, lr);
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
      const moveAction = this._epsilonGreedyFast(features, this.moveHidden, this.qWeights, this.qWeightsBias, this._moveQ, ACTIONS.length, epsilon, seed + tick * 11);
      const aimAction = this._epsilonGreedyFast(features, this.aimHidden, this.qAimWeights, this.qAimWeightsBias, this._aimQ, AIM_TURN_DELTAS.length, epsilon, seed + tick * 37 + 17);
      const aim = rotateAim(player.aimX ?? player.facingX ?? 1, player.aimY ?? player.facingY ?? 0, AIM_TURN_DELTAS[aimAction] ?? 0);
      _inputScratch.moveX = ACTIONS[moveAction][0];
      _inputScratch.moveY = ACTIONS[moveAction][1];
      _inputScratch.aimX = aim.x;
      _inputScratch.aimY = aim.y;
      sim.applyInput(playerId, _inputScratch);
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

  epsilonGreedy(features, hidden, weights, bias, actionCount, epsilon, seed) {
    const r = seeded(seed);
    if (r < epsilon) {
      const r2 = seeded(seed * 2654435761 + 1);
      return Math.floor(r2 * actionCount) % actionCount;
    }
    const h = hiddenForward(hidden, features);
    const q = outputForward(weights, h, bias);
    let bestAction = 0;
    let bestQ = -Infinity;
    for (let a = 0; a < actionCount; a += 1) {
      if (q[a] > bestQ) { bestQ = q[a]; bestAction = a; }
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
    const moveAction = this.epsilonGreedy(features, this.moveHidden, this.qWeights, this.qWeightsBias, ACTIONS.length, 0, 1);
    const aimAction = this.epsilonGreedy(features, this.aimHidden, this.qAimWeights, this.qAimWeightsBias, AIM_TURN_DELTAS.length, 0, 1);
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
      featureCount: FEATURE_COUNT,
      hiddenCount: HIDDEN,
      actionCount: ACTIONS.length,
      aimActionCount: AIM_TURN_DELTAS.length,
      upgradeFeatureCount: this.qUpgradeWeights[0]?.length ?? UPGRADE_FEATURE_COUNT,
      upgradeActionCount: UPGRADE_CHOICE_COUNT,
      moveHidden: serializeHidden(this.moveHidden),
      aimHidden: serializeHidden(this.aimHidden),
      qWeights: cloneWeights(this.qWeights),
      qAimWeights: cloneWeights(this.qAimWeights),
      qWeightsBias: [...this.qWeightsBias],
      qAimWeightsBias: [...this.qAimWeightsBias],
      qUpgradeWeights: cloneWeights(this.qUpgradeWeights),
      targetMoveHidden: serializeHidden(this.targetMoveHidden),
      targetAimHidden: serializeHidden(this.targetAimHidden),
      targetWeights: cloneWeights(this.targetWeights),
      targetAimWeights: cloneWeights(this.targetAimWeights),
      targetWeightsBias: [...this.targetWeightsBias],
      targetAimWeightsBias: [...this.targetAimWeightsBias],
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
    this.qWeights = normalizeWeightRows(model.qWeights, ACTIONS.length, HIDDEN);
    this.qAimWeights = normalizeWeightRows(model.qAimWeights, AIM_TURN_DELTAS.length, HIDDEN);
    this.qWeightsBias = (model.qWeightsBias ?? new Array(ACTIONS.length).fill(0)).map(Number);
    this.qAimWeightsBias = (model.qAimWeightsBias ?? new Array(AIM_TURN_DELTAS.length).fill(0)).map(Number);
    this.moveHidden = deserializeHidden(model.moveHidden, FEATURE_COUNT);
    this.aimHidden = deserializeHidden(model.aimHidden, FEATURE_COUNT);
    this.qUpgradeWeights = normalizeWeightRows(model.qUpgradeWeights, UPGRADE_CHOICE_COUNT, UPGRADE_FEATURE_COUNT);
    this.targetWeights = normalizeWeightRows(model.targetWeights ?? model.qWeights, ACTIONS.length, HIDDEN);
    this.targetAimWeights = normalizeWeightRows(model.targetAimWeights ?? model.qAimWeights, AIM_TURN_DELTAS.length, HIDDEN);
    this.targetWeightsBias = (model.targetWeightsBias ?? this.qWeightsBias).map(Number);
    this.targetAimWeightsBias = (model.targetAimWeightsBias ?? this.qAimWeightsBias).map(Number);
    this.targetMoveHidden = deserializeHidden(model.targetMoveHidden ?? model.moveHidden, FEATURE_COUNT);
    this.targetAimHidden = deserializeHidden(model.targetAimHidden ?? model.aimHidden, FEATURE_COUNT);
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

const _aimScratch = { x: 1, y: 0 };
function rotateAim(x, y, delta) {
  const len = Math.sqrt(x * x + y * y) || 1;
  const bx = x / len;
  const by = y / len;
  const cos = Math.cos(delta);
  const sin = Math.sin(delta);
  const rx = bx * cos - by * sin;
  const ry = bx * sin + by * cos;
  const rlen = Math.sqrt(rx * rx + ry * ry) || 1;
  _aimScratch.x = rx / rlen;
  _aimScratch.y = ry / rlen;
  return _aimScratch;
}
const _inputScratch = { moveX: 0, moveY: 0, aimX: 1, aimY: 0 };

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

function initialOutputWeights(actionCount, hiddenSize) {
  // Small symmetric init around 0; hidden trunk handles representation.
  return Array.from({ length: actionCount }, () => new Array(hiddenSize).fill(0));
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
