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
    aimX: 1,
    aimY: 0,
    radius: PLAYER_BASE.radius,
    hp: PLAYER_BASE.maxHp,
    shield: 0,
    xp: 0,
    scrap: 0,
    level: 1,
    nextLevelXp: 10,
    invulnerableFor: 0,
    shieldRechargeCooldown: 0,
    crisisRepairRemaining: 0,
    crisisRepairUsed: false,
    overdriveFor: 0,
    magnetBurstFor: 0,
    pickupSpeedBurstFor: 0,
    xpPickupsCollected: 0,
    cooldown: 0,
    plagueLanceCooldown: 0,
    pyreBrandCooldown: 0,
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
      projectileAcceleration: 0,
      projectileMaxSpeedMultiplier: 1,
      projectileColor: "#8ff3ff",
      projectileGlowColor: "rgba(100, 225, 255, 0.42)",
      chainArcs: 0,
      chainRange: 170,
      chainDamageMultiplier: 0.45,
      chainForks: 0,
      ricochetBounces: 0,
      ricochetRange: 220,
      ricochetDamageMultiplier: 0.72,
      splashRadius: 0,
      splashDamageMultiplier: 0,
      splashCenterBonusPerTarget: 0,
      pickupRadius: PLAYER_BASE.pickupRadius,
      drones: 0,
      droneArcDamagePerDrone: 0,
      droneArcRange: 190,
      gravityWell: 0,
      armor: 0,
      regen: 0,
      maxShield: 60,
      shieldPickupMultiplier: 1,
      shieldRechargeRate: 0,
      shieldRechargeCap: 0,
      shieldRechargeDelay: 3,
      shieldArmorConversion: 0,
      contactKnockback: 0,
      invulnerabilityBonus: 0,
      hullDamageReflection: 0,
      crisisRepair: 0,
      crisisRepairDuration: 4,
      crisisRepairThreshold: 0.3,
      xpGain: 1,
      scrapValueMultiplier: 1,
      critChance: 0.04,
      critDamage: 1.75,
      critExecuteThreshold: 0,
      area: 1,
      salvageBonus: 0,
      repairDropBonus: 0,
      cacheValueBonus: 0,
      magnetBurstRadiusBonus: 0,
      magnetPickupDurationBonus: 0,
      pickupSpeedBurstDuration: 0,
      pickupSpeedBurstMultiplier: 1,
      repairOverflowScrap: 0,
      shieldOverflowScrap: 0,
      scrapGrantsXp: 0,
      xpPickupScrapEvery: 0,
      xpPickupScrapValue: 0,
      choiceQualityBonus: 0,
      killCooldownRefund: 0,
      killVolleyProjectiles: 0,
      killVolleyDamageMultiplier: 0.42,
      killVolleyRange: 280,
      velocityDamageBonus: 0,
      burnDps: 0,
      burnDuration: 0,
      markDamageTakenMultiplier: 0,
      markDuration: 0,
      emergencyShield: 0,
      ramDamage: 0,
      plagueLanceLevel: 0,
      virulence1: 0,
      virulence2: 0,
      virulence3: 0,
      pyreBrandLevel: 0,
      conflagration1: 0,
      conflagration2: 0,
      conflagration3: 0,
    },
  };
}

export function createEnemy(id, type, x, y, wave, options = {}) {
  const stats = enemyStats(type, wave);
  const affixes = normalizeAffixes(options);
  const rank = options.rank ?? (options.bossId ? "boss" : options.eliteId ? "elite" : "normal");
  const enemy = {
    id,
    kind: "enemy",
    type,
    rank,
    bossId: options.bossId ?? null,
    eliteId: options.eliteId ?? null,
    phase: options.phase ?? 1,
    phaseTimer: 0,
    phaseCooldown: 0,
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
    rarity: rank === "boss" ? "boss" : rank === "elite" ? "elite" : affixes.length > 1 ? "rare" : affixes.length === 1 ? "elite" : "normal",
    armor: 0,
    regenPerSecond: 0,
    volatileDamage: 0,
    volatileRadius: 0,
    hitFlash: 0,
    hitVx: 0,
    hitVy: 0,
    ailments: {},
  };

  for (const affix of affixes) applyEnemyAffix(enemy, affix);
  enemy.eliteAffix = enemy.affixes[0] ?? null;
  applyRankTuning(enemy, options);

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

function applyRankTuning(enemy, options) {
  if (options.radiusBonus) enemy.radius += options.radiusBonus;
  if (options.hpMultiplier) {
    enemy.maxHp = Math.round(enemy.maxHp * options.hpMultiplier);
    enemy.hp = enemy.maxHp;
  }
  if (options.speedMultiplier) enemy.speed *= options.speedMultiplier;
  if (options.damageBonus) enemy.damage += options.damageBonus;
  if (options.xpBonus) enemy.xp += options.xpBonus;
  if (options.armorBonus) enemy.armor += options.armorBonus;
  if (options.regenBonus) enemy.regenPerSecond += options.regenBonus;
  if (options.splitCount !== undefined) enemy.splitCount = options.splitCount;
  if (options.splitChildType !== undefined) enemy.splitChildType = options.splitChildType;
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
    initialSpeed: Math.sqrt(vx * vx + vy * vy),
    acceleration: weapon.acceleration ?? 0,
    maxSpeedMultiplier: weapon.maxSpeedMultiplier ?? 1,
    isCritical: Boolean(weapon.isCritical),
    executeThreshold: weapon.executeThreshold ?? 0,
    damageType: weapon.damageType ?? "physical",
    damageBreakdown: weapon.damageBreakdown ?? null,
    burnDps: weapon.burnDps ?? 0,
    burnDuration: weapon.burnDuration ?? 0,
    markDamageTakenMultiplier: weapon.markDamageTakenMultiplier ?? 0,
    markDuration: weapon.markDuration ?? 0,
    pierce: weapon.pierce ?? 0,
    color: weapon.color ?? "#8ff3ff",
    glowColor: weapon.glowColor ?? "rgba(100, 225, 255, 0.42)",
    chainArcs: weapon.chainArcs ?? 0,
    chainRange: weapon.chainRange ?? 0,
    chainDamageMultiplier: weapon.chainDamageMultiplier ?? 0,
    chainForks: weapon.chainForks ?? 0,
    ricochetBounces: weapon.ricochetBounces ?? 0,
    ricochetRange: weapon.ricochetRange ?? 0,
    ricochetDamageMultiplier: weapon.ricochetDamageMultiplier ?? 0,
    splashRadius: weapon.splashRadius ?? 0,
    splashDamageMultiplier: weapon.splashDamageMultiplier ?? 0,
    splashCenterBonusPerTarget: weapon.splashCenterBonusPerTarget ?? 0,
    droneArcDamagePerDrone: weapon.droneArcDamagePerDrone ?? 0,
    droneArcRange: weapon.droneArcRange ?? 0,
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
