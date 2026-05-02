import { DIFFICULTY, GAME, NETWORK, PLAYER_BASE, RUN_EVENTS } from "./config.js";
import { createEffect, createEnemy, createPickup, createPlayer, createProjectile } from "./entities.js";
import { clamp, distanceSq, normalize, Rng } from "./math.js";
import { applyMetaProgress, normalizeMetaProgress } from "./metaProgression.js";
import { createTargetingConfig, mergeTargetingConfig, selectTarget } from "./targeting.js";
import { pickUpgradeChoices, UPGRADE_POOL } from "./upgrades.js";

const ELITE_ROTATION = [
  {
    id: "rift-charger",
    type: "charger",
    affixes: ["hasted", "volatile"],
    hpMultiplier: 2.4,
    speedMultiplier: 1.08,
    damageBonus: 4,
    xpBonus: 12,
    radiusBonus: 5,
  },
  {
    id: "warden-captain",
    type: "warden",
    affixes: ["armored", "regenerating"],
    hpMultiplier: 2.8,
    speedMultiplier: 0.92,
    damageBonus: 5,
    xpBonus: 14,
    radiusBonus: 6,
    armorBonus: 3,
  },
];

const BOSS_ROTATION = [
  {
    id: "brood-splitter",
    type: "splitter",
    affixes: ["regenerating"],
    hpMultiplier: 8.5,
    speedMultiplier: 0.76,
    damageBonus: 8,
    xpBonus: 46,
    radiusBonus: 22,
    splitCount: 6,
  },
  {
    id: "siphon-prime",
    type: "siphon",
    affixes: ["armored"],
    hpMultiplier: 9,
    speedMultiplier: 0.82,
    damageBonus: 9,
    xpBonus: 52,
    radiusBonus: 23,
    armorBonus: 2,
  },
  {
    id: "bastion-bulwark",
    type: "bulwark",
    affixes: ["armored", "regenerating"],
    hpMultiplier: 9.5,
    speedMultiplier: 0.68,
    damageBonus: 12,
    xpBonus: 58,
    radiusBonus: 24,
    armorBonus: 4,
  },
  {
    id: "nova-spitter",
    type: "spitter",
    affixes: ["volatile", "hasted"],
    hpMultiplier: 7.8,
    speedMultiplier: 0.88,
    damageBonus: 10,
    xpBonus: 50,
    radiusBonus: 21,
  },
];

const BOSS_SPAWN_TELEGRAPH_DURATION = 2.5;

export class GameSimulation {
  constructor({ seed = Date.now(), localPlayerId = "p1", targeting = {}, metaProgress = {}, headless = false, enableRunEvents = undefined, enemyHealthMultiplier = 1, enemySpeedMultiplier = 1, enemySpawnMultiplier = 1, runMode = "normal" } = {}) {
    this.enemyHealthMultiplier = Number.isFinite(enemyHealthMultiplier) && enemyHealthMultiplier > 0 ? enemyHealthMultiplier : 1;
    this.enemySpeedMultiplier = Number.isFinite(enemySpeedMultiplier) && enemySpeedMultiplier > 0 ? enemySpeedMultiplier : 1;
    this.enemySpawnMultiplier = Number.isFinite(enemySpawnMultiplier) && enemySpawnMultiplier > 0 ? enemySpawnMultiplier : 1;
    this.runMode = runMode === "overrun" ? "overrun" : "normal";
    this.outcome = null;
    this.difficulty = difficultyAt(0);
    this.rng = new Rng(seed);
    this.runEventRng = new Rng((seed >>> 0) ^ 0x9e3779b9);
    this.targeting = createTargetingConfig(targeting);
    this._targetingCache = buildTargetingCache(this.targeting.primaryWeapon);
    this.metaProgress = normalizeMetaProgress(metaProgress);
    this.headless = headless;
    this.localPlayerId = localPlayerId;
    this.tick = 0;
    this.elapsed = 0;
    this.nextEntityId = 1;
    this.state = "playing";
    this.pendingUpgradeChoices = [];
    this.players = new Map();
    this.enemies = new Map();
    this.projectiles = new Map();
    this.pickups = new Map();
    this.effects = new Map();
    this.inputs = new Map();
    const runEventsEnabled = enableRunEvents ?? !headless;
    this.runEvents = {
      enabled: Boolean(runEventsEnabled),
      nextAt: null,
      active: [],
      alert: null,
      sequence: 0,
    };
    if (this.runEvents.enabled) this.scheduleNextRunEvent(RUN_EVENTS.firstEventDelay);
    this.wave = 1;
    this.spawnTimer = 0;
    this.nextEliteSpawnAt = 75;
    this.nextBossSpawnAt = 135;
    this.bossSpawnTelegraph = null;
    this.elitesSpawned = 0;
    this.bossesSpawned = 0;
    this.addPlayer(localPlayerId);
  }

  addPlayer(id) {
    const spawnAngle = this.rng.range(0, Math.PI * 2);
    const player = createPlayer(id, Math.cos(spawnAngle) * 80, Math.sin(spawnAngle) * 80);
    applyMetaProgress(player, this.metaProgress);
    this.players.set(id, player);
    this.inputs.set(id, { moveX: 0, moveY: 0, aimX: player.facingX, aimY: player.facingY });
    return player;
  }

  removePlayer(id) {
    this.players.delete(id);
    this.inputs.delete(id);
  }

  applyInput(playerId, input) {
    const current = this.inputs.get(playerId) ?? {};
    this.inputs.set(playerId, {
      moveX: clamp(input.moveX ?? current.moveX ?? 0, -1, 1),
      moveY: clamp(input.moveY ?? current.moveY ?? 0, -1, 1),
      aimX: clamp(input.aimX ?? current.aimX ?? 1, -1, 1),
      aimY: clamp(input.aimY ?? current.aimY ?? 0, -1, 1),
    });
  }

  setTargetingConfig(targeting) {
    this.targeting = mergeTargetingConfig(this.targeting, targeting);
    this._targetingCache = buildTargetingCache(this.targeting.primaryWeapon);
  }

  step(dt) {
    if (this.state !== "playing") return;
    this.tick += 1;
    this.elapsed += dt;
    this.wave = 1 + Math.floor(this.elapsed / 45);
    this.updateRunEvents(dt);
    this.updatePlayers(dt);
    this.updateSpawning(dt);
    this.updateEnemies(dt);
    this.updateProjectiles(dt);
    this.updateDrones(dt);
    this.updatePickups(dt);
    this.updateEffects(dt);
    this.cleanupFarEntities();
    this.checkGameOver();
    this.checkRunOutcome();
  }

  chooseUpgrade(upgradeId) {
    const upgrade = UPGRADE_POOL.find((item) => item.id === upgradeId);
    const player = this.players.get(this.localPlayerId);
    if (!upgrade || !player || this.state !== "upgrade") return;
    upgrade.apply(player);
    player.ownedUpgrades.add(upgrade.id);
    player.upgradeStacks.set(upgrade.id, (player.upgradeStacks.get(upgrade.id) ?? 0) + 1);
    this.pendingUpgradeChoices = [];
    this.state = "playing";
  }

  getSnapshot() {
    const difficulty = this.currentDifficulty();
    return {
      protocolVersion: NETWORK.protocolVersion,
      tick: this.tick,
      elapsed: this.elapsed,
      state: this.state,
      runMode: this.runMode,
      outcome: this.outcome,
      difficulty,
      wave: this.wave,
      localPlayerId: this.localPlayerId,
      players: [...this.players.values()].map((player) => ({
        ...player,
        ownedUpgrades: [...player.ownedUpgrades],
        upgradeStacks: Object.fromEntries(player.upgradeStacks),
      })),
      enemies: [...this.enemies.values()],
      projectiles: [...this.projectiles.values()],
      pickups: [...this.pickups.values()],
      effects: [...this.effects.values()],
      runEvents: {
        enabled: this.runEvents.enabled,
        nextAt: this.runEvents.nextAt,
        active: this.runEvents.active.map((event) => ({ ...event })),
        alert: this.runEvents.alert ? { ...this.runEvents.alert } : null,
      },
      bossSpawnTelegraph: this.bossSpawnTelegraph ? { ...this.bossSpawnTelegraph } : null,
      pendingUpgradeChoices: this.pendingUpgradeChoices,
      targeting: this.targeting,
    };
  }

  scheduleNextRunEvent(delayRange = RUN_EVENTS.interval) {
    if (!this.runEvents.enabled) return;
    this.runEvents.nextAt = this.elapsed + this.runEventRng.range(delayRange[0], delayRange[1]);
  }

  updateRunEvents(dt) {
    if (!this.runEvents.enabled) return;
    this.runEvents.alert = null;
    if (this.runEvents.nextAt !== null) {
      const timeUntilNext = this.runEvents.nextAt - this.elapsed;
      if (timeUntilNext <= RUN_EVENTS.alertLeadTime && timeUntilNext > 0) {
        this.runEvents.alert = {
          type: "incoming",
          label: "RUN EVENT",
          timeRemaining: timeUntilNext,
        };
      }
      if (this.elapsed >= this.runEvents.nextAt) {
        this.startRunEvent();
        this.scheduleNextRunEvent();
      }
    }

    for (const event of this.runEvents.active) {
      if (event.type === RUN_EVENTS.laneSweep.id) this.updateLaneSweep(event);
      if (event.type === RUN_EVENTS.rewardCache.id) this.updateRewardCache(event);
    }
    this.runEvents.active = this.runEvents.active.filter((event) => this.elapsed < event.endAt);
  }

  startRunEvent() {
    const type = this.pickRunEventType();
    const event = type === RUN_EVENTS.rewardCache.id ? this.createRewardCacheEvent() : this.createLaneSweepEvent();
    this.runEvents.active.push(event);
    this.runEvents.alert = {
      type: event.type,
      label: event.label,
      timeRemaining: event.triggerAt - this.elapsed,
    };
  }

  pickRunEventType() {
    const options = [RUN_EVENTS.laneSweep, RUN_EVENTS.rewardCache];
    const totalWeight = options.reduce((sum, event) => sum + event.weight, 0);
    let roll = this.runEventRng.next() * totalWeight;
    for (const event of options) {
      roll -= event.weight;
      if (roll <= 0) return event.id;
    }
    return RUN_EVENTS.laneSweep.id;
  }

  createLaneSweepEvent() {
    const player = this.players.get(this.localPlayerId) ?? [...this.players.values()][0];
    const baseAngle = player ? Math.atan2(player.facingY ?? 0, player.facingX ?? 1) : 0;
    const angle = baseAngle + this.runEventRng.range(-0.85, 0.85) + Math.PI / 2;
    const normalX = Math.cos(angle);
    const normalY = Math.sin(angle);
    const offset = this.runEventRng.range(-220, 220);
    const centerX = (player?.x ?? 0) + normalX * offset;
    const centerY = (player?.y ?? 0) + normalY * offset;
    const triggerAt = this.elapsed + RUN_EVENTS.laneSweep.telegraphDuration;
    return {
      id: `run-event-${this.runEvents.sequence += 1}`,
      type: RUN_EVENTS.laneSweep.id,
      label: RUN_EVENTS.laneSweep.label,
      x: centerX,
      y: centerY,
      dirX: -normalY,
      dirY: normalX,
      normalX,
      normalY,
      width: RUN_EVENTS.laneSweep.width,
      length: RUN_EVENTS.laneSweep.length,
      damage: RUN_EVENTS.laneSweep.damage,
      startedAt: this.elapsed,
      triggerAt,
      endAt: triggerAt + RUN_EVENTS.laneSweep.activeDuration,
      damagedPlayerIds: [],
    };
  }

  createRewardCacheEvent() {
    const player = this.players.get(this.localPlayerId) ?? [...this.players.values()][0];
    const angle = this.runEventRng.range(0, Math.PI * 2);
    const distance = this.runEventRng.range(RUN_EVENTS.rewardCache.distance[0], RUN_EVENTS.rewardCache.distance[1]);
    const x = (player?.x ?? 0) + Math.cos(angle) * distance;
    const y = (player?.y ?? 0) + Math.sin(angle) * distance;
    const triggerAt = this.elapsed + RUN_EVENTS.rewardCache.telegraphDuration;
    return {
      id: `run-event-${this.runEvents.sequence += 1}`,
      type: RUN_EVENTS.rewardCache.id,
      label: RUN_EVENTS.rewardCache.label,
      x,
      y,
      radius: 76,
      startedAt: this.elapsed,
      triggerAt,
      endAt: triggerAt + RUN_EVENTS.rewardCache.activeDuration,
      pickupId: null,
      collectedAt: null,
    };
  }

  updateLaneSweep(event) {
    if (this.elapsed < event.triggerAt) return;
    for (const player of this.players.values()) {
      if (player.hp <= 0 || event.damagedPlayerIds.includes(player.id)) continue;
      const dx = player.x - event.x;
      const dy = player.y - event.y;
      const along = dx * event.dirX + dy * event.dirY;
      const across = dx * event.normalX + dy * event.normalY;
      if (Math.abs(along) > event.length / 2 || Math.abs(across) > event.width / 2 + player.radius) continue;
      const incomingDamage = Math.max(1, event.damage - this.playerArmor(player));
      this.damagePlayer(player, incomingDamage, PLAYER_BASE.invulnerability * 0.75 + player.stats.invulnerabilityBonus);
      event.damagedPlayerIds.push(player.id);
    }
  }

  updateRewardCache(event) {
    if (event.pickupId || this.elapsed < event.triggerAt) return;
    const pickup = createPickup(this.entityId(), event.x, event.y, RUN_EVENTS.rewardCache.value, "cache");
    pickup.runEventId = event.id;
    event.pickupId = pickup.id;
    this.pickups.set(pickup.id, pickup);
  }

  updatePlayers(dt) {
    const worldRadius = GAME.worldRadius;
    for (const player of this.players.values()) {
      const input = this.inputs.get(player.id) ?? { moveX: 0, moveY: 0 };
      const mx = input.moveX;
      const my = input.moveY;
      const moveLen = Math.hypot(mx, my);
      const moveNx = moveLen ? mx / moveLen : 0;
      const moveNy = moveLen ? my / moveLen : 0;
      player.overdriveFor = Math.max(0, (player.overdriveFor ?? 0) - dt);
      player.magnetBurstFor = Math.max(0, (player.magnetBurstFor ?? 0) - dt);
      player.pickupSpeedBurstFor = Math.max(0, (player.pickupSpeedBurstFor ?? 0) - dt);
      const speed = this.playerSpeed(player);
      player.vx = moveNx * speed;
      player.vy = moveNy * speed;
      const newX = player.x + player.vx * dt;
      const newY = player.y + player.vy * dt;
      player.x = newX < -worldRadius ? -worldRadius : newX > worldRadius ? worldRadius : newX;
      player.y = newY < -worldRadius ? -worldRadius : newY > worldRadius ? worldRadius : newY;
      player.invulnerableFor = Math.max(0, player.invulnerableFor - dt);
      player.shieldRechargeCooldown = Math.max(0, (player.shieldRechargeCooldown ?? 0) - dt);
      player.cooldown -= dt;
      if (player.stats.regen > 0 && player.hp < player.stats.maxHp * 0.7) {
        player.hp = Math.min(player.stats.maxHp, player.hp + player.stats.regen * dt);
      }
      if ((player.crisisRepairRemaining ?? 0) > 0) {
        const duration = Math.max(0.1, player.stats.crisisRepairDuration);
        const healing = (player.stats.crisisRepair / duration) * Math.min(dt, player.crisisRepairRemaining);
        player.hp = Math.min(player.stats.maxHp, player.hp + healing);
        player.crisisRepairRemaining = Math.max(0, player.crisisRepairRemaining - dt);
      }
      if (
        player.stats.crisisRepair > 0 &&
        !player.crisisRepairUsed &&
        player.hp > 0 &&
        player.hp <= player.stats.maxHp * player.stats.crisisRepairThreshold
      ) {
        player.crisisRepairUsed = true;
        player.crisisRepairRemaining = player.stats.crisisRepairDuration;
        this.spawnCollectionEffect(player, "repair");
      }
      if (player.stats.shieldRechargeRate > 0 && player.shieldRechargeCooldown <= 0) {
        const rechargeCap = Math.min(this.playerShieldCap(player), player.stats.shieldRechargeCap);
        if ((player.shield ?? 0) < rechargeCap) {
          player.shield = Math.min(rechargeCap, (player.shield ?? 0) + player.stats.shieldRechargeRate * dt);
        }
      }
      if (
        player.stats.emergencyShield > 0 &&
        !player.emergencyShieldUsed &&
        player.hp > 0 &&
        player.hp <= player.stats.maxHp * 0.35
      ) {
        player.shield = Math.max(player.shield ?? 0, player.stats.emergencyShield);
        player.emergencyShieldUsed = true;
        this.spawnCollectionEffect(player, "shield");
      }

      const aim = normalize(input.aimX ?? player.aimX ?? player.facingX ?? 1, input.aimY ?? player.aimY ?? player.facingY ?? 0);
      const aimDx = aim.x || player.facingX || 1;
      const aimDy = aim.y || player.facingY || 0;
      player.aimX = aimDx;
      player.aimY = aimDy;
      const turnBlend = 1 - Math.exp(-10 * dt);
      const facingX = player.facingX + (aimDx - player.facingX) * turnBlend;
      const facingY = player.facingY + (aimDy - player.facingY) * turnBlend;
      const facingLen = Math.hypot(facingX, facingY);
      if (facingLen) {
        player.facingX = facingX / facingLen || 1;
        player.facingY = facingY / facingLen || 0;
      } else {
        player.facingX = 1;
        player.facingY = 0;
      }

      if (player.cooldown <= 0) {
        this.fireVolley(player, { x: aimDx, y: aimDy });
        player.cooldown = 0.42 / this.playerFireRate(player);
      }
    }
  }

  fireVolley(player, aimDirection = null) {
    const direction = normalize(aimDirection?.x ?? player.facingX, aimDirection?.y ?? player.facingY);
    const spread = 0.18;
    const count = player.stats.projectiles;
    for (let i = 0; i < count; i += 1) {
      const offset = (i - (count - 1) / 2) * spread;
      const cos = Math.cos(offset);
      const sin = Math.sin(offset);
      const dx = direction.x * cos - direction.y * sin;
      const dy = direction.x * sin + direction.y * cos;
      const damageRoll = this.rollWeaponDamage(player);
      const projectile = createProjectile(
        this.entityId(),
        player.id,
        player.x + dx * 24,
        player.y + dy * 24,
        dx * player.stats.projectileSpeed,
        dy * player.stats.projectileSpeed,
        damageRoll.damage,
        player.stats.projectileRadius,
        player.stats.projectileTtl,
        {
          acceleration: player.stats.projectileAcceleration,
          maxSpeedMultiplier: player.stats.projectileMaxSpeedMultiplier,
          isCritical: damageRoll.isCritical,
          executeThreshold: player.stats.critExecuteThreshold,
          burnDps: player.stats.burnDps,
          burnDuration: player.stats.burnDuration,
          markDamageTakenMultiplier: player.stats.markDamageTakenMultiplier,
          markDuration: player.stats.markDuration,
          pierce: player.stats.projectilePierce,
          color: player.stats.projectileColor,
          glowColor: player.stats.projectileGlowColor,
          chainArcs: player.stats.chainArcs,
          chainRange: player.stats.chainRange,
          chainDamageMultiplier: player.stats.chainDamageMultiplier,
          chainForks: player.stats.chainForks,
          ricochetBounces: player.stats.ricochetBounces,
          ricochetRange: player.stats.ricochetRange,
          ricochetDamageMultiplier: player.stats.ricochetDamageMultiplier,
          splashRadius: player.stats.splashRadius * player.stats.area,
          splashDamageMultiplier: player.stats.splashDamageMultiplier,
          splashCenterBonusPerTarget: player.stats.splashCenterBonusPerTarget,
          droneArcDamagePerDrone: player.stats.droneArcDamagePerDrone,
          droneArcRange: player.stats.droneArcRange,
        },
      );
      this.projectiles.set(projectile.id, projectile);
    }

    player.shotCount += 1;
    if (player.stats.gravityWell && player.shotCount % 10 === 0) {
      this.spawnGravityBurst(player);
    }
  }

  directionToPrimaryTarget(player) {
    const target = this.primaryTargetFor(player);
    return target ? normalize(target.x - player.x, target.y - player.y) : { x: 1, y: 0 };
  }

  rollDamage(player) {
    return this.rollWeaponDamage(player).damage;
  }

  rollWeaponDamage(player) {
    const crit = this.rng.next() < player.stats.critChance;
    const speedRatio = Math.min(1, Math.hypot(player.vx ?? 0, player.vy ?? 0) / Math.max(1, this.playerSpeed(player)));
    const velocityBonus = 1 + speedRatio * (player.stats.velocityDamageBonus ?? 0);
    return {
      damage: player.stats.damage * velocityBonus * (crit ? player.stats.critDamage : 1),
      isCritical: crit,
    };
  }

  primaryTargetFor(player) {
    return selectTarget(player, [...this.enemies.values()], this.targeting.primaryWeapon, this.rng);
  }

  canFirePrimaryWeapon(player) {
    return Boolean(this.primaryWeaponAim(player));
  }

  primaryWeaponAim(player) {
    const targetDirection = normalize(player.aimX ?? player.facingX ?? 1, player.aimY ?? player.facingY ?? 0);
    return { target: null, direction: targetDirection };
  }

  updatePlayerFacing(player, dt) {
    const desired = this.directionToPrimaryTarget(player);
    const turnSpeed = 10;
    const blend = 1 - Math.exp(-turnSpeed * dt);
    const facing = normalize(
      player.facingX + (desired.x - player.facingX) * blend,
      player.facingY + (desired.y - player.facingY) * blend,
    );
    player.facingX = facing.x || 1;
    player.facingY = facing.y || 0;
  }

  updateSpawning(dt) {
    this.spawnTimer -= dt;
    const spawnMultiplier = this.effectiveSpawnMultiplier();
    const enemyCap = Math.max(1, Math.round(GAME.maxEnemies * spawnMultiplier));
    const alivePlayers = [...this.players.values()].filter((player) => player.hp > 0);
    if (!alivePlayers.length) return;
    this.updateBossSpawnTelegraph(alivePlayers);
    this.spawnScheduledEnemies(alivePlayers, enemyCap);
    if (this.spawnTimer > 0 || this.enemies.size >= enemyCap) return;
    const basePack = Math.min(3 + this.wave, 15);
    const packSize = Math.max(1, Math.round(basePack * spawnMultiplier));
    for (let i = 0; i < packSize; i += 1) {
      const target = this.rng.pick(alivePlayers);
      const angle = this.rng.range(0, Math.PI * 2);
      const distance = this.rng.range(650, 900);
      const typeRoll = this.rng.next();
      const splitterChance = this.wave >= 2 ? Math.min(0.04 + this.wave * 0.008, 0.14) : 0;
      const stalkerChance = this.wave >= 2 ? Math.min(0.05 + this.wave * 0.006, 0.13) : 0;
      const spitterChance = this.wave >= 4 ? Math.min(0.035 + this.wave * 0.005, 0.1) : 0;
      const bulwarkChance = this.wave >= 5 ? Math.min(0.025 + this.wave * 0.004, 0.08) : 0;
      const chargerChance = this.wave >= 3 ? Math.min(0.045 + this.wave * 0.006, 0.13) : 0;
      const siphonChance = this.wave >= 6 ? Math.min(0.025 + this.wave * 0.005, 0.09) : 0;
      const wardenChance = this.wave >= 8 ? Math.min(0.018 + this.wave * 0.004, 0.07) : 0;
      const bruiserChance = Math.min(0.1 + this.wave * 0.015, 0.35);
      const type =
        typeRoll < splitterChance
          ? "splitter"
          : typeRoll < splitterChance + stalkerChance
            ? "stalker"
            : typeRoll < splitterChance + stalkerChance + spitterChance
              ? "spitter"
              : typeRoll < splitterChance + stalkerChance + spitterChance + bulwarkChance
                ? "bulwark"
                : typeRoll < splitterChance + stalkerChance + spitterChance + bulwarkChance + chargerChance
                  ? "charger"
                  : typeRoll < splitterChance + stalkerChance + spitterChance + bulwarkChance + chargerChance + siphonChance
                    ? "siphon"
                    : typeRoll < splitterChance + stalkerChance + spitterChance + bulwarkChance + chargerChance + siphonChance + wardenChance
                      ? "warden"
                      : typeRoll <
                            splitterChance +
                              stalkerChance +
                              spitterChance +
                              bulwarkChance +
                              chargerChance +
                              siphonChance +
                              wardenChance +
                              bruiserChance
                        ? "bruiser"
                        : "drone";
      const affixes = this.rollEnemyAffixes();
      const enemy = createEnemy(
        this.entityId(),
        type,
        target.x + Math.cos(angle) * distance,
        target.y + Math.sin(angle) * distance,
        this.wave,
        { affixes },
      );
      this.applyEnemyScaling(enemy);
      this.enemies.set(enemy.id, enemy);
    }
    this.spawnTimer = Math.max(0.28, (1.7 - this.wave * 0.08) / Math.sqrt(spawnMultiplier));
  }

  spawnScheduledEnemies(alivePlayers, enemyCap) {
    if (this.enemies.size < enemyCap && this.elapsed >= this.nextEliteSpawnAt) {
      this.spawnElite(alivePlayers);
      this.elitesSpawned += 1;
      const interval = Math.max(34, 62 - this.wave * 1.2);
      this.nextEliteSpawnAt = Math.max(this.nextEliteSpawnAt + interval, this.elapsed + interval);
    }
    if (this.enemies.size < enemyCap && this.elapsed >= this.nextBossSpawnAt) {
      this.spawnBoss(alivePlayers);
      this.bossesSpawned += 1;
      this.nextBossSpawnAt = Math.max(this.nextBossSpawnAt + 135, this.elapsed + 135);
      this.bossSpawnTelegraph = null;
    }
  }

  updateBossSpawnTelegraph(alivePlayers) {
    if (this.bossSpawnTelegraph || this.elapsed < this.nextBossSpawnAt - BOSS_SPAWN_TELEGRAPH_DURATION) return;
    const definition = BOSS_ROTATION[this.bossesSpawned % BOSS_ROTATION.length];
    const target = this.rng.pick(alivePlayers);
    if (!target) return;
    const angle = this.rng.range(0, Math.PI * 2);
    const distance = this.rng.range(760, 940);
    this.bossSpawnTelegraph = {
      bossId: definition.id,
      x: target.x + Math.cos(angle) * distance,
      y: target.y + Math.sin(angle) * distance,
      color: bossDefinitionColor(definition.id),
      startedAt: this.elapsed,
      triggerAt: this.nextBossSpawnAt,
      duration: Math.max(0.001, this.nextBossSpawnAt - this.elapsed),
    };
  }

  spawnElite(alivePlayers = [...this.players.values()].filter((player) => player.hp > 0)) {
    const definition = ELITE_ROTATION[this.elitesSpawned % ELITE_ROTATION.length];
    const target = this.rng.pick(alivePlayers);
    if (!target) return null;
    const enemy = this.createRankedEnemy(definition, "elite", target, this.rng.range(620, 780));
    this.enemies.set(enemy.id, enemy);
    return enemy;
  }

  spawnBoss(alivePlayers = [...this.players.values()].filter((player) => player.hp > 0)) {
    const definition = BOSS_ROTATION[this.bossesSpawned % BOSS_ROTATION.length];
    let enemy = null;
    if (this.bossSpawnTelegraph?.bossId === definition.id) {
      enemy = this.createRankedEnemyAt(definition, "boss", this.bossSpawnTelegraph.x, this.bossSpawnTelegraph.y);
    } else {
      const target = this.rng.pick(alivePlayers);
      if (!target) return null;
      enemy = this.createRankedEnemy(definition, "boss", target, this.rng.range(760, 940));
    }
    this.enemies.set(enemy.id, enemy);
    if (!this.headless) {
      const effectId = this.entityId();
      this.effects.set(effectId, createEffect(effectId, "bossSpawnBurst", enemy.x, enemy.y, enemy.radius + 90, 0.45));
    }
    return enemy;
  }

  createRankedEnemy(definition, rank, target, distance) {
    const angle = this.rng.range(0, Math.PI * 2);
    return this.createRankedEnemyAt(definition, rank, target.x + Math.cos(angle) * distance, target.y + Math.sin(angle) * distance);
  }

  createRankedEnemyAt(definition, rank, x, y) {
    const enemy = createEnemy(
      this.entityId(),
      definition.type,
      x,
      y,
      this.wave,
      {
        ...definition,
        rank,
        eliteId: rank === "elite" ? definition.id : null,
        bossId: rank === "boss" ? definition.id : null,
        phase: 1,
      },
    );
    this.applyEnemyScaling(enemy);
    return enemy;
  }

  rollEliteAffix() {
    return this.rollEnemyAffixes()[0] ?? null;
  }

  rollEnemyAffixes() {
    const rareChance = this.wave >= 6 ? Math.min(0.012 + this.wave * 0.003, 0.06) : 0;
    const eliteChance = this.wave >= 3 ? Math.min(0.035 + this.wave * 0.007, 0.12) : 0;
    if (this.rng.next() >= eliteChance + rareChance) return [];

    const rareRoll = rareChance / Math.max(eliteChance + rareChance, 0.001);
    const count = this.rng.next() < rareRoll ? (this.wave >= 10 ? 3 : 2) : 1;
    const pool = ["hasted", "armored", "regenerating", "volatile"];
    const affixes = [];
    while (affixes.length < count && pool.length) {
      const index = Math.floor(this.rng.next() * pool.length);
      affixes.push(pool.splice(index, 1)[0]);
    }
    return affixes;
  }

  updateEnemies(dt) {
    const alivePlayers = [];
    for (const player of this.players.values()) {
      if (player.hp > 0) alivePlayers.push(player);
    }
    if (!alivePlayers.length) return;
    const singleTarget = alivePlayers.length === 1 ? alivePlayers[0] : null;
    const decay = Math.pow(0.86, dt * 60);
    for (const enemy of this.enemies.values()) {
      this.updateEnemyStatusDamage(enemy, dt);
      if (!this.enemies.has(enemy.id)) continue;
      enemy.siphonFor = Math.max(0, (enemy.siphonFor ?? 0) - dt);
      enemy.armoredFlashFor = Math.max(0, (enemy.armoredFlashFor ?? 0) - dt);
      if (enemy.bossTelegraph && this.elapsed - enemy.bossTelegraph.startedAt > enemy.bossTelegraph.duration) {
        enemy.bossTelegraph = null;
      }
      let target = singleTarget;
      if (!target) {
        let best = Infinity;
        for (let i = 0; i < alivePlayers.length; i += 1) {
          const p = alivePlayers[i];
          const dx = enemy.x - p.x;
          const dy = enemy.y - p.y;
          const d = dx * dx + dy * dy;
          if (d < best) {
            best = d;
            target = p;
          }
        }
      }
      if (!target) continue;
      if ((enemy.regenPerSecond ?? 0) > 0 && enemy.hp > 0) {
        enemy.hp = Math.min(enemy.maxHp, enemy.hp + enemy.regenPerSecond * dt);
      }
      this.updateEnemyPhase(enemy, target, dt);
      const tdx = target.x - enemy.x;
      const tdy = target.y - enemy.y;
      const tlen = Math.hypot(tdx, tdy);
      let dirX = tlen ? tdx / tlen : 0;
      let dirY = tlen ? tdy / tlen : 0;
      let speedMultiplier = 1;
      if (enemy._hastedFlag === undefined) {
        enemy._hastedFlag =
          (enemy.affixes && enemy.affixes.indexOf("hasted") >= 0) || enemy.eliteAffix === "swift";
        enemy._numericId = Number.parseInt(String(enemy.id).replace(/\D/g, ""), 10) || 0;
      }
      if (enemy.type === "charger") {
        enemy.chargeCooldown = Math.max(0, (enemy.chargeCooldown ?? 0) - dt);
        enemy.chargeFor = Math.max(0, (enemy.chargeFor ?? 0) - dt);
        if (enemy.chargeFor > 0) {
          dirX = enemy.chargeDirX ?? dirX;
          dirY = enemy.chargeDirY ?? dirY;
          speedMultiplier = 3.1;
        } else if (tlen < 360 && enemy.chargeCooldown <= 0) {
          enemy.chargeFor = 0.46;
          enemy.chargeCooldown = 1.35;
          enemy.chargeDirX = dirX;
          enemy.chargeDirY = dirY;
          speedMultiplier = 3.1;
        }
      }
      if (enemy._hastedFlag) {
        enemy.strafePhase = (enemy.strafePhase ?? 0) + dt * 5.2;
        const weave = Math.sin(enemy.strafePhase + enemy._numericId * 0.37) * 0.42;
        const wx = dirX - dirY * weave;
        const wy = dirY + dirX * weave;
        const wlen = Math.hypot(wx, wy);
        if (wlen) {
          dirX = wx / wlen;
          dirY = wy / wlen;
        } else {
          dirX = 0;
          dirY = 0;
        }
      }
      if (enemy.type === "siphon" && tlen < 150 && enemy.hp > 0 && target.hp > 0) {
        const drain = (enemy.rank === "boss" ? 11 : 7) * dt;
        const shield = target.shield ?? 0;
        const absorbed = Math.min(shield, drain);
        target.shield = shield - absorbed;
        const hpDrain = drain - absorbed;
        if (hpDrain > 0) target.hp = Math.max(0, target.hp - hpDrain);
        enemy.hp = Math.min(enemy.maxHp, enemy.hp + drain * 1.35);
        enemy.siphonFor = 0.12;
        enemy.siphonTargetX = target.x;
        enemy.siphonTargetY = target.y;
        speedMultiplier = 0.55;
      }
      if (enemy.type === "warden" && tlen < (enemy.rank === "elite" ? 310 : 260)) speedMultiplier = 0.74;
      const moveScale = enemy.speed * speedMultiplier * dt;
      enemy.x += dirX * moveScale + enemy.hitVx * dt;
      enemy.y += dirY * moveScale + enemy.hitVy * dt;
      enemy.hitVx *= decay;
      enemy.hitVy *= decay;
      enemy.hitFlash = enemy.hitFlash > dt ? enemy.hitFlash - dt : 0;

      const hitDistance = enemy.radius + target.radius;
      const ddx = enemy.x - target.x;
      const ddy = enemy.y - target.y;
      if (ddx * ddx + ddy * ddy <= hitDistance * hitDistance) {
        if (target.invulnerableFor <= 0) {
          const incomingDamage = Math.max(1, enemy.damage - this.playerArmor(target));
          const result = this.damagePlayer(target, incomingDamage, PLAYER_BASE.invulnerability + target.stats.invulnerabilityBonus);
          if (result.absorbed > 0 && target.stats.ramDamage > 0) {
            this.damageEnemy(enemy, target.stats.ramDamage, {
              ownerId: target.id,
              x: target.x,
              y: target.y,
              vx: enemy.x - target.x,
              vy: enemy.y - target.y,
            });
          }
          if (result.hullDamage > 0 && target.stats.hullDamageReflection > 0) {
            this.damageEnemy(enemy, result.hullDamage * target.stats.hullDamageReflection, {
              ownerId: target.id,
              x: target.x,
              y: target.y,
              vx: enemy.x - target.x,
              vy: enemy.y - target.y,
            });
          }
        }
        const knockback = 20 + (target.stats.contactKnockback ?? 0);
        enemy.x -= dirX * knockback;
        enemy.y -= dirY * knockback;
        enemy.hitVx -= dirX * (target.stats.contactKnockback ?? 0) * 3.4;
        enemy.hitVy -= dirY * (target.stats.contactKnockback ?? 0) * 3.4;
      }
    }
  }

  updateEnemyPhase(enemy, target, dt) {
    if (enemy.rank !== "boss") return;
    enemy.phaseTimer = (enemy.phaseTimer ?? 0) + dt;
    const healthRatio = enemy.maxHp > 0 ? enemy.hp / enemy.maxHp : 0;
    const nextPhase = healthRatio <= 0.34 ? 3 : healthRatio <= 0.67 ? 2 : 1;
    if (nextPhase !== enemy.phase) {
      enemy.phase = nextPhase;
      enemy.phaseTimer = 0;
      enemy.phaseCooldown = 0;
      enemy.hitFlash = Math.max(enemy.hitFlash ?? 0, 0.24);
    }
    enemy.phaseCooldown = Math.max(0, (enemy.phaseCooldown ?? 0) - dt);
    if (enemy.phase < 2 || enemy.phaseCooldown > 0 || !target) return;
    if (enemy.bossId === "brood-splitter") {
      enemy.bossTelegraph = { type: "split", startedAt: this.elapsed, duration: 0.8 };
      this.spawnBossMinion(enemy, "shard", target);
      enemy.phaseCooldown = enemy.phase === 3 ? 2.8 : 4.2;
    } else if (enemy.bossId === "nova-spitter") {
      enemy.bossTelegraph = { type: "burst", startedAt: this.elapsed, duration: 1 };
      this.spawnBossMinion(enemy, "spitter", target);
      enemy.phaseCooldown = enemy.phase === 3 ? 4.5 : 6.5;
    } else if (enemy.bossId === "bastion-bulwark") {
      enemy.armor = Math.max(enemy.armor ?? 0, enemy.phase === 3 ? 14 : 10);
      enemy.armoredFlashFor = 0.25;
      enemy.bossTelegraph = { type: "slam", startedAt: this.elapsed, duration: 1 };
      enemy.phaseCooldown = 5;
    }
  }

  spawnBossMinion(enemy, type, target) {
    if (this.enemies.size >= GAME.maxEnemies) return;
    const direction = normalize(target.x - enemy.x, target.y - enemy.y);
    const minion = createEnemy(
      this.entityId(),
      type,
      enemy.x + direction.x * (enemy.radius + 32),
      enemy.y + direction.y * (enemy.radius + 32),
      this.wave,
      { splitDepth: (enemy.splitDepth ?? 0) + 1 },
    );
    minion.hitVx = direction.x * 70;
    minion.hitVy = direction.y * 70;
    this.applyEnemyScaling(minion);
    this.enemies.set(minion.id, minion);
  }

  enemyMoveDirection(enemy, target, dt) {
    const direction = normalize(target.x - enemy.x, target.y - enemy.y);
    if (!enemy.affixes?.includes("hasted") && enemy.eliteAffix !== "swift") return direction;

    enemy.strafePhase = (enemy.strafePhase ?? 0) + dt * 5.2;
    const numericId = Number.parseInt(enemy.id.replace(/\D/g, ""), 10) || 0;
    const weave = Math.sin(enemy.strafePhase + numericId * 0.37) * 0.42;
    return normalize(direction.x - direction.y * weave, direction.y + direction.x * weave);
  }

  updateProjectiles(dt) {
    for (const projectile of this.projectiles.values()) {
      this.accelerateProjectile(projectile, dt);
      projectile.x += projectile.vx * dt;
      projectile.y += projectile.vy * dt;
      projectile.ttl -= dt;
      if (projectile.ttl <= 0) {
        this.projectiles.delete(projectile.id);
        continue;
      }

      for (const enemy of this.enemies.values()) {
        if (projectile.hitEnemyIds?.includes(enemy.id)) continue;
        const hitDistance = projectile.radius + enemy.radius;
        if (distanceSq(projectile.x, projectile.y, enemy.x, enemy.y) <= hitDistance * hitDistance) {
          projectile.hitEnemyIds?.push(enemy.id);
          this.damageEnemy(enemy, projectile.damage, projectile);
          this.applyProjectileStatuses(projectile, enemy);
          this.splashProjectileDamage(projectile, enemy);
          this.chainProjectileDamage(projectile, enemy);
          this.droneRelayDamage(projectile, enemy);
          if (this.ricochetProjectile(projectile, enemy)) break;
          if (projectile.pierce > 0) {
            projectile.pierce -= 1;
          } else {
            this.projectiles.delete(projectile.id);
          }
          break;
        }
      }
    }
  }

  updateDrones(dt) {
    for (const player of this.players.values()) {
      for (let i = 0; i < player.stats.drones; i += 1) {
        const angle = this.elapsed * (2.2 + i * 0.22) + (Math.PI * 2 * i) / player.stats.drones;
        const droneX = player.x + Math.cos(angle) * 78;
        const droneY = player.y + Math.sin(angle) * 78;
        for (const enemy of this.enemies.values()) {
          if (distanceSq(droneX, droneY, enemy.x, enemy.y) < (enemy.radius + 20) ** 2) {
            this.damageEnemy(enemy, (24 + player.stats.damage * 0.4) * dt, {
              x: droneX,
              y: droneY,
              vx: enemy.x - droneX,
              vy: enemy.y - droneY,
            });
          }
        }
      }
    }
  }

  updatePickups(dt) {
    const pickupList = this.pickups;
    if (!pickupList.size) return;
    const toCollect = [];
    for (const pickup of pickupList.values()) {
      for (const player of this.players.values()) {
        const magnetRadius = this.pickupMagnetRadius(player);
        const dx0 = player.x - pickup.x;
        const dy0 = player.y - pickup.y;
        const distSq = dx0 * dx0 + dy0 * dy0;
        const magnetSq = magnetRadius * magnetRadius;
        if (distSq < magnetSq) {
          const len = Math.sqrt(distSq);
          if (len) {
            const pull = 280 + (1 - len / magnetRadius) * 520;
            const scale = (pull * dt) / len;
            pickup.x += dx0 * scale;
            pickup.y += dy0 * scale;
          }
        }

        const collectDistance = player.radius + player.stats.pickupRadius * 0.55 + pickup.radius;
        const ndx = player.x - pickup.x;
        const ndy = player.y - pickup.y;
        if (ndx * ndx + ndy * ndy <= collectDistance * collectDistance) {
          toCollect.push({ pickup, player });
          break;
        }
      }
    }
    for (let i = 0; i < toCollect.length; i += 1) {
      const { pickup, player } = toCollect[i];
      if (!pickupList.has(pickup.id)) continue;
      pickupList.delete(pickup.id);
      this.markRewardCacheCollected(pickup);
      this.collectPickup(player, pickup);
    }
  }

  markRewardCacheCollected(pickup) {
    if (!pickup.runEventId) return;
    const event = this.runEvents.active.find((item) => item.id === pickup.runEventId);
    if (!event || event.type !== RUN_EVENTS.rewardCache.id || event.collectedAt !== null) return;
    event.collectedAt = this.elapsed;
    event.endAt = Math.min(event.endAt, this.elapsed + 0.4);
  }

  updateEffects(dt) {
    if (this.headless || this.effects.size === 0) return;
    for (const effect of this.effects.values()) {
      effect.ttl -= dt;
      if (effect.ttl <= 0) this.effects.delete(effect.id);
    }
  }

  damageEnemy(enemy, damage, source = null) {
    const sourceDirection = source ? normalize(source.vx ?? enemy.x - source.x, source.vy ?? enemy.y - source.y) : { x: 0, y: 0 };
    const hitX = source?.x ?? enemy.x;
    const hitY = source?.y ?? enemy.y;
    const markedMultiplier = (enemy.markedFor ?? 0) > 0 ? 1 + (enemy.markedDamageTakenMultiplier ?? 0) : 1;
    const minimumDamage = source?.allowSubUnitDamage ? 0 : 1;
    const mitigation = source?.ignoreArmor ? 0 : (enemy.armor ?? 0) + this.enemyArmorAuraBonus(enemy);
    const appliedDamage = Math.max(minimumDamage, damage * markedMultiplier - mitigation);
    enemy.hp -= appliedDamage;
    if (source?.isCritical && source.executeThreshold > 0 && enemy.hp > 0 && enemy.hp <= enemy.maxHp * source.executeThreshold) {
      enemy.hp = 0;
    }
    enemy.hitFlash = Math.max(enemy.hitFlash ?? 0, 0.12);
    enemy.hitVx = (enemy.hitVx ?? 0) + sourceDirection.x * 90;
    enemy.hitVy = (enemy.hitVy ?? 0) + sourceDirection.y * 90;
    this.spawnHitEffect(hitX, hitY, sourceDirection, appliedDamage, enemy.hp <= 0);
    if (enemy.hp > 0 || !this.enemies.has(enemy.id)) return;
    this.enemies.delete(enemy.id);
    let owner = null;
    let firstPlayer = null;
    const ownerId = source?.ownerId;
    for (const player of this.players.values()) {
      if (!firstPlayer) firstPlayer = player;
      if (ownerId === player.id) {
        owner = player;
        break;
      }
    }
    if (!owner) owner = firstPlayer;
    if (owner) {
      owner.kills += 1;
      if (owner.stats.killCooldownRefund > 0) {
        owner.cooldown = Math.max(0, owner.cooldown - owner.stats.killCooldownRefund);
      }
      this.triggerKillVolley(enemy, owner);
    }
    this.triggerEnemyDeathAffixes(enemy, owner);
    this.spawnSplitChildren(enemy);
    const pickup = this.createEnemyDrop(enemy, owner);
    this.pickups.set(pickup.id, pickup);
  }

  enemyArmorAuraBonus(enemy) {
    if (!this.enemies.has(enemy.id)) return 0;
    let bonus = 0;
    for (const other of this.enemies.values()) {
      if (other.id === enemy.id || other.type !== "warden" || other.hp <= 0) continue;
      if (distanceSq(enemy.x, enemy.y, other.x, other.y) <= 190 * 190) bonus = Math.max(bonus, 5);
    }
    return bonus;
  }

  playerArmor(player) {
    const shieldArmor = Math.floor((player.shield ?? 0) / 25) * (player.stats.shieldArmorConversion ?? 0);
    return (player.stats.armor ?? 0) + shieldArmor;
  }

  playerShieldCap(player) {
    return player.stats.maxShield ?? 60;
  }

  damagePlayer(player, incomingDamage, invulnerabilityFor = PLAYER_BASE.invulnerability) {
    const shield = player.shield ?? 0;
    const absorbed = Math.min(shield, incomingDamage);
    const hullDamage = incomingDamage - absorbed;
    player.shield = Math.max(0, shield - absorbed);
    player.hp = Math.max(0, player.hp - hullDamage);
    player.invulnerableFor = Math.max(player.invulnerableFor ?? 0, invulnerabilityFor);
    if (incomingDamage > 0) {
      player.shieldRechargeCooldown = Math.max(
        player.shieldRechargeCooldown ?? 0,
        player.stats.shieldRechargeDelay ?? 3,
      );
    }
    return { absorbed, hullDamage };
  }

  triggerEnemyDeathAffixes(enemy, owner = null) {
    if (!enemy.affixes?.includes("volatile") || !enemy.volatileRadius || !enemy.volatileDamage) return;
    const effectId = this.entityId();
    if (!this.headless) this.effects.set(effectId, createEffect(effectId, "volatileBurst", enemy.x, enemy.y, enemy.volatileRadius, 0.36));
    for (const player of this.players.values()) {
      if (player.hp <= 0 || distanceSq(enemy.x, enemy.y, player.x, player.y) > enemy.volatileRadius ** 2) continue;
      const incomingDamage = Math.max(1, enemy.volatileDamage - this.playerArmor(player));
      this.damagePlayer(player, incomingDamage, PLAYER_BASE.invulnerability * 0.5 + player.stats.invulnerabilityBonus);
    }
    if (owner) owner.scrap += 1;
  }

  createEnemyDrop(enemy, owner = null) {
    if (enemy.rank === "boss" || enemy.bossId) {
      return createPickup(this.entityId(), enemy.x, enemy.y, Math.max(36, enemy.xp), "cache");
    }
    if (enemy.rank === "elite" || enemy.eliteId) {
      return createPickup(this.entityId(), enemy.x, enemy.y, Math.max(10, Math.round(enemy.xp * 1.35)), "scrap");
    }
    const repairChance = 0.12 + (owner?.stats.repairDropBonus ?? 0);
    const roll = this.rng.next();
    if (enemy.type === "bruiser" && roll < repairChance) {
      return createPickup(this.entityId(), enemy.x, enemy.y, 28, "repair");
    }
    if (roll < 0.012) return createPickup(this.entityId(), enemy.x, enemy.y, 24, "cache");
    if (roll < 0.04) return createPickup(this.entityId(), enemy.x, enemy.y, 5, "overdrive");
    if (roll < 0.07) return createPickup(this.entityId(), enemy.x, enemy.y, 5, "magnet");
    if (roll < 0.11) return createPickup(this.entityId(), enemy.x, enemy.y, 24, "shield");
    if (roll < 0.24) return createPickup(this.entityId(), enemy.x, enemy.y, enemy.type === "bruiser" ? 8 : 3, "scrap");
    return createPickup(this.entityId(), enemy.x, enemy.y, enemy.xp, "xp");
  }

  collectPickup(player, pickup) {
    if (player.stats.pickupSpeedBurstDuration > 0) {
      player.pickupSpeedBurstFor = Math.max(player.pickupSpeedBurstFor ?? 0, player.stats.pickupSpeedBurstDuration);
    }
    if (pickup.type === "repair") {
      const missingHp = Math.max(0, player.stats.maxHp - player.hp);
      const restored = Math.min(missingHp, pickup.value);
      const overflow = Math.max(0, pickup.value - restored);
      player.hp += restored;
      if (overflow > 0 && player.stats.repairOverflowScrap > 0) {
        player.scrap = (player.scrap ?? 0) + Math.floor(overflow * player.stats.repairOverflowScrap);
      }
    } else if (pickup.type === "shield") {
      const shieldCap = this.playerShieldCap(player);
      const currentShield = player.shield ?? 0;
      const value = pickup.value * (player.stats.shieldPickupMultiplier ?? 1);
      const gained = Math.min(Math.max(0, shieldCap - currentShield), value);
      const overflow = Math.max(0, value - gained);
      player.shield = currentShield + gained;
      if (overflow > 0 && player.stats.shieldOverflowScrap > 0) {
        player.scrap = (player.scrap ?? 0) + Math.floor(overflow * player.stats.shieldOverflowScrap);
      }
    } else if (pickup.type === "scrap") {
      player.scrap = (player.scrap ?? 0) + Math.round(pickup.value * player.stats.scrapValueMultiplier);
      if (player.stats.scrapGrantsXp > 0) this.gainXp(player, player.stats.scrapGrantsXp);
    } else if (pickup.type === "overdrive") {
      player.overdriveFor = Math.max(player.overdriveFor ?? 0, pickup.value);
      this.spawnCollectionEffect(player, "overdrive");
    } else if (pickup.type === "magnet") {
      player.magnetBurstFor = Math.max(player.magnetBurstFor ?? 0, pickup.value + player.stats.magnetPickupDurationBonus);
      this.spawnCollectionEffect(player, "magnetBurst");
    } else if (pickup.type === "cache") {
      const value = Math.round(pickup.value * (1 + player.stats.cacheValueBonus));
      player.scrap = (player.scrap ?? 0) + value;
      this.gainXp(player, Math.max(1, Math.round(value / 3)));
      this.spawnCollectionEffect(player, "cacheOpened");
    } else {
      if (player.stats.xpPickupScrapEvery > 0) {
        player.xpPickupsCollected = (player.xpPickupsCollected ?? 0) + 1;
        if (player.xpPickupsCollected % player.stats.xpPickupScrapEvery === 0) {
          player.scrap = (player.scrap ?? 0) + player.stats.xpPickupScrapValue;
        }
      }
      this.gainXp(player, pickup.value);
    }
  }

  playerSpeed(player) {
    const overdriveMultiplier = (player.overdriveFor ?? 0) > 0 ? 1.28 : 1;
    const pickupBurstMultiplier = (player.pickupSpeedBurstFor ?? 0) > 0 ? player.stats.pickupSpeedBurstMultiplier : 1;
    return player.stats.speed * overdriveMultiplier * pickupBurstMultiplier;
  }

  playerFireRate(player) {
    return player.stats.fireRate * ((player.overdriveFor ?? 0) > 0 ? 1.7 : 1);
  }

  pickupMagnetRadius(player) {
    return (
      player.stats.pickupRadius +
      GAME.xpMagnetRadius +
      ((player.magnetBurstFor ?? 0) > 0 ? 420 + player.stats.magnetBurstRadiusBonus : 0)
    );
  }

  spawnCollectionEffect(player, type) {
    const effectId = this.entityId();
    if (this.headless) return;
    this.effects.set(effectId, createEffect(effectId, type, player.x, player.y, type === "cacheOpened" ? 120 : 180, 0.42));
  }

  accelerateProjectile(projectile, dt) {
    if (!projectile.acceleration || projectile.maxSpeedMultiplier <= 1 || dt <= 0) return;
    const speed = Math.hypot(projectile.vx, projectile.vy);
    if (!speed) return;
    const maxSpeed = (projectile.initialSpeed || speed) * projectile.maxSpeedMultiplier;
    if (speed >= maxSpeed) return;
    const nextSpeed = Math.min(maxSpeed, speed * (1 + projectile.acceleration * dt));
    const scale = nextSpeed / speed;
    projectile.vx *= scale;
    projectile.vy *= scale;
  }

  applyProjectileStatuses(projectile, enemy) {
    if (projectile.burnDps > 0 && projectile.burnDuration > 0 && this.enemies.has(enemy.id)) {
      enemy.burnDps = Math.max(enemy.burnDps ?? 0, projectile.burnDps);
      enemy.burnFor = Math.max(enemy.burnFor ?? 0, projectile.burnDuration);
      enemy.burnOwnerId = projectile.ownerId;
    }
    if (projectile.markDamageTakenMultiplier > 0 && projectile.markDuration > 0 && this.enemies.has(enemy.id)) {
      enemy.markedDamageTakenMultiplier = Math.max(enemy.markedDamageTakenMultiplier ?? 0, projectile.markDamageTakenMultiplier);
      enemy.markedFor = Math.max(enemy.markedFor ?? 0, projectile.markDuration);
    }
  }

  updateEnemyStatusDamage(enemy, dt) {
    if (enemy.markedFor > 0) enemy.markedFor = Math.max(0, enemy.markedFor - dt);
    if (!(enemy.burnFor > 0) || !(enemy.burnDps > 0)) return;
    enemy.burnFor = Math.max(0, enemy.burnFor - dt);
    this.damageEnemy(enemy, enemy.burnDps * dt, {
      ownerId: enemy.burnOwnerId,
      x: enemy.x,
      y: enemy.y,
      vx: 0,
      vy: 0,
      allowSubUnitDamage: true,
      ignoreArmor: true,
    });
  }

  chainProjectileDamage(projectile, firstEnemy) {
    if ((!projectile.chainArcs && !projectile.chainForks) || !projectile.chainRange || projectile.chainDamageMultiplier <= 0) return;
    const chainedEnemyIds = new Set([firstEnemy.id]);
    let sourceEnemy = firstEnemy;
    for (let arc = 0; arc < projectile.chainArcs; arc += 1) {
      const target = this.nearestChainTarget(sourceEnemy, chainedEnemyIds, projectile.chainRange);
      if (!target) return;
      chainedEnemyIds.add(target.id);
      this.damageEnemy(target, projectile.damage * projectile.chainDamageMultiplier, {
        ownerId: projectile.ownerId,
        x: sourceEnemy.x,
        y: sourceEnemy.y,
        vx: target.x - sourceEnemy.x,
        vy: target.y - sourceEnemy.y,
      });
      sourceEnemy = target;
    }
    this.forkProjectileChain(projectile, firstEnemy, chainedEnemyIds);
  }

  forkProjectileChain(projectile, firstEnemy, excludedIds = new Set([firstEnemy.id])) {
    if (!projectile.chainForks || !projectile.chainRange || projectile.chainDamageMultiplier <= 0) return;
    const targets = this.nearestChainTargets(firstEnemy, excludedIds, projectile.chainRange, projectile.chainForks);
    for (const target of targets) {
      excludedIds.add(target.id);
      this.damageEnemy(target, projectile.damage * projectile.chainDamageMultiplier, {
        ownerId: projectile.ownerId,
        x: firstEnemy.x,
        y: firstEnemy.y,
        vx: target.x - firstEnemy.x,
        vy: target.y - firstEnemy.y,
      });
    }
  }

  splashProjectileDamage(projectile, firstEnemy) {
    if (!projectile.splashRadius || projectile.splashDamageMultiplier <= 0) return;
    const radiusSq = projectile.splashRadius * projectile.splashRadius;
    let caught = 0;
    for (const enemy of this.enemies.values()) {
      if (enemy.id === firstEnemy.id) continue;
      if (distanceSq(firstEnemy.x, firstEnemy.y, enemy.x, enemy.y) > radiusSq) continue;
      caught += 1;
      this.damageEnemy(enemy, projectile.damage * projectile.splashDamageMultiplier, {
        ownerId: projectile.ownerId,
        x: firstEnemy.x,
        y: firstEnemy.y,
        vx: enemy.x - firstEnemy.x,
        vy: enemy.y - firstEnemy.y,
      });
    }
    if (caught > 0 && projectile.splashCenterBonusPerTarget > 0 && this.enemies.has(firstEnemy.id)) {
      this.damageEnemy(firstEnemy, projectile.damage * projectile.splashCenterBonusPerTarget * caught, {
        ownerId: projectile.ownerId,
        x: firstEnemy.x,
        y: firstEnemy.y,
        vx: 0,
        vy: 0,
      });
    }
  }

  droneRelayDamage(projectile, firstEnemy) {
    if (!projectile.droneArcDamagePerDrone || !projectile.droneArcRange) return;
    const owner = this.players.get(projectile.ownerId);
    const droneCount = owner?.stats.drones ?? 0;
    if (droneCount <= 0) return;
    const targets = this.nearestChainTargets(firstEnemy, new Set(projectile.hitEnemyIds ?? [firstEnemy.id]), projectile.droneArcRange, droneCount);
    if (!targets.length) return;
    const damage = projectile.damage * projectile.droneArcDamagePerDrone;
    for (let i = 0; i < droneCount; i += 1) {
      const target = targets[i % targets.length];
      this.damageEnemy(target, damage, {
        ownerId: projectile.ownerId,
        x: firstEnemy.x,
        y: firstEnemy.y,
        vx: target.x - firstEnemy.x,
        vy: target.y - firstEnemy.y,
      });
    }
  }

  ricochetProjectile(projectile, firstEnemy) {
    if (!projectile.ricochetBounces || !projectile.ricochetRange || projectile.ricochetDamageMultiplier <= 0) return false;
    const target = this.nearestChainTarget(firstEnemy, new Set(projectile.hitEnemyIds ?? []), projectile.ricochetRange);
    if (!target) return false;
    const direction = normalize(target.x - firstEnemy.x, target.y - firstEnemy.y);
    projectile.x = firstEnemy.x + direction.x * (firstEnemy.radius + projectile.radius + 2);
    projectile.y = firstEnemy.y + direction.y * (firstEnemy.radius + projectile.radius + 2);
    const speed = Math.hypot(projectile.vx, projectile.vy) || 1;
    projectile.vx = direction.x * speed;
    projectile.vy = direction.y * speed;
    projectile.damage *= projectile.ricochetDamageMultiplier;
    projectile.ricochetBounces -= 1;
    projectile.ttl = Math.max(projectile.ttl, 0.18);
    return true;
  }

  nearestChainTarget(sourceEnemy, excludedIds, range) {
    return this.nearestChainTargets(sourceEnemy, excludedIds, range, 1)[0] ?? null;
  }

  nearestChainTargets(sourceEnemy, excludedIds, range, count) {
    const targets = [];
    const blocked = new Set(excludedIds);
    while (targets.length < count) {
      const target = this.nearestChainTargetOnce(sourceEnemy, blocked, range);
      if (!target) break;
      targets.push(target);
      blocked.add(target.id);
    }
    return targets;
  }

  nearestChainTargetOnce(sourceEnemy, excludedIds, range) {
    let nearest = null;
    let best = range * range;
    for (const enemy of this.enemies.values()) {
      if (excludedIds.has(enemy.id)) continue;
      const dist = distanceSq(sourceEnemy.x, sourceEnemy.y, enemy.x, enemy.y);
      if (dist <= best) {
        best = dist;
        nearest = enemy;
      }
    }
    return nearest;
  }

  triggerKillVolley(enemy, owner) {
    if (!owner.stats.killVolleyProjectiles || owner.stats.killVolleyDamageMultiplier <= 0) return;
    const targets = this.nearestChainTargets(enemy, new Set(), owner.stats.killVolleyRange, owner.stats.killVolleyProjectiles);
    const damage = owner.stats.damage * owner.stats.killVolleyDamageMultiplier;
    for (const target of targets) {
      const direction = normalize(target.x - enemy.x, target.y - enemy.y);
      const projectile = createProjectile(
        this.entityId(),
        owner.id,
        enemy.x + direction.x * (enemy.radius + 8),
        enemy.y + direction.y * (enemy.radius + 8),
        direction.x * owner.stats.projectileSpeed * 0.82,
        direction.y * owner.stats.projectileSpeed * 0.82,
        damage,
        Math.max(3, owner.stats.projectileRadius - 1),
        0.46,
        {
          pierce: 0,
          color: "#ff5b79",
          glowColor: "rgba(255, 91, 121, 0.45)",
        },
      );
      this.projectiles.set(projectile.id, projectile);
    }
  }

  spawnSplitChildren(enemy) {
    if (!enemy.splitCount || !enemy.splitChildType) return;
    const angleOffset = this.rng.range(0, Math.PI * 2);
    for (let i = 0; i < enemy.splitCount; i += 1) {
      const angle = angleOffset + (Math.PI * 2 * i) / enemy.splitCount;
      const child = createEnemy(
        this.entityId(),
        enemy.splitChildType,
        enemy.x + Math.cos(angle) * 28,
        enemy.y + Math.sin(angle) * 28,
        this.wave,
        { splitDepth: (enemy.splitDepth ?? 0) + 1 },
      );
      child.hitVx = Math.cos(angle) * 80;
      child.hitVy = Math.sin(angle) * 80;
      this.applyEnemyScaling(child);
      this.enemies.set(child.id, child);
    }
  }

  spawnHitEffect(x, y, direction, damage, destroyed) {
    const effectId = this.entityId();
    if (this.headless) return;
    this.effects.set(
      effectId,
      createEffect(effectId, destroyed ? "enemyDestroyed" : "projectileImpact", x, y, destroyed ? 92 : 42, destroyed ? 0.58 : 0.22),
    );
    const effect = this.effects.get(effectId);
    effect.directionX = direction.x;
    effect.directionY = direction.y;
    effect.damage = damage;
  }

  gainXp(player, amount) {
    player.xp += amount * player.stats.xpGain;
    while (player.xp >= player.nextLevelXp) {
      player.xp -= player.nextLevelXp;
      player.level += 1;
      player.nextLevelXp = Math.floor(player.nextLevelXp * 1.34 + 6);
      if (player.id === this.localPlayerId) {
        this.pendingUpgradeChoices = pickUpgradeChoices(this.rng, player);
        this.state = "upgrade";
        break;
      }
    }
  }

  spawnGravityBurst(player) {
    const effectId = this.entityId();
    if (!this.headless) this.effects.set(effectId, createEffect(effectId, "gravityWell", player.x, player.y, 240, 0.46));
    for (const enemy of this.enemies.values()) {
      const dist = Math.sqrt(distanceSq(player.x, player.y, enemy.x, enemy.y));
      const radius = 240 * player.stats.area;
      if (dist < radius) {
        const direction = normalize(player.x - enemy.x, player.y - enemy.y);
        enemy.x += direction.x * 52 * player.stats.gravityWell * player.stats.area;
        enemy.y += direction.y * 52 * player.stats.gravityWell * player.stats.area;
        this.damageEnemy(enemy, 22 * player.stats.gravityWell, {
          x: player.x,
          y: player.y,
          vx: enemy.x - player.x,
          vy: enemy.y - player.y,
        });
      }
    }
  }

  cleanupFarEntities() {
    const limitSq = 1800 * 1800;
    const players = this.players;
    let toRemove = null;
    for (const enemy of this.enemies.values()) {
      let close = false;
      for (const player of players.values()) {
        const dx = player.x - enemy.x;
        const dy = player.y - enemy.y;
        if (dx * dx + dy * dy < limitSq) {
          close = true;
          break;
        }
      }
      if (!close) {
        if (!toRemove) toRemove = [];
        toRemove.push(enemy.id);
      }
    }
    if (toRemove) {
      for (let i = 0; i < toRemove.length; i += 1) this.enemies.delete(toRemove[i]);
    }
  }

  nearestPlayer(entity, players) {
    let nearest = null;
    let best = Infinity;
    for (const player of players) {
      const dist = distanceSq(entity.x, entity.y, player.x, player.y);
      if (dist < best) {
        best = dist;
        nearest = player;
      }
    }
    return nearest;
  }

  checkGameOver() {
    let anyAlive = false;
    for (const player of this.players.values()) {
      if (player.hp > 0) {
        anyAlive = true;
        break;
      }
    }
    if (!anyAlive) {
      this.state = "gameover";
      this.outcome = "defeat";
    }
  }

  checkRunOutcome() {
    if (this.state !== "playing" && this.state !== "upgrade") return;
    if (this.runMode === "normal" && this.elapsed >= GAME.normalRunSeconds) {
      this.state = "victory";
      this.outcome = "victory";
    }
  }

  applyEnemyScaling(enemy) {
    const difficulty = this.currentDifficulty();
    const healthMultiplier = this.enemyHealthMultiplier * difficulty.healthMultiplier;
    const speedMultiplier = this.enemySpeedMultiplier * difficulty.speedMultiplier;
    if (healthMultiplier !== 1) {
      enemy.maxHp *= healthMultiplier;
      enemy.hp *= healthMultiplier;
    }
    if (speedMultiplier !== 1) {
      enemy.speed *= speedMultiplier;
    }
  }

  currentDifficulty() {
    this.difficulty = difficultyAt(this.elapsed);
    return this.difficulty;
  }

  effectiveSpawnMultiplier() {
    return this.enemySpawnMultiplier * this.currentDifficulty().spawnMultiplier;
  }

  entityId() {
    this.nextEntityId += 1;
    return `e${this.nextEntityId}`;
  }

  _selectPrimaryTargetFast(player) {
    const cache = this._targetingCache;
    if (!cache.fastPath) {
      return selectTarget(player, [...this.enemies.values()], this.targeting.primaryWeapon, this.rng);
    }
    const allowedTypes = cache.allowedTypes;
    const hasTypeFilter = allowedTypes !== null;
    const maxRangeSq = cache.maxRangeSq;
    const px = player.x;
    const py = player.y;
    let best = null;
    let bestDist = Infinity;
    for (const enemy of this.enemies.values()) {
      if (enemy.hp <= 0) continue;
      if (hasTypeFilter && !allowedTypes.has(enemy.type)) continue;
      const dx = enemy.x - px;
      const dy = enemy.y - py;
      const dist = dx * dx + dy * dy;
      if (dist > maxRangeSq) continue;
      if (dist < bestDist) {
        bestDist = dist;
        best = enemy;
      }
    }
    return best;
  }
}

export function difficultyAt(elapsed) {
  const safeElapsed = Math.max(0, Number.isFinite(elapsed) ? elapsed : 0);
  const minutes = safeElapsed / 60;
  const overrunSeconds = Math.max(0, safeElapsed - GAME.overrunStartsAt);
  const overrunMinutes = overrunSeconds / 60;
  const healthMultiplier = clamp(
    1 + minutes * DIFFICULTY.healthPerMinute + overrunMinutes * DIFFICULTY.overrunHealthPerMinute,
    1,
    DIFFICULTY.maxHealthMultiplier,
  );
  const speedMultiplier = clamp(
    1 + minutes * DIFFICULTY.speedPerMinute + overrunMinutes * DIFFICULTY.overrunSpeedPerMinute,
    1,
    DIFFICULTY.maxSpeedMultiplier,
  );
  const spawnMultiplier = clamp(
    1 + minutes * DIFFICULTY.spawnPerMinute + overrunMinutes * DIFFICULTY.overrunSpawnPerMinute,
    1,
    DIFFICULTY.maxSpawnMultiplier,
  );
  return {
    elapsed: safeElapsed,
    overrun: safeElapsed >= GAME.overrunStartsAt,
    overrunSeconds,
    healthMultiplier,
    speedMultiplier,
    spawnMultiplier,
  };
}

function buildTargetingCache(weapon) {
  const fastPath = weapon.strategy === "nearest";
  const allowedTypes =
    Array.isArray(weapon.enemyTypes) && weapon.enemyTypes.length ? new Set(weapon.enemyTypes) : null;
  const maxRangeSq = weapon.maxRange > 0 ? weapon.maxRange * weapon.maxRange : Infinity;
  const angleThreshold = Math.cos((weapon.firingAngleDegrees * Math.PI) / 180);
  return { fastPath, allowedTypes, maxRangeSq, angleThreshold };
}

function bossDefinitionColor(bossId) {
  if (bossId === "brood-splitter") return "#ff9a3d";
  if (bossId === "siphon-prime") return "#25d6ff";
  if (bossId === "bastion-bulwark") return "#7c88ff";
  if (bossId === "nova-spitter") return "#d7ff57";
  return "#ff5b79";
}
