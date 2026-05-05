import { TARGETING } from "./config.js";
import { distanceSq } from "./math.js";

export const TARGET_STRATEGIES = Object.freeze({
  nearest: "nearest",
  lowestHp: "lowestHp",
  highestHp: "highestHp",
  highestThreat: "highestThreat",
  random: "random",
});

export function createTargetingConfig(overrides = {}) {
  return {
    primaryWeapon: normalizeWeaponTargeting({
      ...TARGETING.primaryWeapon,
      ...(overrides.primaryWeapon ?? overrides),
    }),
  };
}

export function mergeTargetingConfig(current, overrides = {}) {
  return createTargetingConfig({
    primaryWeapon: {
      ...current.primaryWeapon,
      ...(overrides.primaryWeapon ?? overrides),
    },
  });
}

export function selectTarget(actor, enemies, weaponTargeting, rng) {
  const targeting = normalizeWeaponTargeting(weaponTargeting);
  const enemyTypes = targeting.enemyTypes;
  const hasTypeFilter = enemyTypes.length > 0;
  const maxRangeSq = targeting.maxRange > 0 ? targeting.maxRange * targeting.maxRange : Infinity;
  const ax = actor.x;
  const ay = actor.y;
  const strategy = targeting.strategy;

  // Fast path for nearest (most common): single pass, no allocations.
  if (strategy === TARGET_STRATEGIES.nearest) {
    let best = null;
    let bestDist = Infinity;
    for (let i = 0; i < enemies.length; i += 1) {
      const enemy = enemies[i];
      if (enemy.hp <= 0) continue;
      if (hasTypeFilter && enemyTypes.indexOf(enemy.type) < 0) continue;
      const dx = enemy.x - ax;
      const dy = enemy.y - ay;
      const d = dx * dx + dy * dy;
      if (d > maxRangeSq) continue;
      if (d < bestDist) {
        bestDist = d;
        best = enemy;
      }
    }
    return best;
  }

  if (strategy === TARGET_STRATEGIES.random) {
    const candidates = [];
    for (let i = 0; i < enemies.length; i += 1) {
      const enemy = enemies[i];
      if (enemy.hp <= 0) continue;
      if (hasTypeFilter && enemyTypes.indexOf(enemy.type) < 0) continue;
      const dx = enemy.x - ax;
      const dy = enemy.y - ay;
      if (dx * dx + dy * dy > maxRangeSq) continue;
      candidates.push(enemy);
    }
    if (!candidates.length) return null;
    return rng.pick(candidates);
  }

  let best = null;
  let bestScore = Infinity;
  for (let i = 0; i < enemies.length; i += 1) {
    const enemy = enemies[i];
    if (enemy.hp <= 0) continue;
    if (hasTypeFilter && enemyTypes.indexOf(enemy.type) < 0) continue;
    const dx = enemy.x - ax;
    const dy = enemy.y - ay;
    if (dx * dx + dy * dy > maxRangeSq) continue;
    const score = scoreTarget(actor, enemy, strategy);
    if (best === null || score < bestScore) {
      best = enemy;
      bestScore = score;
    }
  }
  return best;
}

function normalizeWeaponTargeting(targeting) {
  const strategy = Object.values(TARGET_STRATEGIES).includes(targeting.strategy)
    ? targeting.strategy
    : TARGET_STRATEGIES.nearest;
  return {
    strategy,
    enemyTypes: Array.isArray(targeting.enemyTypes) ? [...targeting.enemyTypes] : [],
    maxRange: Number.isFinite(targeting.maxRange) ? Math.max(0, targeting.maxRange) : 0,
    firingAngleDegrees: Number.isFinite(targeting.firingAngleDegrees)
      ? Math.max(0, Math.min(180, targeting.firingAngleDegrees))
      : 8,
  };
}

function scoreTarget(actor, enemy, strategy) {
  if (strategy === TARGET_STRATEGIES.lowestHp) return enemy.hp;
  if (strategy === TARGET_STRATEGIES.highestHp) return -enemy.hp;
  if (strategy === TARGET_STRATEGIES.highestThreat) return -(enemy.damage * 1000 + enemy.speed);
  return distanceSq(actor.x, actor.y, enemy.x, enemy.y);
}
