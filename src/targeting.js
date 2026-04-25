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
  const allowedTypes = new Set(targeting.enemyTypes);
  const maxRangeSq = targeting.maxRange > 0 ? targeting.maxRange ** 2 : Infinity;
  const candidates = enemies.filter((enemy) => {
    if (enemy.hp <= 0) return false;
    if (allowedTypes.size && !allowedTypes.has(enemy.type)) return false;
    return distanceSq(actor.x, actor.y, enemy.x, enemy.y) <= maxRangeSq;
  });

  if (!candidates.length) return null;
  if (targeting.strategy === TARGET_STRATEGIES.random) {
    return rng.pick(candidates);
  }

  return candidates.reduce((best, enemy) => {
    if (!best) return enemy;
    return scoreTarget(actor, enemy, targeting.strategy) < scoreTarget(actor, best, targeting.strategy)
      ? enemy
      : best;
  }, null);
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
