import { PLAYER_BASE } from "./config.js";

export function createPlayer(id, x = 0, y = 0) {
  return {
    id,
    kind: "player",
    x,
    y,
    vx: 0,
    vy: 0,
    facingX: 1,
    facingY: 0,
    radius: PLAYER_BASE.radius,
    hp: PLAYER_BASE.maxHp,
    xp: 0,
    level: 1,
    nextLevelXp: 10,
    invulnerableFor: 0,
    cooldown: 0,
    shotCount: 0,
    ownedUpgrades: new Set(),
    upgradeStacks: new Map(),
    kills: 0,
    stats: {
      speed: PLAYER_BASE.speed,
      maxHp: PLAYER_BASE.maxHp,
      damage: 24,
      fireRate: 1,
      projectileSpeed: 620,
      projectileRadius: 5,
      projectileTtl: 1.4,
      projectiles: 1,
      pickupRadius: PLAYER_BASE.pickupRadius,
      drones: 0,
      gravityWell: 0,
      armor: 0,
      regen: 0,
      xpGain: 1,
      critChance: 0.04,
      critDamage: 1.75,
      area: 1,
      salvageBonus: 0,
      repairDropBonus: 0,
    },
  };
}

export function createEnemy(id, type, x, y, wave) {
  const isBruiser = type === "bruiser";
  return {
    id,
    kind: "enemy",
    type,
    x,
    y,
    radius: isBruiser ? 22 : 15,
    hp: (isBruiser ? 56 : 24) + wave * (isBruiser ? 8 : 3),
    maxHp: (isBruiser ? 56 : 24) + wave * (isBruiser ? 8 : 3),
    speed: (isBruiser ? 68 : 96) + wave * 3,
    damage: isBruiser ? 14 : 7,
    xp: isBruiser ? 5 : 2,
    hitFlash: 0,
    hitVx: 0,
    hitVy: 0,
  };
}

export function createProjectile(id, ownerId, x, y, vx, vy, damage, radius = 5, ttl = 1.4) {
  return {
    id,
    kind: "projectile",
    ownerId,
    x,
    y,
    vx,
    vy,
    radius,
    damage,
    ttl,
  };
}

export function createPickup(id, x, y, value, type = "xp") {
  return {
    id,
    kind: "pickup",
    type,
    x,
    y,
    radius: type === "repair" ? 12 : 8,
    value,
  };
}

export function createEffect(id, type, x, y, radius, ttl) {
  return {
    id,
    kind: "effect",
    type,
    x,
    y,
    radius,
    ttl,
    duration: ttl,
  };
}
