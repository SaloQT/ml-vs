import { DIFFICULTY, GAME, NETWORK, PLAYER_BASE, RUN_EVENTS } from "./config.js";
import { createEffect, createEnemy, createPickup, createPlayer, createProjectile } from "./entities.js";
import { clamp, distanceSq, normalize, Rng } from "./math.js";
import { applyMetaProgress, normalizeMetaProgress } from "./metaProgression.js";
import { createTargetingConfig, mergeTargetingConfig, selectTarget } from "./targeting.js";
import { pickUpgradeChoices, UPGRADE_POOL } from "./upgrades.js";
import {
  applyAilmentsFromHit,
  updateAilments,
  getAilmentDamageTakenMultiplier,
  getAilmentOutgoingDamageMultiplier,
  getAilmentCritChanceBonus,
} from "./ailments.js";

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

// Sort comparator used by spatial-grid call sites that need to iterate
// candidates in the same order as Map.values() (i.e. ascending insertion
// id). _numericId is populated in _rebuildEnemyGrid / _addEnemyToGrid.
function byNumericIdAsc(a, b) {
  return a._numericId - b._numericId;
}

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
    let current = this.inputs.get(playerId);
    if (!current) {
      current = { moveX: 0, moveY: 0, aimX: 1, aimY: 0 };
      this.inputs.set(playerId, current);
    }
    current.moveX = clamp(input.moveX ?? current.moveX ?? 0, -1, 1);
    current.moveY = clamp(input.moveY ?? current.moveY ?? 0, -1, 1);
    current.aimX = clamp(input.aimX ?? current.aimX ?? 1, -1, 1);
    current.aimY = clamp(input.aimY ?? current.aimY ?? 0, -1, 1);
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
    // Spatial grid is rebuilt once per frame after spawning. updateEnemies,
    // updateProjectiles and updateDrones all use it for radius queries
    // instead of scanning this.enemies.values() — a meaningful CPU win at
    // 290+ enemies. Enemies spawned mid-step (split children, boss minions)
    // are inserted into the live grid by _addEnemyToGrid so subsequent
    // queries still find them.
    this._rebuildEnemyGrid();
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
      players: Array.from(this.players.values()),
      enemies: Array.from(this.enemies.values()),
      projectiles: Array.from(this.projectiles.values()),
      pickups: Array.from(this.pickups.values()),
      effects: Array.from(this.effects.values()),
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

    const active = this.runEvents.active;
    for (let i = 0; i < active.length; i += 1) {
      const event = active[i];
      if (event.type === RUN_EVENTS.laneSweep.id) this.updateLaneSweep(event);
      if (event.type === RUN_EVENTS.rewardCache.id) this.updateRewardCache(event);
    }
    // In-place compaction of expired events. Avoids the per-frame
    // .filter() allocation when the active list is small but non-empty.
    let writeIdx = 0;
    for (let i = 0; i < active.length; i += 1) {
      if (this.elapsed < active[i].endAt) {
        if (writeIdx !== i) active[writeIdx] = active[i];
        writeIdx += 1;
      }
    }
    if (writeIdx !== active.length) active.length = writeIdx;
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
      const moveLen = Math.sqrt(mx * mx + my * my);
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
      const facingLen = Math.sqrt(facingX * facingX + facingY * facingY);
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
      if (player.stats.plagueLanceLevel > 0) {
        player.plagueLanceCooldown = (player.plagueLanceCooldown ?? 0) - dt;
        if (player.plagueLanceCooldown <= 0) {
          this.firePlagueLance(player, { x: aimDx, y: aimDy });
          player.plagueLanceCooldown = 1 / (0.55 * this.playerFireRate(player) / player.stats.fireRate);
        }
      }
      if (player.stats.pyreBrandLevel > 0) {
        player.pyreBrandCooldown = (player.pyreBrandCooldown ?? 0) - dt;
        if (player.pyreBrandCooldown <= 0) {
          this.firePyreBrand(player, { x: aimDx, y: aimDy });
          player.pyreBrandCooldown = 1 / (0.6 * this.playerFireRate(player) / player.stats.fireRate);
        }
      }
      if (player.stats.rimeLanceLevel > 0) {
        player.rimeLanceCooldown = (player.rimeLanceCooldown ?? 0) - dt;
        if (player.rimeLanceCooldown <= 0) {
          this.fireRimeLance(player, { x: aimDx, y: aimDy });
          player.rimeLanceCooldown = 1 / (0.6 * this.playerFireRate(player) / player.stats.fireRate);
        }
      }
      if (player.stats.tempestCoilLevel > 0) {
        player.tempestCoilCooldown = (player.tempestCoilCooldown ?? 0) - dt;
        if (player.tempestCoilCooldown <= 0) {
          this.fireTempestCoil(player, { x: aimDx, y: aimDy });
          player.tempestCoilCooldown = 1 / (0.5 * this.playerFireRate(player) / player.stats.fireRate);
        }
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
    const pvx = player.vx ?? 0;
    const pvy = player.vy ?? 0;
    const speedRatio = Math.min(1, Math.sqrt(pvx * pvx + pvy * pvy) / Math.max(1, this.playerSpeed(player)));
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
      // updateEnemyPhase early-returns for non-bosses; gate the call so we
      // skip the function-invocation cost for the ~99% of enemies that
      // aren't bosses.
      if (enemy.rank === "boss") this.updateEnemyPhase(enemy, target, dt);
      const tdx = target.x - enemy.x;
      const tdy = target.y - enemy.y;
      const tlen = Math.sqrt(tdx * tdx + tdy * tdy);
      let dirX = tlen ? tdx / tlen : 0;
      let dirY = tlen ? tdy / tlen : 0;
      let speedMultiplier = 1;
      if (enemy._hastedFlag === undefined) {
        enemy._hastedFlag =
          (enemy.affixes && enemy.affixes.indexOf("hasted") >= 0) || enemy.eliteAffix === "swift";
        // enemy.id is "e<number>" — extract numeric tail without regex alloc.
        const idStr = enemy.id;
        let nid = 0;
        if (typeof idStr === "string") {
          for (let k = 0; k < idStr.length; k += 1) {
            const c = idStr.charCodeAt(k);
            if (c >= 48 && c <= 57) nid = nid * 10 + (c - 48);
          }
        }
        enemy._numericId = nid;
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
        const wlen = Math.sqrt(wx * wx + wy * wy);
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
      // Inlined getAilmentSpeedMultiplier + isFrozen. The original isFrozen
      // call was redundant with the freeze branch already returning 0.
      // The _hasActiveAilments fast path skips the property reads entirely
      // for the bulk of enemies that never get chilled or frozen.
      if (enemy._hasActiveAilments) {
        const ail = enemy.ailments;
        if (ail.freeze && ail.freeze.remaining > 0) {
          speedMultiplier = 0;
        } else if (ail.chill) {
          const chillMag = ail.chill.magnitude;
          if (chillMag) speedMultiplier *= 1 - chillMag;
        }
      }
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
          const sapMultiplier = getAilmentOutgoingDamageMultiplier(enemy);
          const incomingDamage = Math.max(1, enemy.damage * sapMultiplier - this.playerArmor(target));
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
    this._addEnemyToGrid(minion);
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
    // Query radius is generous: projectile + worst-case enemy radius. Boss
    // radius peaks around 45 with the +radiusBonus pool; 50 is the headroom.
    // Per-candidate exact collision (pr + enemy.radius) still gates impact.
    const PROJECTILE_QUERY_PAD = 50;
    const out = this._projectileCollisionScratch ?? (this._projectileCollisionScratch = []);
    for (const projectile of this.projectiles.values()) {
      this.accelerateProjectile(projectile, dt);
      projectile.x += projectile.vx * dt;
      projectile.y += projectile.vy * dt;
      projectile.ttl -= dt;
      if (projectile.ttl <= 0) {
        this.projectiles.delete(projectile.id);
        continue;
      }

      const px = projectile.x;
      const py = projectile.y;
      const pr = projectile.radius;
      const hitIds = projectile.hitEnemyIds;
      const hitIdsLen = hitIds ? hitIds.size : 0;
      this._queryEnemiesInRadius(px, py, pr + PROJECTILE_QUERY_PAD, out);
      // Find the lowest-numericId candidate in collision. Mirrors the
      // original Map-iteration order which yielded the smallest-insertion-
      // id collision first.
      let hit = null;
      let hitNumericId = Infinity;
      for (let i = 0; i < out.length; i += 1) {
        const enemy = out[i];
        if (hitIdsLen > 0 && hitIds.has(enemy.id)) continue;
        const nid = enemy._numericId;
        if (nid >= hitNumericId) continue;
        const hitDistance = pr + enemy.radius;
        const dx = px - enemy.x;
        const dy = py - enemy.y;
        if (dx * dx + dy * dy <= hitDistance * hitDistance) {
          hit = enemy;
          hitNumericId = nid;
        }
      }
      if (hit) {
        const enemy = hit;
        if (hitIds) hitIds.add(enemy.id);
        this.applyBrittleCrit(projectile, enemy);
        this.damageEnemy(enemy, projectile.damage, projectile);
        this.applyProjectileStatuses(projectile, enemy);
        this.splashProjectileDamage(projectile, enemy);
        this.chainProjectileDamage(projectile, enemy);
        this.tempestCoilChainDamage(projectile, enemy);
        this.droneRelayDamage(projectile, enemy);
        if (this.ricochetProjectile(projectile, enemy)) continue;
        if (projectile.pierce > 0) {
          projectile.pierce -= 1;
        } else {
          this.projectiles.delete(projectile.id);
        }
      }
    }
  }

  updateDrones(dt) {
    // Drone radius is 20 + enemy.radius (peaks ~50 for bosses). 70 covers
    // every plausible candidate; the inner loop still does the per-enemy
    // exact (radius+20) check.
    const DRONE_QUERY_PAD = 70;
    const out = this._droneScratch ?? (this._droneScratch = []);
    for (const player of this.players.values()) {
      const droneCount = player.stats.drones;
      if (!droneCount) continue;
      const damagePerHit = (24 + player.stats.damage * 0.4) * dt;
      for (let i = 0; i < droneCount; i += 1) {
        const angle = this.elapsed * (2.2 + i * 0.22) + (Math.PI * 2 * i) / droneCount;
        const droneX = player.x + Math.cos(angle) * 78;
        const droneY = player.y + Math.sin(angle) * 78;
        this._queryEnemiesInRadius(droneX, droneY, DRONE_QUERY_PAD, out);
        if (out.length > 1) out.sort(byNumericIdAsc);
        for (let j = 0; j < out.length; j += 1) {
          const enemy = out[j];
          if (enemy.hp <= 0 || !this.enemies.has(enemy.id)) continue;
          const dx = droneX - enemy.x;
          const dy = droneY - enemy.y;
          const reach = enemy.radius + 20;
          if (dx * dx + dy * dy < reach * reach) {
            this.damageEnemy(enemy, damagePerHit, {
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
    // Hoist pickupMagnetRadius and the collect-distance base out of the
    // pickup × player inner loop. With one player and many pickups this turns
    // an N×P set of redundant computations into one per player per frame.
    // The cache array is reused across frames to avoid per-frame allocation.
    let cache = this._pickupPlayerCache;
    if (!cache) cache = this._pickupPlayerCache = [];
    let count = 0;
    for (const player of this.players.values()) {
      const magnetRadius = this.pickupMagnetRadius(player);
      let entry = cache[count];
      if (!entry) entry = cache[count] = { player: null, magnetRadius: 0, magnetSq: 0, collectBase: 0 };
      entry.player = player;
      entry.magnetRadius = magnetRadius;
      entry.magnetSq = magnetRadius * magnetRadius;
      entry.collectBase = player.radius + player.stats.pickupRadius * 0.55;
      count += 1;
    }
    let toCollect = null;
    for (const pickup of pickupList.values()) {
      for (let i = 0; i < count; i += 1) {
        const entry = cache[i];
        const player = entry.player;
        const magnetRadius = entry.magnetRadius;
        const magnetSq = entry.magnetSq;
        const dx0 = player.x - pickup.x;
        const dy0 = player.y - pickup.y;
        const distSq = dx0 * dx0 + dy0 * dy0;
        if (distSq < magnetSq) {
          const len = Math.sqrt(distSq);
          if (len) {
            const pull = 280 + (1 - len / magnetRadius) * 520;
            const scale = (pull * dt) / len;
            pickup.x += dx0 * scale;
            pickup.y += dy0 * scale;
          }
        }
        const collectDistance = entry.collectBase + pickup.radius;
        const ndx = player.x - pickup.x;
        const ndy = player.y - pickup.y;
        if (ndx * ndx + ndy * ndy <= collectDistance * collectDistance) {
          if (!toCollect) toCollect = [];
          toCollect.push({ pickup, player });
          break;
        }
      }
    }
    if (toCollect) {
      for (let i = 0; i < toCollect.length; i += 1) {
        const { pickup, player } = toCollect[i];
        if (!pickupList.has(pickup.id)) continue;
        pickupList.delete(pickup.id);
        this.markRewardCacheCollected(pickup);
        this.collectPickup(player, pickup);
      }
    }
    for (let i = 0; i < count; i += 1) cache[i].player = null;
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
    let dirX = 0;
    let dirY = 0;
    let hitX = enemy.x;
    let hitY = enemy.y;
    if (source) {
      const svx = source.vx ?? enemy.x - source.x;
      const svy = source.vy ?? enemy.y - source.y;
      const slen = Math.sqrt(svx * svx + svy * svy);
      if (slen) {
        dirX = svx / slen;
        dirY = svy / slen;
      }
      if (source.x !== undefined) hitX = source.x;
      if (source.y !== undefined) hitY = source.y;
    }
    const markedMultiplier = (enemy.markedFor ?? 0) > 0 ? 1 + (enemy.markedDamageTakenMultiplier ?? 0) : 1;
    const damageType = source?.damageType ?? "physical";
    const ailmentMultiplier = getAilmentDamageTakenMultiplier(enemy, damageType);
    const frostbiteMultiplier = source?.frostbite && (source.permafrostBonus ?? 0) > 0
      ? 1 + (this.enemyHasColdAilment(enemy) ? source.permafrostBonus : 0)
      : 1;
    const minimumDamage = source?.allowSubUnitDamage ? 0 : 1;
    const mitigation = source?.ignoreArmor ? 0 : (enemy.armor ?? 0) + this.enemyArmorAuraBonus(enemy);
    const appliedDamage = Math.max(minimumDamage, damage * markedMultiplier * ailmentMultiplier * frostbiteMultiplier - mitigation);
    const shouldShatter = source?.shatterpoint && !source.fromAilment && this.enemyIsShatterable(enemy);
    enemy.hp -= appliedDamage;
    if (source?.isCritical && source.executeThreshold > 0 && enemy.hp > 0 && enemy.hp <= enemy.maxHp * source.executeThreshold) {
      enemy.hp = 0;
    }
    enemy.hitFlash = Math.max(enemy.hitFlash ?? 0, 0.12);
    enemy.hitVx = (enemy.hitVx ?? 0) + dirX * 90;
    enemy.hitVy = (enemy.hitVy ?? 0) + dirY * 90;
    if (!this.headless) {
      this.spawnHitEffect(hitX, hitY, { x: dirX, y: dirY }, appliedDamage, enemy.hp <= 0);
    }
    if (source && !source.fromAilment && appliedDamage > 0 && enemy.hp > 0) {
      const breakdown = source.damageBreakdown ?? null;
      const ownerPlayer = source.ownerId ? this.players.get(source.ownerId) : null;
      const poisonDotMultiplier = ownerPlayer?.stats?.virulence1 > 0 ? 1.5 : 1;
      const poisonMaxStacks = ownerPlayer?.stats?.virulence3 > 0 ? 12 : 0;
      const igniteDotMultiplier = ownerPlayer?.stats?.conflagration1 > 0 ? 1.4 : 1;
      const scorchMagnitudeBonus = ownerPlayer?.stats?.conflagration3 > 0 ? 0.25 : 0;
      const brittleMagnitudeBonus = source.cryoclasmBrittleBonus ?? 0;
      // Tempest Coil overcharges. Per-source `shockMagnitudeBonus` /
      // `sapMagnitudeBonus` on the projectile/hit override the weaker player
      // default, so non-tempest hits don't get a free shock buff.
      const shockMagnitudeBonus = source.shockMagnitudeBonus ?? 0;
      const sapMagnitudeBonus = source.sapMagnitudeBonus ?? 0;
      applyAilmentsFromHit(
        enemy,
        {
          damage: appliedDamage,
          damageType,
          breakdown,
          ownerId: source.ownerId ?? null,
          poisonDotMultiplier,
          poisonMaxStacks,
          igniteDotMultiplier,
          scorchMagnitudeBonus,
          brittleMagnitudeBonus,
          shockMagnitudeBonus,
          sapMagnitudeBonus,
        },
        this.rng,
      );
    }
    if (shouldShatter) {
      this.triggerShatterBurst(enemy, source);
    }
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
    this.triggerContagionBurst(enemy, owner, source);
    this.triggerWildfireBurst(enemy, owner, source);
    this.triggerStaticDischarge(enemy, owner);
    this.triggerEnemyDeathAffixes(enemy, owner);
    this.spawnSplitChildren(enemy);
    const pickup = this.createEnemyDrop(enemy, owner);
    this.pickups.set(pickup.id, pickup);
  }

  // ---- Spatial grid -------------------------------------------------------
  // Cell size 128 — large enough that the 240-unit gravity burst still
  // touches only ~5x5 cells, small enough that 70-unit bursts only
  // touch ~3x3 cells. 128 is a power of two so cell coords are an
  // arithmetic right shift.
  //
  // Cell key = cy * GRID_STRIDE + cx, where cx/cy are non-negative cell
  // indices computed from a positive-shifted world position. Using an
  // OFFSET large enough to keep `value + OFFSET` non-negative for any
  // simulation position lets us use `(value + OFFSET) | 0` instead of
  // Math.floor — `| 0` truncates toward zero, which matches floor for
  // non-negative values. This shaves the floor call out of the inner loop.
  // OFFSET=8192 covers the cleanup horizon (~1800) with plenty of slack.
  // Flat array of buckets indexed by cell key. Faster than a Map at the
  // 290-enemy scale: no hash overhead in the hot insert/get path. The
  // _gridOccupiedKeys list lets us clear only the buckets that were used,
  // avoiding a 65536-entry sweep each frame.
  _ensureGridStorage() {
    if (this._gridBuckets) return;
    this._gridBuckets = new Array(65536);
    this._gridBucketPool = [];
    this._gridOccupiedKeys = [];
  }

  _resetEnemyGrid() {
    const buckets = this._gridBuckets;
    const pool = this._gridBucketPool;
    const occupied = this._gridOccupiedKeys;
    for (let i = 0; i < occupied.length; i += 1) {
      const key = occupied[i];
      const bucket = buckets[key];
      if (bucket) {
        bucket.length = 0;
        pool.push(bucket);
        buckets[key] = undefined;
      }
    }
    occupied.length = 0;
  }

  _rebuildEnemyGrid() {
    this._ensureGridStorage();
    this._resetEnemyGrid();
    const buckets = this._gridBuckets;
    const pool = this._gridBucketPool;
    const occupied = this._gridOccupiedKeys;
    for (const enemy of this.enemies.values()) {
      // Lazily compute the parsed numeric id once per enemy. Determinism-
      // critical paths sort grid candidates by this value to mimic the
      // ascending-insertion-order semantics of Map.values().
      if (enemy._numericId === undefined) {
        const idStr = enemy.id;
        let nid = 0;
        if (typeof idStr === "string") {
          for (let k = 0; k < idStr.length; k += 1) {
            const c = idStr.charCodeAt(k);
            if (c >= 48 && c <= 57) nid = nid * 10 + (c - 48);
          }
        }
        enemy._numericId = nid;
      }
      const cx = ((enemy.x + 8192) | 0) >> 7;
      const cy = ((enemy.y + 8192) | 0) >> 7;
      const key = (cy << 8) | cx;
      let bucket = buckets[key];
      if (!bucket) {
        bucket = pool.length ? pool.pop() : [];
        buckets[key] = bucket;
        occupied.push(key);
      }
      bucket.push(enemy);
      enemy._gridKey = key;
    }
  }

  // Insert a freshly-spawned enemy into the live grid so queries later in
  // the same step() see it. Called from spawnSplitChildren / spawnBossMinion.
  _addEnemyToGrid(enemy) {
    if (!this._gridBuckets) return;
    if (enemy._numericId === undefined) {
      const idStr = enemy.id;
      let nid = 0;
      if (typeof idStr === "string") {
        for (let k = 0; k < idStr.length; k += 1) {
          const c = idStr.charCodeAt(k);
          if (c >= 48 && c <= 57) nid = nid * 10 + (c - 48);
        }
      }
      enemy._numericId = nid;
    }
    const cx = ((enemy.x + 8192) | 0) >> 7;
    const cy = ((enemy.y + 8192) | 0) >> 7;
    const key = (cy << 8) | cx;
    const buckets = this._gridBuckets;
    let bucket = buckets[key];
    if (!bucket) {
      const pool = this._gridBucketPool;
      bucket = pool.length ? pool.pop() : [];
      buckets[key] = bucket;
      this._gridOccupiedKeys.push(key);
    }
    bucket.push(enemy);
    enemy._gridKey = key;
  }

  // Push every enemy whose current position is within `radius` of (x, y)
  // into `out` (which is reset to length 0). Reads enemy.x/.y live, so the
  // result reflects this-frame movement even though buckets were assigned
  // at frame start (any drift is far smaller than a cell).
  _queryEnemiesInRadius(x, y, radius, out) {
    out.length = 0;
    // Tests exercise splash/chain/burst paths by calling updateProjectiles
    // or damageEnemy directly, without going through step(). Build the grid
    // on first query so those paths still see the right candidate set.
    if (!this._gridBuckets) this._rebuildEnemyGrid();
    const buckets = this._gridBuckets;
    if (this._gridOccupiedKeys.length === 0) return out;
    const radiusSq = radius * radius;
    const minCx = ((x - radius + 8192) | 0) >> 7;
    const maxCx = ((x + radius + 8192) | 0) >> 7;
    const minCy = ((y - radius + 8192) | 0) >> 7;
    const maxCy = ((y + radius + 8192) | 0) >> 7;
    for (let cy = minCy; cy <= maxCy; cy += 1) {
      const cyShift = cy << 8;
      for (let cx = minCx; cx <= maxCx; cx += 1) {
        const bucket = buckets[cyShift | cx];
        if (!bucket) continue;
        for (let i = 0; i < bucket.length; i += 1) {
          const enemy = bucket[i];
          const dx = enemy.x - x;
          const dy = enemy.y - y;
          if (dx * dx + dy * dy <= radiusSq) out.push(enemy);
        }
      }
    }
    return out;
  }

  enemyArmorAuraBonus(enemy) {
    if (!this.enemies.has(enemy.id)) return 0;
    // Cache the warden list once per tick. With wardens being rare relative
    // to total enemies, iterating only wardens is ~N/W times cheaper than
    // scanning the full enemy map for every damage event in the tick.
    if (this._wardenListTick !== this.tick) {
      let wardens = this._wardenList;
      if (!wardens) wardens = this._wardenList = [];
      wardens.length = 0;
      for (const other of this.enemies.values()) {
        if (other.type === "warden" && other.hp > 0) wardens.push(other);
      }
      this._wardenListTick = this.tick;
    }
    const wardens = this._wardenList;
    if (!wardens.length) return 0;
    const ex = enemy.x;
    const ey = enemy.y;
    const eid = enemy.id;
    for (let i = 0; i < wardens.length; i += 1) {
      const other = wardens[i];
      // Cached list may include a warden that has died this tick; skip it.
      if (other.hp <= 0 || other.id === eid) continue;
      const dx = ex - other.x;
      const dy = ey - other.y;
      if (dx * dx + dy * dy <= 36100) return 5;
    }
    return 0;
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
      const sapMultiplier = getAilmentOutgoingDamageMultiplier(enemy);
      const incomingDamage = Math.max(1, enemy.volatileDamage * sapMultiplier - this.playerArmor(player));
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
    const speed = Math.sqrt(projectile.vx * projectile.vx + projectile.vy * projectile.vy);
    if (!speed) return;
    const maxSpeed = (projectile.initialSpeed || speed) * projectile.maxSpeedMultiplier;
    if (speed >= maxSpeed) return;
    const nextSpeed = Math.min(maxSpeed, speed * (1 + projectile.acceleration * dt));
    const scale = nextSpeed / speed;
    projectile.vx *= scale;
    projectile.vy *= scale;
  }

  applyBrittleCrit(projectile, enemy) {
    if (projectile.isCritical) return;
    const bonus = getAilmentCritChanceBonus(enemy);
    if (bonus <= 0) return;
    if (this.rng.next() >= bonus) return;
    const owner = this.players.get(projectile.ownerId);
    const critDamage = owner?.stats?.critDamage ?? 1;
    if (critDamage <= 1) return;
    projectile.damage *= critDamage;
    projectile.isCritical = true;
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
    // Skip the updateAilments call entirely when this enemy has no active
    // ailments. The flag is maintained by ailments.js and covers the common
    // case where most spawned enemies never get debuffed in their lifetime.
    if (enemy._hasActiveAilments) {
      updateAilments(this, enemy, dt);
      if (!this.enemies.has(enemy.id)) return;
    }
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
      fromAilment: true,
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
    const out = this._splashScratch ?? (this._splashScratch = []);
    this._queryEnemiesInRadius(firstEnemy.x, firstEnemy.y, projectile.splashRadius, out);
    if (out.length > 1) out.sort(byNumericIdAsc);
    let caught = 0;
    const splashDamage = projectile.damage * projectile.splashDamageMultiplier;
    const ownerId = projectile.ownerId;
    const fx = firstEnemy.x;
    const fy = firstEnemy.y;
    const fid = firstEnemy.id;
    for (let i = 0; i < out.length; i += 1) {
      const enemy = out[i];
      if (enemy.id === fid || enemy.hp <= 0 || !this.enemies.has(enemy.id)) continue;
      caught += 1;
      this.damageEnemy(enemy, splashDamage, {
        ownerId,
        x: fx,
        y: fy,
        vx: enemy.x - fx,
        vy: enemy.y - fy,
      });
    }
    if (caught > 0 && projectile.splashCenterBonusPerTarget > 0 && this.enemies.has(fid)) {
      this.damageEnemy(firstEnemy, projectile.damage * projectile.splashCenterBonusPerTarget * caught, {
        ownerId,
        x: fx,
        y: fy,
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
    const targets = this.nearestChainTargets(firstEnemy, projectile.hitEnemyIds ?? new Set([firstEnemy.id]), projectile.droneArcRange, droneCount);
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
    const target = this.nearestChainTarget(firstEnemy, projectile.hitEnemyIds ?? new Set(), projectile.ricochetRange);
    if (!target) return false;
    const direction = normalize(target.x - firstEnemy.x, target.y - firstEnemy.y);
    projectile.x = firstEnemy.x + direction.x * (firstEnemy.radius + projectile.radius + 2);
    projectile.y = firstEnemy.y + direction.y * (firstEnemy.radius + projectile.radius + 2);
    const speed = Math.sqrt(projectile.vx * projectile.vx + projectile.vy * projectile.vy) || 1;
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
    // Determinism note: the linear-scan version iterated this.enemies in
    // ascending insertion order and used `dist <= best` so that ties
    // resolved to the highest-id enemy. The grid yields candidates in
    // bucket order; sort by ascending _numericId before the scan so the
    // same tie-break (highest-id wins) holds.
    const out = this._chainScratch ?? (this._chainScratch = []);
    this._queryEnemiesInRadius(sourceEnemy.x, sourceEnemy.y, range, out);
    if (out.length > 1) out.sort(byNumericIdAsc);
    const sx = sourceEnemy.x;
    const sy = sourceEnemy.y;
    let nearest = null;
    let best = range * range;
    for (let i = 0; i < out.length; i += 1) {
      const enemy = out[i];
      if (excludedIds.has(enemy.id)) continue;
      const dx = enemy.x - sx;
      const dy = enemy.y - sy;
      const dist = dx * dx + dy * dy;
      if (dist <= best) {
        best = dist;
        nearest = enemy;
      }
    }
    return nearest;
  }

  triggerContagionBurst(enemy, owner, source) {
    if (!owner || !(owner.stats.virulence2 > 0)) return;
    if (source && (source.contagionDepth ?? 0) >= 1) return;
    const poison = enemy.ailments?.poison;
    const stacks = poison?.stacks;
    if (!Array.isArray(stacks) || stacks.length < 4) return;
    let dpsSum = 0;
    for (const s of stacks) dpsSum += s?.dotPerSecond ?? 0;
    if (dpsSum <= 0) return;
    const burstDamage = dpsSum * 0.6;
    const radius = 70;
    if (!this.headless) {
      const effectId = this.entityId();
      this.effects.set(effectId, createEffect(effectId, "volatileBurst", enemy.x, enemy.y, radius, 0.32));
    }
    const out = this._contagionScratch ?? (this._contagionScratch = []);
    this._queryEnemiesInRadius(enemy.x, enemy.y, radius, out);
    if (out.length > 1) out.sort(byNumericIdAsc);
    const ownerId = owner.id;
    const ex = enemy.x;
    const ey = enemy.y;
    const eid = enemy.id;
    for (let i = 0; i < out.length; i += 1) {
      const other = out[i];
      if (other.id === eid || other.hp <= 0 || !this.enemies.has(other.id)) continue;
      this.damageEnemy(other, burstDamage, {
        ownerId,
        x: ex,
        y: ey,
        vx: other.x - ex,
        vy: other.y - ey,
        damageType: "chaos",
        damageBreakdown: { chaos: burstDamage },
        fromAilment: false,
        contagionDepth: 1,
      });
    }
  }

  triggerWildfireBurst(enemy, owner, source) {
    if (!owner || !(owner.stats.conflagration2 > 0)) return;
    if (source && (source.wildfireDepth ?? 0) >= 1) return;
    if (!enemy.ailments?.ignite || !(enemy.ailments.ignite.remaining > 0)) return;
    const igniteDps = enemy.ailments.ignite.dotPerSecond ?? 0;
    if (igniteDps <= 0) return;
    const burstDamage = igniteDps * 0.8;
    const radius = 80;
    if (!this.headless) {
      const effectId = this.entityId();
      this.effects.set(effectId, createEffect(effectId, "volatileBurst", enemy.x, enemy.y, radius, 0.32));
    }
    const out = this._wildfireScratch ?? (this._wildfireScratch = []);
    this._queryEnemiesInRadius(enemy.x, enemy.y, radius, out);
    if (out.length > 1) out.sort(byNumericIdAsc);
    const ownerId = owner.id;
    const ex = enemy.x;
    const ey = enemy.y;
    const eid = enemy.id;
    for (let i = 0; i < out.length; i += 1) {
      const other = out[i];
      if (other.id === eid || other.hp <= 0 || !this.enemies.has(other.id)) continue;
      this.damageEnemy(other, burstDamage, {
        ownerId,
        x: ex,
        y: ey,
        vx: other.x - ex,
        vy: other.y - ey,
        damageType: "fire",
        damageBreakdown: { fire: burstDamage },
        fromAilment: false,
        wildfireDepth: 1,
      });
    }
  }

  enemyHasColdAilment(enemy) {
    const ail = enemy?.ailments;
    if (!ail) return false;
    if (ail.chill) return true;
    if (ail.freeze && ail.freeze.remaining > 0) return true;
    if (ail.brittle && ail.brittle.remaining > 0) return true;
    return false;
  }

  enemyIsShatterable(enemy) {
    const ail = enemy?.ailments;
    if (!ail) return false;
    if (ail.freeze && ail.freeze.remaining > 0) return true;
    // Brittle path: works even on freeze-immune bosses/elites since brittle has
    // no rank resistance. This is the "brittle is the crit payoff" hook.
    if (ail.brittle && ail.brittle.remaining > 0) return true;
    return false;
  }

  triggerShatterBurst(sourceEnemy, source) {
    const radius = source.shatterRadius || 70;
    const critMult = source.isCritical ? source.shatterCritMultiplier || 1 : 1;
    const burstDamage = (source.shatterDamage || 0) * critMult;
    if (burstDamage <= 0) return;
    if (!this.headless) {
      const effectId = this.entityId();
      this.effects.set(effectId, createEffect(effectId, "volatileBurst", sourceEnemy.x, sourceEnemy.y, radius, 0.3));
    }
    // Hit the source enemy too (includes freeze-immune bosses via brittle path),
    // then nearby enemies. fromAilment:true so the burst cannot re-apply ailments.
    const out = this._shatterScratch ?? (this._shatterScratch = []);
    this._queryEnemiesInRadius(sourceEnemy.x, sourceEnemy.y, radius, out);
    if (out.length > 1) out.sort(byNumericIdAsc);
    const ownerId = source.ownerId ?? null;
    const sx = sourceEnemy.x;
    const sy = sourceEnemy.y;
    const sid = sourceEnemy.id;
    // Source first, then nearby enemies in ascending-id order. Preserves the
    // original Map-iteration ordering used for damage application.
    if (this.enemies.has(sid) && sourceEnemy.hp > 0) {
      this.damageEnemy(sourceEnemy, burstDamage, {
        ownerId,
        x: sx,
        y: sy,
        vx: 0,
        vy: 0,
        damageType: "cold",
        damageBreakdown: { cold: burstDamage },
        fromAilment: true,
        ailment: "shatter",
      });
    }
    for (let i = 0; i < out.length; i += 1) {
      const target = out[i];
      if (target.id === sid || target.hp <= 0 || !this.enemies.has(target.id)) continue;
      this.damageEnemy(target, burstDamage, {
        ownerId,
        x: sx,
        y: sy,
        vx: target.x - sx,
        vy: target.y - sy,
        damageType: "cold",
        damageBreakdown: { cold: burstDamage },
        fromAilment: true,
        ailment: "shatter",
      });
    }
  }

  firePyreBrand(player, aimDirection = null) {
    const direction = normalize(aimDirection?.x ?? player.facingX, aimDirection?.y ?? player.facingY);
    const baseDamage = 28;
    const breakdown = { physical: 8, fire: 20 };
    const projectile = createProjectile(
      this.entityId(),
      player.id,
      player.x + direction.x * 26,
      player.y + direction.y * 26,
      direction.x * 480,
      direction.y * 480,
      baseDamage,
      Math.max(5, player.stats.projectileRadius + 1),
      Math.max(player.stats.projectileTtl, 1.5),
      {
        pierce: 2,
        color: "#ffb347",
        glowColor: "rgba(255, 122, 58, 0.55)",
        damageType: "fire",
        damageBreakdown: breakdown,
      },
    );
    this.projectiles.set(projectile.id, projectile);
  }

  fireRimeLance(player, aimDirection = null) {
    const direction = normalize(aimDirection?.x ?? player.facingX, aimDirection?.y ?? player.facingY);
    const baseDamage = 30;
    const breakdown = { physical: 10, cold: 22 };
    const permafrost = player.stats.glaciation1 > 0 ? 0.35 : 0;
    const shatterpoint = player.stats.glaciation2 > 0;
    const cryoclasm = player.stats.glaciation3 > 0;
    const projectile = createProjectile(
      this.entityId(),
      player.id,
      player.x + direction.x * 26,
      player.y + direction.y * 26,
      direction.x * 540,
      direction.y * 540,
      baseDamage,
      Math.max(4, player.stats.projectileRadius),
      Math.max(player.stats.projectileTtl, 1.6),
      {
        pierce: 2,
        color: "#bff4ff",
        glowColor: "rgba(126, 209, 255, 0.6)",
        damageType: "cold",
        damageBreakdown: breakdown,
        frostbite: true,
        permafrostBonus: permafrost,
        shatterpoint,
        shatterRadius: 70,
        shatterDamage: shatterpoint ? 18 : 0,
        shatterCritMultiplier: cryoclasm ? 2 : 1,
        cryoclasmBrittleBonus: cryoclasm ? 0.1 : 0,
      },
    );
    this.projectiles.set(projectile.id, projectile);
  }

  firePlagueLance(player, aimDirection = null) {
    const direction = normalize(aimDirection?.x ?? player.facingX, aimDirection?.y ?? player.facingY);
    const baseDamage = 32;
    const breakdown = { physical: 12, chaos: 20 };
    const projectile = createProjectile(
      this.entityId(),
      player.id,
      player.x + direction.x * 26,
      player.y + direction.y * 26,
      direction.x * 520,
      direction.y * 520,
      baseDamage,
      Math.max(4, player.stats.projectileRadius),
      Math.max(player.stats.projectileTtl, 1.6),
      {
        pierce: 3,
        color: "#9ef27a",
        glowColor: "rgba(176, 107, 255, 0.55)",
        damageType: "chaos",
        damageBreakdown: breakdown,
      },
    );
    this.projectiles.set(projectile.id, projectile);
  }

  fireTempestCoil(player, aimDirection = null) {
    const direction = normalize(aimDirection?.x ?? player.facingX, aimDirection?.y ?? player.facingY);
    const baseDamage = 30;
    const breakdown = { lightning: baseDamage };
    const overcharge1 = player.stats.overcharge1 > 0;
    const overcharge2 = player.stats.overcharge2 > 0;
    // Tier I deepens the chain; tier II overloads it (more shock, more sap).
    const tempestArcs = 2 + (overcharge1 ? 2 : 0);
    const tempestDamageMultiplier = 0.55 + (overcharge1 ? 0.15 : 0);
    const shockMagnitudeBonus = overcharge2 ? 0.25 : 0;
    const sapMagnitudeBonus = overcharge2 ? 0.1 : 0;
    const projectile = createProjectile(
      this.entityId(),
      player.id,
      player.x + direction.x * 26,
      player.y + direction.y * 26,
      direction.x * 460,
      direction.y * 460,
      baseDamage,
      Math.max(5, player.stats.projectileRadius + 1),
      Math.max(player.stats.projectileTtl, 1.4),
      {
        pierce: 3,
        color: "#ffe66b",
        glowColor: "rgba(140, 200, 255, 0.55)",
        damageType: "lightning",
        damageBreakdown: breakdown,
        weaponKind: "tempestCoil",
        tempestArcs,
        tempestRange: 190,
        tempestDamageMultiplier,
        shockMagnitudeBonus,
        sapMagnitudeBonus,
      },
    );
    this.projectiles.set(projectile.id, projectile);
  }

  // Tempest Coil chain. Hops from the primary hit through up to `tempestArcs`
  // additional enemies, never re-hitting the same target. Each hop is marked
  // `fromAilment:true` so it cannot recursively roll new shocks/saps — only
  // the primary projectile impact and the tier-III death discharge apply
  // ailments. Hard depth cap prevents infinite chain storms.
  tempestCoilChainDamage(projectile, firstEnemy) {
    if (projectile.weaponKind !== "tempestCoil") return;
    if (!projectile.tempestArcs || !projectile.tempestRange || projectile.tempestDamageMultiplier <= 0) return;
    const chainedEnemyIds = new Set([firstEnemy.id]);
    let sourceEnemy = firstEnemy;
    const hardCap = Math.min(projectile.tempestArcs, 8);
    for (let arc = 0; arc < hardCap; arc += 1) {
      const target = this.nearestChainTarget(sourceEnemy, chainedEnemyIds, projectile.tempestRange);
      if (!target) return;
      chainedEnemyIds.add(target.id);
      this.damageEnemy(target, projectile.damage * projectile.tempestDamageMultiplier, {
        ownerId: projectile.ownerId,
        x: sourceEnemy.x,
        y: sourceEnemy.y,
        vx: target.x - sourceEnemy.x,
        vy: target.y - sourceEnemy.y,
        damageType: "lightning",
        damageBreakdown: { lightning: projectile.damage * projectile.tempestDamageMultiplier },
        // Chain hops are secondary damage — must NOT re-roll ailments per the
        // ailment-system contract. Shock/sap come from the primary hit only.
        fromAilment: true,
        ailment: "tempestChain",
      });
    }
  }

  // Tier III "Static Discharge": when a shocked enemy dies and the killing
  // owner has overcharge3, release a single small lightning burst at the
  // corpse. Damage is `fromAilment:true` so it cannot re-apply shock and
  // therefore cannot chain into another discharge — capped at one burst per
  // death.
  triggerStaticDischarge(enemy, owner) {
    if (!owner || !(owner.stats.overcharge3 > 0)) return;
    const shock = enemy.ailments?.shock;
    if (!shock || !(shock.remaining > 0)) return;
    const radius = 90;
    // Damage scales with the shock magnitude that was on the corpse — a
    // bigger overload means a bigger goodbye.
    const burstDamage = 18 + (shock.magnitude || 0) * 60;
    if (!this.headless) {
      const effectId = this.entityId();
      this.effects.set(effectId, createEffect(effectId, "volatileBurst", enemy.x, enemy.y, radius, 0.28));
    }
    const out = this._staticScratch ?? (this._staticScratch = []);
    this._queryEnemiesInRadius(enemy.x, enemy.y, radius, out);
    if (out.length > 1) out.sort(byNumericIdAsc);
    const ownerId = owner.id;
    const ex = enemy.x;
    const ey = enemy.y;
    const eid = enemy.id;
    for (let i = 0; i < out.length; i += 1) {
      const other = out[i];
      if (other.id === eid || other.hp <= 0 || !this.enemies.has(other.id)) continue;
      this.damageEnemy(other, burstDamage, {
        ownerId,
        x: ex,
        y: ey,
        vx: other.x - ex,
        vy: other.y - ey,
        damageType: "lightning",
        damageBreakdown: { lightning: burstDamage },
        fromAilment: true,
        ailment: "staticDischarge",
      });
    }
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
      this._addEnemyToGrid(child);
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
    const radius = 240 * player.stats.area;
    const out = this._gravityScratch ?? (this._gravityScratch = []);
    this._queryEnemiesInRadius(player.x, player.y, radius, out);
    if (out.length > 1) out.sort(byNumericIdAsc);
    const px = player.x;
    const py = player.y;
    const pull = 52 * player.stats.gravityWell * player.stats.area;
    const dmg = 22 * player.stats.gravityWell;
    for (let i = 0; i < out.length; i += 1) {
      const enemy = out[i];
      if (enemy.hp <= 0 || !this.enemies.has(enemy.id)) continue;
      const direction = normalize(px - enemy.x, py - enemy.y);
      enemy.x += direction.x * pull;
      enemy.y += direction.y * pull;
      this.damageEnemy(enemy, dmg, {
        x: px,
        y: py,
        vx: enemy.x - px,
        vy: enemy.y - py,
      });
    }
  }

  cleanupFarEntities() {
    const limitSq = 1800 * 1800;
    const players = this.players;
    // Map iteration tolerates deletion of the current entry, so we can drop
    // far enemies in place instead of staging an id list and re-iterating.
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
      if (!close) this.enemies.delete(enemy.id);
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
    if (this._difficultyCacheElapsed !== this.elapsed || !this.difficulty) {
      this.difficulty = difficultyAt(this.elapsed);
      this._difficultyCacheElapsed = this.elapsed;
    }
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
