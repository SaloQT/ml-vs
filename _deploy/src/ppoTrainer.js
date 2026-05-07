import { GAME } from "./config.js";
import { normalize } from "./math.js";
import { normalizeMetaProgress } from "./metaProgression.js";
import { GameSimulation } from "./simulation.js";
import { HIDDEN, createHidden, hiddenForward, outputForward, backwardSGD, cloneHidden, serializeHidden, deserializeHidden } from "./mlp.js";
import { forwardFastJs, softmaxInto } from "./mlpFast.js";
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
const MODEL_FORMAT = "space-survivors-ppo";
const MODEL_VERSION = 3;
const STEP_DT = GAME.fixedStep;
const STEPS_PER_SECOND = Math.round(1 / STEP_DT);

export class PpoTrainer {
  constructor({ metaProgress = null, useGpu = false, useOrt = true } = {}) {
    this.metaProgress = normalizeMetaProgress(metaProgress ?? {});
    this.iteration = 0;
    const _env = (typeof process !== "undefined" && process.env) ? process.env : {};
    this.useGpu = Boolean(useGpu) || _env.USE_GPU === "1";
    this.useOrt = useOrt !== false && _env.USE_ORT !== "0";
    // Vectorized rollout: tick N envs in lockstep with one batched ORT forward
    // per tick. Default false to preserve existing sync-test semantics; set
    // true (or env VEC_ROLLOUT=1) to opt in. Requires ORT available.
    this.useVectorizedRollout = _env.VEC_ROLLOUT !== "0";
    this._ortMove = null;
    this._ortAim = null;
    this._ortReady = false;
    this._ortInitPromise = null;
    this.moveHidden = createHidden(FEATURE_COUNT, HIDDEN, 2001);
    this.aimHidden = createHidden(FEATURE_COUNT, HIDDEN, 2002);
    this.weights = initialOutputWeights(ACTIONS.length, HIDDEN);
    this.aimWeights = initialOutputWeights(AIM_TURN_DELTAS.length, HIDDEN);
    this.weightsBias = new Array(ACTIONS.length).fill(0);
    this.aimWeightsBias = new Array(AIM_TURN_DELTAS.length).fill(0);
    this.upgradeWeights = initialUpgradeWeights();
    this.history = [];
    this.running = false;
    this.learningRate = 0.00004;
    this.clip = 0.12;
    this.gamma = 0.985;
    this.batchSize = 2;
    this.minibatchSize = 256;
    this.maxEpisodeSeconds = GAME.ppoMaxEpisodeSeconds;
    this.warmupSeconds = 3;
    this.advantageClamp = 3;
    this.killReward = 7.5;
    this.xpReward = 0.08;
    this.damageReward = 0.025;
    this.powerupReward = 0.7;
    this.damageTakenPenalty = 0.16;
    this.survivalBonus = 0.025;
    this.deathPenalty = 35;
    this.killStreakReward = 0;
    this.killStreakWindowSeconds = 10;
    this.enemyHealthMultiplier = 1;
    this.enemySpeedMultiplier = 1;
    this.enemySpawnMultiplier = 1;
    this.filterDeathEpisodes = false;
    this._hScratch = new Array(HIDDEN);
    this._moveLogits = new Array(ACTIONS.length);
    this._aimLogits = new Array(AIM_TURN_DELTAS.length);
    this._moveProbs = new Array(ACTIONS.length);
    this._aimProbs = new Array(AIM_TURN_DELTAS.length);
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

  // Vectorized rollout: tick all N envs in lockstep, batching the per-tick
  // forward through a single ORT call (B=N) instead of N separate B=1 calls.
  // Returns Promise<EpisodeSummary[]> with same shape as runEpisodeBatch.
  // Sampling RNG scheme matches the sequential path exactly per-env: seed+tick
  // for move, seed+tick*37+17 for aim, seed+tick*997 for upgrade -- so an env
  // run alone here produces the same trajectory as runEpisode(seed) modulo any
  // numerical drift from batched matmul reorder (typically bit-equivalent for
  // our small graphs).
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

    // Per-env state.
    const envs = seeds.map((seed) => {
      const sim = new GameSimulation({
        seed,
        localPlayerId: "ppo",
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
        recentKillTimes: [],
        recentKillHead: 0,
        reward: 0,
        killsScored: 0,
        damageDealt: 0,
        damageTaken: 0,
        trajectory: [],
        done: false,
      };
    });

    const X = new Float32Array(N * F);
    for (let tick = 0; tick < maxTicks; tick += 1) {
      // Stage 1: handle upgrade-state envs (each independent), gather features
      // for envs that need a forward this tick.
      const liveIndices = [];
      const liveFeatures = [];
      const liveScans = [];
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
          if (decision && scoring) env.trajectory.push({ kind: "upgrade", ...decision, reward: 0 });
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
        const scan = this.featuresWithScan(env.sim, player);
        const slot = liveIndices.length;
        liveIndices.push(n);
        liveFeatures.push(scan.features);
        liveScans.push(scan);
        const feat = scan.features;
        for (let j = 0; j < F; j += 1) X[slot * F + j] = feat[j];
        anyLive = true;
      }

      if (!anyLive) {
        // All envs are either done or in upgrade-only path; check if any still need ticking.
        let allDone = true;
        for (let n = 0; n < N; n += 1) if (!envs[n].done) { allDone = false; break; }
        if (allDone) break;
        continue;
      }

      const B = liveIndices.length;
      // Single batched forward for both heads.
      const fwdMove = await this._ortMove.forwardBatch(X.subarray(0, B * F), B, this.moveHidden, this.weights, this.weightsBias);
      const fwdAim = await this._ortAim.forwardBatch(X.subarray(0, B * F), B, this.aimHidden, this.aimWeights, this.aimWeightsBias);
      const moveLogits = fwdMove.Logits;
      const aimLogits = fwdAim.Logits;

      // Sample per-env, apply input, step.
      for (let s = 0; s < B; s += 1) {
        const n = liveIndices[s];
        const env = envs[n];
        const player = env.sim.players.get(env.playerId);
        const features = liveFeatures[s];
        const scan = liveScans[s];
        // Softmax + sample for move
        const moveOff = s * moveActionCount;
        let mx = -Infinity;
        for (let a = 0; a < moveActionCount; a += 1) if (moveLogits[moveOff + a] > mx) mx = moveLogits[moveOff + a];
        let total = 0;
        const moveProbs = this._moveProbs;
        for (let a = 0; a < moveActionCount; a += 1) { const e = Math.exp(moveLogits[moveOff + a] - mx); moveProbs[a] = e; total += e; }
        for (let a = 0; a < moveActionCount; a += 1) moveProbs[a] /= total;
        let roll = seeded(env.seed + tick);
        let moveAction = moveActionCount - 1;
        for (let a = 0; a < moveActionCount; a += 1) { roll -= moveProbs[a]; if (roll <= 0) { moveAction = a; break; } }
        const moveProbability = moveProbs[moveAction];
        // Softmax + sample for aim
        const aimOff = s * aimActionCount;
        mx = -Infinity;
        for (let a = 0; a < aimActionCount; a += 1) if (aimLogits[aimOff + a] > mx) mx = aimLogits[aimOff + a];
        total = 0;
        const aimProbs = this._aimProbs;
        for (let a = 0; a < aimActionCount; a += 1) { const e = Math.exp(aimLogits[aimOff + a] - mx); aimProbs[a] = e; total += e; }
        for (let a = 0; a < aimActionCount; a += 1) aimProbs[a] /= total;
        let aimRoll = seeded(env.seed + tick * 37 + 17);
        let aimAction = aimActionCount - 1;
        for (let a = 0; a < aimActionCount; a += 1) { aimRoll -= aimProbs[a]; if (aimRoll <= 0) { aimAction = a; break; } }
        const aimProbability = aimProbs[aimAction];
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
        let killStreakBonus = 0;
        if (killsDelta > 0 && this.killStreakReward > 0 && this.killStreakWindowSeconds > 0) {
          const windowStart = env.sim.elapsed - this.killStreakWindowSeconds;
          while (env.recentKillHead < env.recentKillTimes.length && env.recentKillTimes[env.recentKillHead] < windowStart) {
            env.recentKillHead += 1;
          }
          for (let k = 0; k < killsDelta; k += 1) {
            env.recentKillTimes.push(env.sim.elapsed);
            const inWindow = env.recentKillTimes.length - env.recentKillHead;
            killStreakBonus += this.killStreakReward * inWindow;
          }
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
            powerupStep * this.powerupReward +
            killStreakBonus -
            takenStep * this.damageTakenPenalty -
            closeEnemyPenalty +
            healthRatio * 0.01
          : 0;
        if (scoring) env.reward += stepReward;
        env.previousKills = kills;
        env.previousHp = nextPlayer?.hp ?? 0;
        if (scoring) {
          env.trajectory.push({ kind: "move", features, action: moveAction, probability: moveProbability, reward: stepReward });
          env.trajectory.push({ kind: "aim", features, action: aimAction, probability: aimProbability, reward: stepReward });
        }
        if (env.sim.state === "upgrade") {
          const decision = this.chooseUpgrade(env.sim, env.seed + tick * 997 + 1);
          if (decision && scoring) env.trajectory.push({ kind: "upgrade", ...decision, reward: 0 });
          env.cachedEnemyHp = -1;
        }
        if (isTerminalState(env.sim.state)) env.done = true;
      }

      // Stop early if all envs are done.
      let allDone = true;
      for (let n = 0; n < N; n += 1) if (!envs[n].done) { allDone = false; break; }
      if (allDone) break;
    }

    // Build episode summaries.
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
        trajectory: env.trajectory,
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
      const episode = episodes[i];
      sumReward += episode.reward;
      sumSeconds += episode.seconds;
      sumKills += episode.kills;
      sumDamage += episode.damageDealt;
      sumDamageTaken += episode.damageTaken;
      sumScore += episode.score;
      if (episode.dead) sumDead += 1;
      ticks += Math.round(episode.seconds * STEPS_PER_SECOND);
    }
    const denom = Math.max(1, episodeCount);
    const meanReward = sumReward / denom;
    const meanSeconds = sumSeconds / denom;
    const meanKills = sumKills / denom;
    const meanDamage = sumDamage / denom;
    const meanDamageTaken = sumDamageTaken / denom;
    const meanScore = sumScore / denom;
    const deathRate = (sumDead / denom) * 100;
    const trainingEpisodes = this.filterDeathEpisodes ? episodes.filter((episode) => !episode.dead) : episodes;
    const baseline = mean(trainingEpisodes.map((episode) => episode.reward));
    const finish = () => {
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
        trainedEpisodes: trainingEpisodes.length,
        ticks,
        ticksPerSecond: Math.round(ticks / (elapsedMs / 1000)),
        elapsedMs: Math.round(elapsedMs),
      };
      this.history.push(point);
      // Cap to a rolling window. Long training sessions otherwise grow this
      // unboundedly (one entry per batch); the metric points are only used
      // for charting/observation, not for training, so dropping the oldest
      // entries past the window is observationally invisible.
      if (this.history.length > 5000) this.history.splice(0, this.history.length - 5000);
      return point;
    };
    if (this.useOrt) {
      return this.updatePolicyOrt(trainingEpisodes, baseline).then(finish);
    }
    this.updatePolicy(trainingEpisodes, baseline);
    return finish();
  }

  exportTrainingState() {
    return {
      model: this.exportModel(),
      metaProgress: this.metaProgress,
      hyperparameters: {
        learningRate: this.learningRate,
        clip: this.clip,
        gamma: this.gamma,
        batchSize: this.batchSize,
        maxEpisodeSeconds: this.maxEpisodeSeconds,
        warmupSeconds: this.warmupSeconds,
        advantageClamp: this.advantageClamp,
        killReward: this.killReward,
        xpReward: this.xpReward,
        damageReward: this.damageReward,
        powerupReward: this.powerupReward,
        damageTakenPenalty: this.damageTakenPenalty,
        survivalBonus: this.survivalBonus,
        deathPenalty: this.deathPenalty,
        killStreakReward: this.killStreakReward,
        killStreakWindowSeconds: this.killStreakWindowSeconds,
        enemyHealthMultiplier: this.enemyHealthMultiplier,
        enemySpeedMultiplier: this.enemySpeedMultiplier,
        enemySpawnMultiplier: this.enemySpawnMultiplier,
        filterDeathEpisodes: this.filterDeathEpisodes,
      },
    };
  }

  importTrainingState(state) {
    if (state?.model) this.importModel(state.model);
    this.metaProgress = normalizeMetaProgress(state?.metaProgress ?? this.metaProgress);
    const hyperparameters = state?.hyperparameters ?? {};
    for (const key of [
      "learningRate",
      "clip",
      "gamma",
      "batchSize",
      "maxEpisodeSeconds",
      "warmupSeconds",
      "advantageClamp",
      "killReward",
      "xpReward",
      "damageReward",
      "powerupReward",
      "damageTakenPenalty",
      "survivalBonus",
      "deathPenalty",
      "killStreakReward",
      "killStreakWindowSeconds",
      "enemyHealthMultiplier",
      "enemySpeedMultiplier",
      "enemySpawnMultiplier",
    ]) {
      const value = Number(hyperparameters[key]);
      if (Number.isFinite(value)) this[key] = value;
    }
    if (typeof hyperparameters.filterDeathEpisodes === "boolean") {
      this.filterDeathEpisodes = hyperparameters.filterDeathEpisodes;
    }
    return this;
  }

  runEpisode(seed) {
    const sim = new GameSimulation({
      seed,
      localPlayerId: "ppo",
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
    const recentKillTimes = [];
    let recentKillHead = 0;
    const trajectory = [];
    const warmupTicks = Math.max(0, Math.round(this.warmupSeconds * STEPS_PER_SECOND));
    const maxTicks = warmupTicks + Math.max(1, Math.round(this.maxEpisodeSeconds * STEPS_PER_SECOND));
    let cachedEnemyHp = -1;

    for (let tick = 0; tick < maxTicks && !isTerminalState(sim.state); tick += 1) {
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
      const scan = this.featuresWithScan(sim, player);
      const features = scan.features;
      const { action, probability } = this.sampleAction(features, seed + tick);
      const aimDecision = this.sampleAimAction(features, seed + tick * 37 + 17);
      const aim = rotateAim(player.aimX ?? player.facingX ?? 1, player.aimY ?? player.facingY ?? 0, AIM_TURN_DELTAS[aimDecision.action] ?? 0);
      _inputScratch.moveX = ACTIONS[action][0];
      _inputScratch.moveY = ACTIONS[action][1];
      _inputScratch.aimX = aim.x;
      _inputScratch.aimY = aim.y;
      sim.applyInput(playerId, _inputScratch);
      sim.step(STEP_DT);

      const nextPlayer = sim.players.get(playerId);
      const kills = nextPlayer?.kills ?? previousKills;
      const post = postStepEnemyScan(nextPlayer, sim.enemies);
      const currentTotalEnemyHp = post.totalHp;
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
      const killsDelta = Math.max(0, kills - previousKills);
      if (scoring) {
        killsScored += killsDelta;
        damageDealt += damageStep;
        damageTaken += takenStep;
      }
      let killStreakBonus = 0;
      if (killsDelta > 0 && this.killStreakReward > 0 && this.killStreakWindowSeconds > 0) {
        const windowStart = sim.elapsed - this.killStreakWindowSeconds;
        while (recentKillHead < recentKillTimes.length && recentKillTimes[recentKillHead] < windowStart) {
          recentKillHead += 1;
        }
        for (let k = 0; k < killsDelta; k += 1) {
          recentKillTimes.push(sim.elapsed);
          const inWindow = recentKillTimes.length - recentKillHead;
          killStreakBonus += this.killStreakReward * inWindow;
        }
      }
      const healthRatio = nextPlayer ? nextPlayer.hp / nextPlayer.stats.maxHp : 0;
      const closeEnemyPenalty = post.nearestDistSq < 22500 ? 0.055 : 0;
      const stepReward = scoring
        ? this.survivalBonus +
          (kills - previousKills) * this.killReward +
          damageStep * this.damageReward +
          xpStep * this.xpReward +
          levelStep * 8 +
          scrapStep * 0.12 +
          powerupStep * this.powerupReward +
          killStreakBonus -
          takenStep * this.damageTakenPenalty -
          closeEnemyPenalty +
          healthRatio * 0.01
        : 0;
      if (scoring) reward += stepReward;
      previousKills = kills;
      previousHp = nextPlayer?.hp ?? 0;
      if (scoring) {
        trajectory.push({ kind: "move", features, action, probability, reward: stepReward });
        trajectory.push({
          kind: "aim",
          features,
          action: aimDecision.action,
          probability: aimDecision.probability,
          reward: stepReward,
        });
      }
      if (sim.state === "upgrade") {
        const decision = this.chooseUpgrade(sim, seed + tick * 997 + 1);
        if (decision && scoring) trajectory.push({ kind: "upgrade", ...decision, reward: 0 });
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
      trajectory,
      runEventsEnabled: sim.runEvents.enabled,
      runEventsTriggered: sim.runEvents.sequence,
      stepDt: STEP_DT,
      tickRate: STEPS_PER_SECOND,
    };
  }

  updatePolicy(episodes, baseline) {
    const learningRate = this.learningRate;
    const clip = this.clip;
    const movementSteps = [];
    const aimSteps = [];
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
        else if (step.kind === "aim") aimSteps.push(step);
        else movementSteps.push(step);
      }
    }
    this.updateStepPolicy(movementSteps, this.moveHidden, this.weights, this.weightsBias, "move", learningRate, clip);
    this.updateStepPolicy(aimSteps, this.aimHidden, this.aimWeights, this.aimWeightsBias, "aim", learningRate, clip);
    this.updateUpgradePolicy(upgradeSteps, learningRate, clip);
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

  async updatePolicyOrt(episodes, baseline) {
    const ok = await this._ensureOrtSessions();
    if (!ok) { this.updatePolicy(episodes, baseline); return; }
    const learningRate = this.learningRate;
    const clip = this.clip;
    const movementSteps = [];
    const aimSteps = [];
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
        else if (step.kind === "aim") aimSteps.push(step);
        else movementSteps.push(step);
      }
    }
    await this._updateStepPolicyOrt(this._ortMove, movementSteps, this.moveHidden, this.weights, this.weightsBias, learningRate, clip);
    await this._updateStepPolicyOrt(this._ortAim, aimSteps, this.aimHidden, this.aimWeights, this.aimWeightsBias, learningRate, clip);
    // Upgrade head: small linear, JS path
    this.updateUpgradePolicy(upgradeSteps, learningRate, clip);
  }

  async _updateStepPolicyOrt(session, steps, hidden, weights, bias, learningRate, clip) {
    const stepCount = steps.length;
    if (!stepCount) return;
    const F = FEATURE_COUNT;
    const actionCount = weights.length;
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
    const mb = Math.max(1, this.minibatchSize | 0);
    for (let start = 0; start < stepCount; start += mb) {
      const end = Math.min(stepCount, start + mb);
      const B = end - start;
      const X = new Float32Array(B * F);
      for (let i = 0; i < B; i += 1) {
        const feat = steps[start + i].features;
        for (let j = 0; j < F; j += 1) X[i * F + j] = feat[j];
      }
      const fwd = await session.forwardBatch(X, B, hidden, weights, bias);
      const Logits = fwd.Logits;
      const dLogits = new Float32Array(B * actionCount);
      for (let i = 0; i < B; i += 1) {
        const off = i * actionCount;
        const step = steps[start + i];
        let mx = -Infinity;
        for (let a = 0; a < actionCount; a += 1) if (Logits[off + a] > mx) mx = Logits[off + a];
        let total = 0;
        const probs = new Float32Array(actionCount);
        for (let a = 0; a < actionCount; a += 1) { const e = Math.exp(Logits[off + a] - mx); probs[a] = e; total += e; }
        for (let a = 0; a < actionCount; a += 1) probs[a] /= total;
        // Use log-prob form to avoid blow-up when prob_old is tiny.
        let logRatio = Math.log(Math.max(probs[step.action], 1e-8)) - Math.log(Math.max(step.probability, 1e-8));
        if (logRatio < -5) logRatio = -5; else if (logRatio > 5) logRatio = 5;
        const ratio = Math.exp(logRatio);
        const clippedRatio = ratio < lowClip ? lowClip : ratio > highClip ? highClip : ratio;
        const rawAdv = (step.return - averageReturn) / returnDeviation;
        const adv = rawAdv < -advantageClamp ? -advantageClamp : rawAdv > advantageClamp ? advantageClamp : rawAdv;
        const advClipRatio = adv * clippedRatio;
        for (let a = 0; a < actionCount; a += 1) {
          const indicator = a === step.action ? 1 : 0;
          dLogits[off + a] = -(indicator - probs[a]) * advClipRatio;
        }
      }
      const grads = await session.backwardBatch(X, B, fwd.H, weights, dLogits);
      // Mini-batch scaling: divide LR by B to match per-sample SGD step magnitude
      session.applySgd(hidden, weights, bias, grads, learningRate / B);
    }
  }

  updateStepPolicy(steps, hidden, weights, bias, kind, learningRate, clip) {
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
    // Process in minibatches of >= this.minibatchSize. The math is per-sample SGD,
    // identical to summing dlogits per-sample inside a minibatch then stepping.
    const mb = Math.max(1, this.minibatchSize | 0);
    for (let start = 0; start < stepCount; start += mb) {
      const end = Math.min(stepCount, start + mb);
      for (let s = start; s < end; s += 1) {
        const step = steps[s];
        const features = step.features;
        const action = step.action;
        const h = hiddenForward(hidden, features);
        const logits = outputForward(weights, h, bias);
        // softmax
        let mx = -Infinity;
        for (let i = 0; i < actionCount; i += 1) if (logits[i] > mx) mx = logits[i];
        let total = 0;
        const probs = new Array(actionCount);
        for (let i = 0; i < actionCount; i += 1) { const e = Math.exp(logits[i] - mx); probs[i] = e; total += e; }
        for (let i = 0; i < actionCount; i += 1) probs[i] /= total;
        // Use log-prob form to avoid blow-up when prob_old is tiny.
        let logRatio = Math.log(Math.max(probs[action], 1e-8)) - Math.log(Math.max(step.probability, 1e-8));
        if (logRatio < -5) logRatio = -5; else if (logRatio > 5) logRatio = 5;
        const ratio = Math.exp(logRatio);
        const clippedRatio = ratio < lowClip ? lowClip : ratio > highClip ? highClip : ratio;
        const rawAdvantage = (step.return - averageReturn) / returnDeviation;
        const advantage =
          rawAdvantage < -advantageClamp ? -advantageClamp : rawAdvantage > advantageClamp ? advantageClamp : rawAdvantage;
        const advClipRatio = advantage * clippedRatio;
        // Loss = -log_pi(a|s) * advClipRatio approx; gradient wrt logit_a = -(indicator - prob)*advClipRatio
        const dLogits = new Array(actionCount);
        for (let a = 0; a < actionCount; a += 1) {
          const indicator = a === action ? 1 : 0;
          dLogits[a] = -(indicator - probs[a]) * advClipRatio;
        }
        backwardSGD(hidden, weights, bias, features, h, dLogits, learningRate);
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
      // Use log-prob form to avoid blow-up when prob_old is tiny.
      let logRatio = Math.log(Math.max(probabilities[action], 1e-8)) - Math.log(Math.max(step.probability, 1e-8));
      if (logRatio < -5) logRatio = -5; else if (logRatio > 5) logRatio = 5;
      const ratio = Math.exp(logRatio);
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

  featuresWithScan(source, player) {
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
    const features = this._buildFeatures(source, player, nearestEnemy, nearestEnemyDistSq, nearestPickup, nearestPickupDistSq);
    return { features, nearestEnemy, nearestEnemyDistSq, nearestPickup, nearestPickupDistSq };
  }

  features(source, player) {
    return this.featuresWithScan(source, player).features;
  }

  _buildFeatures(source, player, nearestEnemy, nearestEnemyDistSq, nearestPickup, nearestPickupDistSq) {
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
    const probabilities = this.probabilities(features);
    let action = 0;
    let bestProbability = -Infinity;
    for (let i = 0; i < probabilities.length; i += 1) {
      if (probabilities[i] > bestProbability) {
        bestProbability = probabilities[i];
        action = i;
      }
    }
    const [moveX, moveY] = ACTIONS[action];
    const aimAction = this.greedyAimAction(features);
    const aim = rotateAim(
      player.aimX ?? player.facingX ?? 1,
      player.aimY ?? player.facingY ?? 0,
      AIM_TURN_DELTAS[aimAction] ?? 0,
    );
    return { moveX, moveY, aimX: aim.x, aimY: aim.y };
  }

  chooseUpgrade(sim, seed = Date.now(), { greedy = false } = {}) {
    if (sim.state !== "upgrade" || !sim.pendingUpgradeChoices?.length) return null;
    const player = sim.players.get(sim.localPlayerId);
    if (!player) return null;
    const choiceFeatures = this.upgradeChoiceFeatures(sim, player);
    let action;
    let probability;
    if (greedy) {
      const probabilities = this.upgradeProbabilities(choiceFeatures);
      let best = -Infinity;
      action = 0;
      for (let i = 0; i < probabilities.length; i += 1) {
        if (probabilities[i] > best) {
          best = probabilities[i];
          action = i;
        }
      }
      probability = probabilities[action];
    } else {
      ({ action, probability } = this.sampleUpgradeAction(choiceFeatures, seed));
    }
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

  sampleAimAction(features, seed) {
    const probabilities = this.aimProbabilities(features);
    const random = seeded(seed);
    let roll = random;
    for (let i = 0; i < probabilities.length; i += 1) {
      roll -= probabilities[i];
      if (roll <= 0) return { action: i, probability: probabilities[i] };
    }
    return { action: probabilities.length - 1, probability: probabilities.at(-1) };
  }

  greedyAimAction(features) {
    const probabilities = this.aimProbabilities(features);
    let action = 0;
    let bestProbability = -Infinity;
    for (let i = 0; i < probabilities.length; i += 1) {
      if (probabilities[i] > bestProbability) {
        bestProbability = probabilities[i];
        action = i;
      }
    }
    return action;
  }


  probabilities(features) {
    forwardFastJs(this.moveHidden, this.weights, this.weightsBias, features, this._hScratch, this._moveLogits);
    return softmaxInto(this._moveLogits, this._moveProbs);
  }

  aimProbabilities(features) {
    forwardFastJs(this.aimHidden, this.aimWeights, this.aimWeightsBias, features, this._hScratch, this._aimLogits);
    return softmaxInto(this._aimLogits, this._aimProbs);
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

  ensureAimWeightsForFeatureCount(featureCount) {
    for (const weights of this.aimWeights) {
      while (weights.length < featureCount) weights.push(0);
    }
  }

  exportModel() {
    return {
      format: MODEL_FORMAT,
      version: MODEL_VERSION,
      exportedAt: new Date().toISOString(),
      iteration: this.iteration,
      featureCount: FEATURE_COUNT,
      hiddenCount: HIDDEN,
      actionCount: ACTIONS.length,
      aimActionCount: AIM_TURN_DELTAS.length,
      upgradeFeatureCount: this.upgradeWeights[0]?.length ?? UPGRADE_FEATURE_COUNT,
      upgradeActionCount: UPGRADE_CHOICE_COUNT,
      moveHidden: serializeHidden(this.moveHidden),
      aimHidden: serializeHidden(this.aimHidden),
      weights: this.weights.map((row) => [...row]),
      aimWeights: this.aimWeights.map((row) => [...row]),
      weightsBias: [...this.weightsBias],
      aimWeightsBias: [...this.aimWeightsBias],
      upgradeWeights: this.upgradeWeights.map((row) => [...row]),
      history: this.history.map((point) => ({ ...point })),
    };
  }

  importModel(model) {
    const normalized = normalizeModel(model);
    this.iteration = normalized.iteration;
    this.weights = normalized.weights;
    this.aimWeights = normalized.aimWeights;
    this.weightsBias = normalized.weightsBias;
    this.aimWeightsBias = normalized.aimWeightsBias;
    this.moveHidden = normalized.moveHidden;
    this.aimHidden = normalized.aimHidden;
    this.upgradeWeights = normalized.upgradeWeights;
    this.history = normalized.history;
    return this;
  }
}

function isTerminalState(state) {
  return state === "gameover" || state === "victory";
}

PpoTrainer.MODEL_FORMAT = MODEL_FORMAT;
PpoTrainer.MODEL_VERSION = MODEL_VERSION;

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

function initialOutputWeights(actionCount, hiddenSize) {
  return Array.from({ length: actionCount }, () => new Array(hiddenSize).fill(0));
}

function initialAimWeights() {
  return initialOutputWeights(AIM_TURN_DELTAS.length, HIDDEN);
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
    aimWeights: normalizeAimWeights(model.aimWeights),
    weightsBias: normalizeBias(model.weightsBias, ACTIONS.length),
    aimWeightsBias: normalizeBias(model.aimWeightsBias, AIM_TURN_DELTAS.length),
    moveHidden: deserializeHidden(model.moveHidden, FEATURE_COUNT),
    aimHidden: deserializeHidden(model.aimHidden, FEATURE_COUNT),
    upgradeWeights: normalizeUpgradeWeights(model.upgradeWeights),
    history: normalizeHistory(model.history),
  };
}

function normalizeBias(raw, count) {
  if (!Array.isArray(raw)) return new Array(count).fill(0);
  const out = new Array(count).fill(0);
  for (let i = 0; i < count; i += 1) out[i] = Number(raw[i]) || 0;
  return out;
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

function normalizeAimWeights(rawWeights) {
  if (rawWeights == null) return initialAimWeights();
  if (!Array.isArray(rawWeights) || rawWeights.length !== AIM_TURN_DELTAS.length) {
    throw new Error("PPO model aim weights do not match the aim action space.");
  }
  const featureCount = Math.max(FEATURE_COUNT, ...rawWeights.map((row) => (Array.isArray(row) ? row.length : 0)));
  return rawWeights.map((row) => {
    if (!Array.isArray(row)) throw new Error("PPO model aim weights are malformed.");
    const weights = row.map((value) => {
      const number = Number(value);
      if (!Number.isFinite(number)) throw new Error("PPO model aim weights contain invalid values.");
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
    trainedEpisodes: clampNonNegativeInteger(point?.trainedEpisodes ?? point?.episodes, 0),
    ticks: clampNonNegativeInteger(point?.ticks, 0),
    ticksPerSecond: clampNonNegativeInteger(point?.ticksPerSecond, 0),
    elapsedMs: clampNonNegativeInteger(point?.elapsedMs, 0),
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

function softmaxLogits(logits) {
  const n = logits.length;
  const out = new Array(n);
  let mx = -Infinity;
  for (let i = 0; i < n; i += 1) if (logits[i] > mx) mx = logits[i];
  let total = 0;
  for (let i = 0; i < n; i += 1) { const e = Math.exp(logits[i] - mx); out[i] = e; total += e; }
  for (let i = 0; i < n; i += 1) out[i] /= total;
  return out;
}

function softmaxRows(weights, features) {
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
