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
    this._targetingCache = buildTargetingCache(this.targeting.primaryWeapon);
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
    this._targetingCache = buildTargetingCache(this.targeting.primaryWeapon);
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
      const speed = this.playerSpeed(player);
      player.vx = moveNx * speed;
      player.vy = moveNy * speed;
      const newX = player.x + player.vx * dt;
      const newY = player.y + player.vy * dt;
      player.x = newX < -worldRadius ? -worldRadius : newX > worldRadius ? worldRadius : newX;
      player.y = newY < -worldRadius ? -worldRadius : newY > worldRadius ? worldRadius : newY;
      player.invulnerableFor = Math.max(0, player.invulnerableFor - dt);
      player.cooldown -= dt;
      if (player.stats.regen > 0 && player.hp < player.stats.maxHp * 0.7) {
        player.hp = Math.min(player.stats.maxHp, player.hp + player.stats.regen * dt);
      }

      const target = this._selectPrimaryTargetFast(player);
      let aimDx;
      let aimDy;
      if (target) {
        const dx = target.x - player.x;
        const dy = target.y - player.y;
        const len = Math.hypot(dx, dy);
        if (len) {
          aimDx = dx / len;
          aimDy = dy / len;
        } else {
          aimDx = 0;
          aimDy = 0;
        }
      } else {
        aimDx = 1;
        aimDy = 0;
      }
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

      if (player.cooldown <= 0 && target) {
        const dot = player.facingX * aimDx + player.facingY * aimDy;
        if (dot >= this._targetingCache.angleThreshold) {
          this.fireVolley(player, { x: aimDx, y: aimDy });
          player.cooldown = 0.42 / this.playerFireRate(player);
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
    return Boolean(this.primaryWeaponAim(player));
  }

  primaryWeaponAim(player) {
    const target = this.primaryTargetFor(player);
    if (!target) return null;
    const targetDirection = normalize(target.x - player.x, target.y - player.y);
    const facing = normalize(player.facingX, player.facingY);
    const dot = facing.x * targetDirection.x + facing.y * targetDirection.y;
    const threshold = Math.cos((this.targeting.primaryWeapon.firingAngleDegrees * Math.PI) / 180);
    return dot >= threshold ? { target, direction: targetDirection } : null;
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
      const stalkerChance = this.wave >= 2 ? Math.min(0.05 + this.wave * 0.006, 0.13) : 0;
      const spitterChance = this.wave >= 4 ? Math.min(0.035 + this.wave * 0.005, 0.1) : 0;
      const bulwarkChance = this.wave >= 5 ? Math.min(0.025 + this.wave * 0.004, 0.08) : 0;
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
                : typeRoll < splitterChance + stalkerChance + spitterChance + bulwarkChance + bruiserChance
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
      this.enemies.set(enemy.id, enemy);
    }
    this.spawnTimer = Math.max(0.36, 1.7 - this.wave * 0.08);
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
      const tdx = target.x - enemy.x;
      const tdy = target.y - enemy.y;
      const tlen = Math.hypot(tdx, tdy);
      let dirX = tlen ? tdx / tlen : 0;
      let dirY = tlen ? tdy / tlen : 0;
      if (enemy._hastedFlag === undefined) {
        enemy._hastedFlag =
          (enemy.affixes && enemy.affixes.indexOf("hasted") >= 0) || enemy.eliteAffix === "swift";
        enemy._numericId = Number.parseInt(String(enemy.id).replace(/\D/g, ""), 10) || 0;
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
      const moveScale = enemy.speed * dt;
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
          const incomingDamage = Math.max(1, enemy.damage - target.stats.armor);
          const shield = target.shield ?? 0;
          const absorbed = shield < incomingDamage ? shield : incomingDamage;
          target.shield = shield - absorbed;
          const remaining = target.hp - (incomingDamage - absorbed);
          target.hp = remaining > 0 ? remaining : 0;
          target.invulnerableFor = PLAYER_BASE.invulnerability;
        }
        enemy.x -= dirX * 20;
        enemy.y -= dirY * 20;
      }
    }
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
      this.collectPickup(player, pickup);
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
    if (owner) owner.kills += 1;
    this.triggerEnemyDeathAffixes(enemy, owner);
    this.spawnSplitChildren(enemy);
    const pickup = this.createEnemyDrop(enemy, owner);
    this.pickups.set(pickup.id, pickup);
  }

  triggerEnemyDeathAffixes(enemy, owner = null) {
    if (!enemy.affixes?.includes("volatile") || !enemy.volatileRadius || !enemy.volatileDamage) return;
    const effectId = this.entityId();
    this.effects.set(effectId, createEffect(effectId, "volatileBurst", enemy.x, enemy.y, enemy.volatileRadius, 0.36));
    for (const player of this.players.values()) {
      if (player.hp <= 0 || distanceSq(enemy.x, enemy.y, player.x, player.y) > enemy.volatileRadius ** 2) continue;
      const incomingDamage = Math.max(1, enemy.volatileDamage - player.stats.armor);
      const absorbed = Math.min(player.shield ?? 0, incomingDamage);
      player.shield = Math.max(0, (player.shield ?? 0) - absorbed);
      player.hp = Math.max(0, player.hp - (incomingDamage - absorbed));
      player.invulnerableFor = Math.max(player.invulnerableFor, PLAYER_BASE.invulnerability * 0.5);
    }
    if (owner) owner.scrap += 1;
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
    if (!anyAlive) this.state = "gameover";
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

function buildTargetingCache(weapon) {
  const fastPath = weapon.strategy === "nearest";
  const allowedTypes =
    Array.isArray(weapon.enemyTypes) && weapon.enemyTypes.length ? new Set(weapon.enemyTypes) : null;
  const maxRangeSq = weapon.maxRange > 0 ? weapon.maxRange * weapon.maxRange : Infinity;
  const angleThreshold = Math.cos((weapon.firingAngleDegrees * Math.PI) / 180);
  return { fastPath, allowedTypes, maxRangeSq, angleThreshold };
}
