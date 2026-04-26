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
    shield: 0,
    xp: 0,
    scrap: 0,
    level: 1,
    nextLevelXp: 10,
    invulnerableFor: 0,
    overdriveFor: 0,
    magnetBurstFor: 0,
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
      projectilePierce: 0,
      projectileColor: "#8ff3ff",
      projectileGlowColor: "rgba(100, 225, 255, 0.42)",
      chainArcs: 0,
      chainRange: 170,
      chainDamageMultiplier: 0.45,
      ricochetBounces: 0,
      ricochetRange: 220,
      ricochetDamageMultiplier: 0.72,
      splashRadius: 0,
      splashDamageMultiplier: 0,
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
      killCooldownRefund: 0,
      velocityDamageBonus: 0,
      emergencyShield: 0,
      ramDamage: 0,
    },
  };
}

export function createEnemy(id, type, x, y, wave, options = {}) {
  const stats = enemyStats(type, wave);
  const affixes = normalizeAffixes(options);
  const enemy = {
    id,
    kind: "enemy",
    type,
    x,
    y,
    radius: stats.radius,
    hp: stats.hp,
    maxHp: stats.hp,
    speed: stats.speed,
    damage: stats.damage,
    xp: stats.xp,
    splitCount: stats.splitCount,
    splitChildType: stats.splitChildType,
    splitDepth: options.splitDepth ?? 0,
    affixes: [],
    rarity: affixes.length > 1 ? "rare" : affixes.length === 1 ? "elite" : "normal",
    armor: 0,
    regenPerSecond: 0,
    volatileDamage: 0,
    volatileRadius: 0,
    hitFlash: 0,
    hitVx: 0,
    hitVy: 0,
  };

  for (const affix of affixes) applyEnemyAffix(enemy, affix);
  enemy.eliteAffix = enemy.affixes[0] ?? null;

  return enemy;
}

function enemyStats(type, wave) {
  if (type === "charger") {
    const hp = 38 + wave * 5;
    return { radius: 16, hp, speed: 82 + wave * 2, damage: 13, xp: 4, splitCount: 0, splitChildType: null };
  }
  if (type === "siphon") {
    const hp = 42 + wave * 5;
    return { radius: 18, hp, speed: 64 + wave * 2, damage: 8, xp: 5, splitCount: 0, splitChildType: null };
  }
  if (type === "warden") {
    const hp = 64 + wave * 8;
    return { radius: 21, hp, speed: 58 + wave * 2, damage: 10, xp: 6, splitCount: 0, splitChildType: null };
  }
  if (type === "stalker") {
    const hp = 18 + wave * 3;
    return { radius: 13, hp, speed: 138 + wave * 4, damage: 9, xp: 3, splitCount: 0, splitChildType: null };
  }
  if (type === "bulwark") {
    const hp = 82 + wave * 10;
    return { radius: 25, hp, speed: 52 + wave * 2, damage: 18, xp: 7, splitCount: 0, splitChildType: null };
  }
  if (type === "spitter") {
    const hp = 28 + wave * 4;
    return { radius: 16, hp, speed: 76 + wave * 2, damage: 11, xp: 4, splitCount: 0, splitChildType: null };
  }
  if (type === "bruiser") {
    const hp = 56 + wave * 8;
    return { radius: 22, hp, speed: 68 + wave * 3, damage: 14, xp: 5, splitCount: 0, splitChildType: null };
  }
  if (type === "splitter") {
    const hp = 34 + wave * 5;
    return { radius: 17, hp, speed: 86 + wave * 3, damage: 8, xp: 3, splitCount: 3, splitChildType: "shard" };
  }
  if (type === "shard") {
    const hp = 10 + wave * 2;
    return { radius: 10, hp, speed: 132 + wave * 4, damage: 5, xp: 1, splitCount: 0, splitChildType: null };
  }

  const hp = 24 + wave * 3;
  return { radius: 15, hp, speed: 96 + wave * 3, damage: 7, xp: 2, splitCount: 0, splitChildType: null };
}

function normalizeAffixes(options) {
  const affixes = Array.isArray(options.affixes) ? options.affixes : options.eliteAffix ? [options.eliteAffix] : [];
  return [...new Set(affixes.filter(Boolean).map((affix) => (affix === "swift" ? "hasted" : affix)))];
}

function applyEnemyAffix(enemy, affix) {
  enemy.affixes.push(affix);
  enemy.radius += 3;
  enemy.xp += 3;

  if (affix === "hasted") {
    enemy.speed *= 1.36;
    enemy.damage += 3;
    enemy.strafePhase = 0;
    return;
  }

  if (affix === "armored") {
    enemy.maxHp = Math.round(enemy.maxHp * 1.65);
    enemy.hp = enemy.maxHp;
    enemy.armor += 6;
    enemy.speed *= 0.88;
    return;
  }

  if (affix === "regenerating") {
    enemy.maxHp = Math.round(enemy.maxHp * 1.28);
    enemy.hp = enemy.maxHp;
    enemy.regenPerSecond += 3.5;
    return;
  }

  if (affix === "volatile") {
    enemy.damage += 4;
    enemy.volatileDamage += 14;
    enemy.volatileRadius = Math.max(enemy.volatileRadius, 112);
  }
}

export function createProjectile(id, ownerId, x, y, vx, vy, damage, radius = 5, ttl = 1.4, weapon = {}) {
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
    pierce: weapon.pierce ?? 0,
    color: weapon.color ?? "#8ff3ff",
    glowColor: weapon.glowColor ?? "rgba(100, 225, 255, 0.42)",
    chainArcs: weapon.chainArcs ?? 0,
    chainRange: weapon.chainRange ?? 0,
    chainDamageMultiplier: weapon.chainDamageMultiplier ?? 0,
    ricochetBounces: weapon.ricochetBounces ?? 0,
    ricochetRange: weapon.ricochetRange ?? 0,
    ricochetDamageMultiplier: weapon.ricochetDamageMultiplier ?? 0,
    splashRadius: weapon.splashRadius ?? 0,
    splashDamageMultiplier: weapon.splashDamageMultiplier ?? 0,
    hitEnemyIds: [],
  };
}

export function createPickup(id, x, y, value, type = "xp") {
  const radiusByType = {
    xp: 8,
    scrap: 9,
    repair: 12,
    shield: 12,
    overdrive: 11,
    magnet: 11,
    cache: 15,
  };

  return {
    id,
    kind: "pickup",
    type,
    x,
    y,
    radius: radiusByType[type] ?? 8,
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
