import { GAME, NETWORK, PLAYER_BASE } from "./config.js";
import { createEffect, createEnemy, createPickup, createPlayer, createProjectile } from "./entities.js";
import { clamp, distanceSq, normalize, Rng } from "./math.js";
import { applyMetaProgress, normalizeMetaProgress } from "./metaProgression.js";
import { createTargetingConfig, mergeTargetingConfig, selectTarget } from "./targeting.js";
import { pickUpgradeChoices, UPGRADE_POOL } from "./upgrades.js";

export class GameSimulation {
  constructor({ seed = Date.now(), localPlayerId = "p1", targeting = {}, metaProgress = {} } = {}) {
    this.rng = new Rng(seed);
    this.targeting = createTargetingConfig(targeting);
    this.metaProgress = normalizeMetaProgress(metaProgress);
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
    this.wave = 1;
    this.spawnTimer = 0;
    this.addPlayer(localPlayerId);
  }

  addPlayer(id) {
    const spawnAngle = this.rng.range(0, Math.PI * 2);
    const player = createPlayer(id, Math.cos(spawnAngle) * 80, Math.sin(spawnAngle) * 80);
    applyMetaProgress(player, this.metaProgress);
    this.players.set(id, player);
    this.inputs.set(id, { moveX: 0, moveY: 0 });
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
    });
  }

  setTargetingConfig(targeting) {
    this.targeting = mergeTargetingConfig(this.targeting, targeting);
  }

  step(dt) {
    if (this.state !== "playing") return;
    this.tick += 1;
    this.elapsed += dt;
    this.wave = 1 + Math.floor(this.elapsed / 45);
    this.updatePlayers(dt);
    this.updateSpawning(dt);
    this.updateEnemies(dt);
    this.updateProjectiles(dt);
    this.updateDrones(dt);
    this.updatePickups(dt);
    this.updateEffects(dt);
    this.cleanupFarEntities();
    this.checkGameOver();
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
    return {
      protocolVersion: NETWORK.protocolVersion,
      tick: this.tick,
      elapsed: this.elapsed,
      state: this.state,
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
      pendingUpgradeChoices: this.pendingUpgradeChoices,
      targeting: this.targeting,
    };
  }

  updatePlayers(dt) {
    for (const player of this.players.values()) {
      const input = this.inputs.get(player.id) ?? { moveX: 0, moveY: 0 };
      const move = normalize(input.moveX, input.moveY);
      player.overdriveFor = Math.max(0, (player.overdriveFor ?? 0) - dt);
      player.magnetBurstFor = Math.max(0, (player.magnetBurstFor ?? 0) - dt);
      player.vx = move.x * this.playerSpeed(player);
      player.vy = move.y * this.playerSpeed(player);
      player.x = clamp(player.x + player.vx * dt, -GAME.worldRadius, GAME.worldRadius);
      player.y = clamp(player.y + player.vy * dt, -GAME.worldRadius, GAME.worldRadius);
      player.invulnerableFor = Math.max(0, player.invulnerableFor - dt);
      player.cooldown -= dt;
      if (player.stats.regen > 0 && player.hp < player.stats.maxHp * 0.7) {
        player.hp = Math.min(player.stats.maxHp, player.hp + player.stats.regen * dt);
      }
      this.updatePlayerFacing(player, dt);

      if (player.cooldown <= 0 && this.canFirePrimaryWeapon(player)) {
        this.fireVolley(player);
        player.cooldown = 0.42 / this.playerFireRate(player);
      }
    }
  }

  fireVolley(player) {
    const direction = normalize(player.facingX, player.facingY);
    const spread = 0.18;
    const count = player.stats.projectiles;
    for (let i = 0; i < count; i += 1) {
      const offset = (i - (count - 1) / 2) * spread;
      const cos = Math.cos(offset);
      const sin = Math.sin(offset);
      const dx = direction.x * cos - direction.y * sin;
      const dy = direction.x * sin + direction.y * cos;
      const projectile = createProjectile(
        this.entityId(),
        player.id,
        player.x + dx * 24,
        player.y + dy * 24,
        dx * player.stats.projectileSpeed,
        dy * player.stats.projectileSpeed,
        this.rollDamage(player),
        player.stats.projectileRadius,
        player.stats.projectileTtl,
        {
          pierce: player.stats.projectilePierce,
          chainArcs: player.stats.chainArcs,
          chainRange: player.stats.chainRange,
          chainDamageMultiplier: player.stats.chainDamageMultiplier,
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
    const crit = this.rng.next() < player.stats.critChance;
    return player.stats.damage * (crit ? player.stats.critDamage : 1);
  }

  primaryTargetFor(player) {
    return selectTarget(player, [...this.enemies.values()], this.targeting.primaryWeapon, this.rng);
  }

  canFirePrimaryWeapon(player) {
    const target = this.primaryTargetFor(player);
    if (!target) return false;
    const targetDirection = normalize(target.x - player.x, target.y - player.y);
    const facing = normalize(player.facingX, player.facingY);
    const dot = facing.x * targetDirection.x + facing.y * targetDirection.y;
    const threshold = Math.cos((this.targeting.primaryWeapon.firingAngleDegrees * Math.PI) / 180);
    return dot >= threshold;
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
    if (this.spawnTimer > 0 || this.enemies.size >= GAME.maxEnemies) return;
    const alivePlayers = [...this.players.values()].filter((player) => player.hp > 0);
    if (!alivePlayers.length) return;
    const packSize = Math.min(3 + this.wave, 15);
    for (let i = 0; i < packSize; i += 1) {
      const target = this.rng.pick(alivePlayers);
      const angle = this.rng.range(0, Math.PI * 2);
      const distance = this.rng.range(650, 900);
      const typeRoll = this.rng.next();
      const splitterChance = this.wave >= 2 ? Math.min(0.04 + this.wave * 0.008, 0.14) : 0;
      const bruiserChance = Math.min(0.1 + this.wave * 0.015, 0.35);
      const type = typeRoll < splitterChance ? "splitter" : typeRoll < splitterChance + bruiserChance ? "bruiser" : "drone";
      const eliteAffix = this.rollEliteAffix();
      const enemy = createEnemy(
        this.entityId(),
        type,
        target.x + Math.cos(angle) * distance,
        target.y + Math.sin(angle) * distance,
        this.wave,
        { eliteAffix },
      );
      this.enemies.set(enemy.id, enemy);
    }
    this.spawnTimer = Math.max(0.36, 1.7 - this.wave * 0.08);
  }

  rollEliteAffix() {
    const eliteChance = this.wave >= 3 ? Math.min(0.035 + this.wave * 0.007, 0.12) : 0;
    if (this.rng.next() >= eliteChance) return null;
    return this.rng.next() < 0.5 ? "swift" : "armored";
  }

  updateEnemies(dt) {
    const alivePlayers = [...this.players.values()].filter((player) => player.hp > 0);
    for (const enemy of this.enemies.values()) {
      const target = this.nearestPlayer(enemy, alivePlayers);
      if (!target) continue;
      const direction = this.enemyMoveDirection(enemy, target, dt);
      enemy.x += direction.x * enemy.speed * dt;
      enemy.y += direction.y * enemy.speed * dt;
      enemy.x += enemy.hitVx * dt;
      enemy.y += enemy.hitVy * dt;
      enemy.hitVx *= Math.pow(0.86, dt * 60);
      enemy.hitVy *= Math.pow(0.86, dt * 60);
      enemy.hitFlash = Math.max(0, enemy.hitFlash - dt);

      const hitDistance = enemy.radius + target.radius;
      if (distanceSq(enemy.x, enemy.y, target.x, target.y) <= hitDistance * hitDistance) {
        if (target.invulnerableFor <= 0) {
          const incomingDamage = Math.max(1, enemy.damage - target.stats.armor);
          const absorbed = Math.min(target.shield ?? 0, incomingDamage);
          target.shield = Math.max(0, (target.shield ?? 0) - absorbed);
          target.hp = Math.max(0, target.hp - (incomingDamage - absorbed));
          target.invulnerableFor = PLAYER_BASE.invulnerability;
        }
        enemy.x -= direction.x * 20;
        enemy.y -= direction.y * 20;
      }
    }
  }

  enemyMoveDirection(enemy, target, dt) {
    const direction = normalize(target.x - enemy.x, target.y - enemy.y);
    if (enemy.eliteAffix !== "swift") return direction;

    enemy.strafePhase = (enemy.strafePhase ?? 0) + dt * 5.2;
    const numericId = Number.parseInt(enemy.id.replace(/\D/g, ""), 10) || 0;
    const weave = Math.sin(enemy.strafePhase + numericId * 0.37) * 0.42;
    return normalize(direction.x - direction.y * weave, direction.y + direction.x * weave);
  }

  updateProjectiles(dt) {
    for (const projectile of [...this.projectiles.values()]) {
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
          this.chainProjectileDamage(projectile, enemy);
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
    for (const pickup of [...this.pickups.values()]) {
      for (const player of this.players.values()) {
        const magnetRadius = this.pickupMagnetRadius(player);
        const distSq = distanceSq(player.x, player.y, pickup.x, pickup.y);
        if (distSq < magnetRadius * magnetRadius) {
          const direction = normalize(player.x - pickup.x, player.y - pickup.y);
          const pull = 280 + (1 - Math.sqrt(distSq) / magnetRadius) * 520;
          pickup.x += direction.x * pull * dt;
          pickup.y += direction.y * pull * dt;
        }

        const collectDistance = player.radius + player.stats.pickupRadius * 0.55 + pickup.radius;
        if (distanceSq(player.x, player.y, pickup.x, pickup.y) <= collectDistance * collectDistance) {
          this.pickups.delete(pickup.id);
          this.collectPickup(player, pickup);
          break;
        }
      }
    }
  }

  updateEffects(dt) {
    for (const effect of [...this.effects.values()]) {
      effect.ttl -= dt;
      if (effect.ttl <= 0) this.effects.delete(effect.id);
    }
  }

  damageEnemy(enemy, damage, source = null) {
    const sourceDirection = source ? normalize(source.vx ?? enemy.x - source.x, source.vy ?? enemy.y - source.y) : { x: 0, y: 0 };
    const hitX = source?.x ?? enemy.x;
    const hitY = source?.y ?? enemy.y;
    enemy.hp -= Math.max(1, damage - (enemy.armor ?? 0));
    enemy.hitFlash = Math.max(enemy.hitFlash ?? 0, 0.12);
    enemy.hitVx = (enemy.hitVx ?? 0) + sourceDirection.x * 90;
    enemy.hitVy = (enemy.hitVy ?? 0) + sourceDirection.y * 90;
    this.spawnHitEffect(hitX, hitY, sourceDirection, damage, enemy.hp <= 0);
    if (enemy.hp > 0 || !this.enemies.has(enemy.id)) return;
    this.enemies.delete(enemy.id);
    const owner = [...this.players.values()].find((player) => source?.ownerId === player.id) ?? [...this.players.values()][0];
    if (owner) owner.kills += 1;
    this.spawnSplitChildren(enemy);
    const pickup = this.createEnemyDrop(enemy, owner);
    this.pickups.set(pickup.id, pickup);
  }

  createEnemyDrop(enemy, owner = null) {
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
    if (pickup.type === "repair") {
      player.hp = Math.min(player.stats.maxHp, player.hp + pickup.value);
    } else if (pickup.type === "shield") {
      player.shield = Math.min(60, (player.shield ?? 0) + pickup.value);
    } else if (pickup.type === "scrap") {
      player.scrap = (player.scrap ?? 0) + pickup.value;
    } else if (pickup.type === "overdrive") {
      player.overdriveFor = Math.max(player.overdriveFor ?? 0, pickup.value);
      this.spawnCollectionEffect(player, "overdrive");
    } else if (pickup.type === "magnet") {
      player.magnetBurstFor = Math.max(player.magnetBurstFor ?? 0, pickup.value);
      this.spawnCollectionEffect(player, "magnetBurst");
    } else if (pickup.type === "cache") {
      player.scrap = (player.scrap ?? 0) + pickup.value;
      this.gainXp(player, Math.max(1, Math.round(pickup.value / 3)));
      this.spawnCollectionEffect(player, "cacheOpened");
    } else {
      this.gainXp(player, pickup.value);
    }
  }

  playerSpeed(player) {
    return player.stats.speed * ((player.overdriveFor ?? 0) > 0 ? 1.28 : 1);
  }

  playerFireRate(player) {
    return player.stats.fireRate * ((player.overdriveFor ?? 0) > 0 ? 1.7 : 1);
  }

  pickupMagnetRadius(player) {
    return player.stats.pickupRadius + GAME.xpMagnetRadius + ((player.magnetBurstFor ?? 0) > 0 ? 420 : 0);
  }

  spawnCollectionEffect(player, type) {
    const effectId = this.entityId();
    this.effects.set(effectId, createEffect(effectId, type, player.x, player.y, type === "cacheOpened" ? 120 : 180, 0.42));
  }

  chainProjectileDamage(projectile, firstEnemy) {
    if (!projectile.chainArcs || !projectile.chainRange || projectile.chainDamageMultiplier <= 0) return;
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
  }

  nearestChainTarget(sourceEnemy, excludedIds, range) {
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
      this.enemies.set(child.id, child);
    }
  }

  spawnHitEffect(x, y, direction, damage, destroyed) {
    const effectId = this.entityId();
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
    this.effects.set(effectId, createEffect(effectId, "gravityWell", player.x, player.y, 240, 0.46));
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
    const players = [...this.players.values()];
    for (const enemy of [...this.enemies.values()]) {
      const closeToAPlayer = players.some((player) => distanceSq(player.x, player.y, enemy.x, enemy.y) < 1800 ** 2);
      if (!closeToAPlayer) this.enemies.delete(enemy.id);
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
    const anyAlive = [...this.players.values()].some((player) => player.hp > 0);
    if (!anyAlive) this.state = "gameover";
  }

  entityId() {
    this.nextEntityId += 1;
    return `e${this.nextEntityId}`;
  }
}
