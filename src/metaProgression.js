export const META_STORAGE_KEY = "space-survivors-meta";

// --- Effect curve helpers ---------------------------------------------------
// Asymptotic curve: cap * (1 - e^(-level * k)). Approaches `cap` as level→∞.
// Logarithmic curve: scale * ln(1 + level). Slow but unbounded growth — used
// for upgrades like scrap-charter that compound across runs.
export function asymptoticEffect(level, cap, k) {
  return cap * (1 - Math.exp(-level * k));
}

export function logEffect(level, scale) {
  return scale * Math.log(1 + level);
}

// Per-upgrade k values were chosen by solving
//   cap * (1 - exp(-softCap * k)) = current_maxed_effect
// so the new curve matches the previous linear formula at the soft cap.
//
//   reinforced-hull  cap=80   softCap=5  target= 40       → k=ln(2)/5     ≈0.13863
//   reactor-tuning   cap=0.40 softCap=5  target= 0.27563  → k=ln(1/0.31094)/5 ≈0.23368
//   combat-drills    cap=0.60 softCap=5  target= 0.27628  → k=ln(1/0.53953)/5 ≈0.12344
//   nav-school       cap=0.25 softCap=4  target= 0.16986  → k=ln(1/0.32058)/4 ≈0.28443
//   field-medicine   cap=0.30 softCap=4  target= 0.10     → k=ln(1.5)/4   ≈0.10137
//   scrap-charter    logarithmic, scale=0.10 (≈0.179 at rank 5; slight
//                    nerf vs old +0.25 — triggers migration refund).

export const PERMANENT_UPGRADES = [
  permanent({
    id: "reinforced-hull",
    name: "Reinforced Hull",
    description: "Start each run with more max hull.",
    softCap: 5,
    baseCost: 85,
    icon: "reinforced-hull",
    effectCap: 80,
    effectK: 0.13863,
    effectUnit: "hp",
    apply: (level, player) => {
      const bonus = asymptoticEffect(level, 80, 0.13863);
      player.stats.maxHp += bonus;
      player.hp = player.stats.maxHp;
    },
  }),
  permanent({
    id: "reactor-tuning",
    name: "Reactor Tuning",
    description: "Small permanent fire-rate increase.",
    softCap: 5,
    baseCost: 110,
    icon: "reactor-tuning",
    effectCap: 0.40,
    effectK: 0.23368,
    effectUnit: "%fireRate",
    apply: (level, player) => {
      player.stats.fireRate *= 1 + asymptoticEffect(level, 0.40, 0.23368);
    },
  }),
  permanent({
    id: "combat-drills",
    name: "Combat Drills",
    description: "Small permanent damage increase.",
    softCap: 5,
    baseCost: 100,
    icon: "combat-drills",
    effectCap: 0.60,
    effectK: 0.12344,
    effectUnit: "%damage",
    apply: (level, player) => {
      player.stats.damage *= 1 + asymptoticEffect(level, 0.60, 0.12344);
    },
  }),
  permanent({
    id: "nav-school",
    name: "Nav School",
    description: "Start runs with better thruster calibration.",
    softCap: 4,
    baseCost: 95,
    icon: "nav-school",
    effectCap: 0.25,
    effectK: 0.28443,
    effectUnit: "%speed",
    apply: (level, player) => {
      player.stats.speed *= 1 + asymptoticEffect(level, 0.25, 0.28443);
    },
  }),
  permanent({
    id: "scrap-charter",
    name: "Scrap Charter",
    description: "Earn more permanent scrap from runs.",
    softCap: 5,
    baseCost: 180,
    costExponent: 1.45,
    icon: "scrap-charter",
    logScale: 0.10,
    effectUnit: "%salvage",
    apply: (level, player) => {
      player.stats.salvageBonus += logEffect(level, 0.10);
    },
  }),
  permanent({
    id: "field-medicine",
    name: "Field Medicine",
    description: "Repair drops restore more hull.",
    softCap: 4,
    baseCost: 100,
    icon: "field-medicine",
    effectCap: 0.30,
    effectK: 0.10137,
    effectUnit: "%repair",
    apply: (level, player) => {
      player.stats.repairDropBonus += asymptoticEffect(level, 0.30, 0.10137);
    },
  }),
];

export const EQUIPMENT_SLOTS = {
  weapon: "Weapon",
  hull: "Hull",
  utility: "Utility",
};

export const EQUIPMENT = {
  weapon: [
    equipment("pulse-laser", "Pulse Laser", "Balanced automatic plasma fire.", "weapon", "pulse-laser", ["Baseline damage and cadence"], (player) => {
      player.stats.damage *= 1;
    }),
    equipment("rail-cannon", "Rail Cannon", "Harder hits, slower cadence.", "weapon", "rail-cannon", ["+35% damage", "-24% fire rate", "+18% projectile speed"], (player) => {
      player.stats.damage *= 1.35;
      player.stats.fireRate *= 0.76;
      player.stats.projectileSpeed *= 1.18;
    }),
    equipment("scatter-core", "Scatter Core", "Extra projectile, weaker shots.", "weapon", "scatter-core", ["+1 projectile", "-22% damage", "-10% fire rate"], (player) => {
      player.stats.projectiles += 1;
      player.stats.damage *= 0.78;
      player.stats.fireRate *= 0.9;
    }),
    equipment("coil-repeater", "Coil Repeater", "Rapid cycling coils with lighter impact.", "weapon", "coil-repeater", ["+28% fire rate", "-12% damage", "-8% projectile speed"], (player) => {
      player.stats.fireRate *= 1.28;
      player.stats.damage *= 0.88;
      player.stats.projectileSpeed *= 0.92;
    }),
    equipment("ion-lance", "Ion Lance", "Precision beam tuned for critical strikes.", "weapon", "ion-lance", ["+10% crit chance", "+35% crit damage", "-12% fire rate"], (player) => {
      player.stats.critChance += 0.1;
      player.stats.critDamage += 0.35;
      player.stats.fireRate *= 0.88;
    }),
    equipment("flak-array", "Flak Array", "Wide blast pattern for close-range swarms.", "weapon", "flak-array", ["+1 projectile", "+18% area", "-16% damage", "-12% projectile speed"], (player) => {
      player.stats.projectiles += 1;
      player.stats.area *= 1.18;
      player.stats.damage *= 0.84;
      player.stats.projectileSpeed *= 0.88;
    }),
    equipment("prism-carbine", "Prism Carbine", "Refraction rounds bend into nearby follow-up targets.", "weapon", "prism-carbine", ["+2 ricochets", "Ricochets deal 72% damage", "-8% damage", "-6% fire rate"], (player) => {
      player.stats.ricochetBounces += 2;
      player.stats.ricochetRange = Math.max(player.stats.ricochetRange, 260);
      player.stats.ricochetDamageMultiplier = Math.max(player.stats.ricochetDamageMultiplier, 0.72);
      player.stats.damage *= 0.92;
      player.stats.fireRate *= 0.94;
      player.stats.projectileColor = "#a78bfa";
      player.stats.projectileGlowColor = "rgba(167, 139, 250, 0.46)";
    }, { unlockRequirement: { maxedPermanents: 1 } }),
    equipment("nova-mortar", "Nova Mortar", "Heavy plasma shells burst on impact.", "weapon", "nova-mortar", ["96px splash radius", "Splash deals 55% damage", "+24% damage", "-30% fire rate", "-22% projectile speed"], (player) => {
      player.stats.splashRadius = Math.max(player.stats.splashRadius, 96);
      player.stats.splashDamageMultiplier = Math.max(player.stats.splashDamageMultiplier, 0.55);
      player.stats.projectileRadius += 3;
      player.stats.damage *= 1.24;
      player.stats.fireRate *= 0.7;
      player.stats.projectileSpeed *= 0.78;
      player.stats.projectileColor = "#ffb020";
      player.stats.projectileGlowColor = "rgba(255, 176, 32, 0.46)";
    }, { unlockRequirement: { maxedPermanents: 3 } }),
  ],
  hull: [
    equipment("scout-frame", "Scout Frame", "Fast frame with lighter plating.", "hull", "scout-frame", ["+8% speed", "-10 max hull"], (player) => {
      player.stats.speed *= 1.08;
      player.stats.maxHp -= 10;
      player.hp = Math.min(player.hp, player.stats.maxHp);
    }),
    equipment("bulwark-frame", "Bulwark Frame", "Heavy frame with armor and hull.", "hull", "bulwark-frame", ["+28 max hull", "+3 armor", "-8% speed"], (player) => {
      player.stats.maxHp += 28;
      player.stats.armor += 3;
      player.stats.speed *= 0.92;
      player.hp = player.stats.maxHp;
    }),
    equipment("standard-frame", "Standard Frame", "Reliable balanced hull with light plating.", "hull", "standard-frame", ["+1 armor", "No speed penalty"], (player) => {
      player.stats.armor += 1;
    }),
    equipment("interceptor-frame", "Interceptor Frame", "Stripped pursuit frame for aggressive piloting.", "hull", "interceptor-frame", ["+14% speed", "+8% fire rate", "-22 max hull"], (player) => {
      player.stats.speed *= 1.14;
      player.stats.fireRate *= 1.08;
      player.stats.maxHp -= 22;
      player.hp = Math.min(player.hp, player.stats.maxHp);
    }),
    equipment("aegis-frame", "Aegis Frame", "Dense plating with redundant repair channels.", "hull", "aegis-frame", ["+18 max hull", "+2 armor", "+6% repair drops", "-5% speed"], (player) => {
      player.stats.maxHp += 18;
      player.stats.armor += 2;
      player.stats.repairDropBonus += 0.06;
      player.stats.speed *= 0.95;
      player.hp = player.stats.maxHp;
    }),
    equipment("reactor-frame", "Reactor Frame", "Expanded reactor bay that trades shielding for output.", "hull", "reactor-frame", ["+16% damage", "+10% fire rate", "-16 max hull", "-1 armor"], (player) => {
      player.stats.damage *= 1.16;
      player.stats.fireRate *= 1.1;
      player.stats.maxHp -= 16;
      player.stats.armor -= 1;
      player.hp = Math.min(player.hp, player.stats.maxHp);
    }),
  ],
  utility: [
    equipment("magnet-rig", "Magnet Rig", "Improved pickup range.", "utility", "magnet-rig", ["+38 pickup radius"], (player) => {
      player.stats.pickupRadius += 38;
    }),
    equipment("targeting-suite", "Targeting Suite", "Better critical chance.", "utility", "targeting-suite", ["+8% crit chance"], (player) => {
      player.stats.critChance += 0.08;
    }),
    equipment("repair-cache", "Repair Cache", "More repair drops, less XP gain.", "utility", "repair-cache", ["+8% repair drops", "-6% XP gain"], (player) => {
      player.stats.repairDropBonus += 0.08;
      player.stats.xpGain *= 0.94;
    }),
    equipment("salvage-net", "Salvage Net", "Scrap reclamation rig with a wider collection field.", "utility", "salvage-net", ["+10% salvage", "+20 pickup radius", "-4% speed"], (player) => {
      player.stats.salvageBonus += 0.1;
      player.stats.pickupRadius += 20;
      player.stats.speed *= 0.96;
    }),
    equipment("overclock-relay", "Overclock Relay", "Pushes weapon power at the cost of repairs.", "utility", "overclock-relay", ["+9% damage", "+9% fire rate", "-5% repair drops"], (player) => {
      player.stats.damage *= 1.09;
      player.stats.fireRate *= 1.09;
      player.stats.repairDropBonus -= 0.05;
    }),
    equipment("stabilizer-vanes", "Stabilizer Vanes", "Tighter flight and faster rounds with less draw range.", "utility", "stabilizer-vanes", ["+6% speed", "+10% projectile speed", "-18 pickup radius"], (player) => {
      player.stats.speed *= 1.06;
      player.stats.projectileSpeed *= 1.1;
      player.stats.pickupRadius -= 18;
    }),
  ],
};

export function defaultMetaProgress() {
  return {
    scrap: 0,
    upgrades: Object.fromEntries(PERMANENT_UPGRADES.map((upgrade) => [upgrade.id, 0])),
    equipment: {
      weapon: "pulse-laser",
      hull: "standard-frame",
      utility: "magnet-rig",
    },
    best: {
      seconds: 0,
      wave: 1,
    },
    migrationVersion: 2,
  };
}

const CURRENT_MIGRATION_VERSION = 2;

// Old linear formulas, kept for migration refund only.
const OLD_LINEAR_EFFECT = {
  "reinforced-hull": (lvl) => lvl * 8,
  "reactor-tuning": (lvl) => lvl * 0.035,
  "combat-drills": (lvl) => lvl * 0.04,
  "nav-school": (lvl) => lvl * 0.025,
  "scrap-charter": (lvl) => lvl * 0.05,
  "field-medicine": (lvl) => lvl * 0.025,
};

function newEffectMagnitude(upgrade, level) {
  if (typeof upgrade.logScale === "number") {
    return logEffect(level, upgrade.logScale);
  }
  if (typeof upgrade.effectCap === "number" && typeof upgrade.effectK === "number") {
    return asymptoticEffect(level, upgrade.effectCap, upgrade.effectK);
  }
  return 0;
}

export function normalizeMetaProgress(raw = {}) {
  const source = raw && typeof raw === "object" ? raw : {};
  const defaults = defaultMetaProgress();
  const rawEquipment = source.equipment && typeof source.equipment === "object" ? source.equipment : {};
  const normalized = {
    ...defaults,
    ...source,
    upgrades: {
      ...defaults.upgrades,
      ...(source.upgrades ?? {}),
    },
    equipment: Object.fromEntries(
      Object.entries(defaults.equipment).map(([slot, defaultId]) => {
        const selectedId = rawEquipment[slot] ?? defaultId;
        const isKnown = EQUIPMENT[slot]?.some((item) => item.id === selectedId);
        return [slot, isKnown ? selectedId : defaultId];
      }),
    ),
    best: {
      ...defaults.best,
      ...(source.best ?? {}),
    },
  };

  if (source.migrationVersion !== CURRENT_MIGRATION_VERSION) {
    let refund = 0;
    for (const upgrade of PERMANENT_UPGRADES) {
      const level = normalized.upgrades[upgrade.id] ?? 0;
      if (level <= 0) continue;
      const oldFn = OLD_LINEAR_EFFECT[upgrade.id];
      if (!oldFn) continue;
      const oldEffect = oldFn(level);
      const newEffect = newEffectMagnitude(upgrade, level);
      if (newEffect < oldEffect) {
        // Refund roughly proportional to the lost effect: scan ranks where the
        // per-rank delta has shrunk and credit the cost of those ranks.
        for (let r = 1; r <= level; r += 1) {
          const oldDelta = oldFn(r) - oldFn(r - 1);
          const newDelta = newEffectMagnitude(upgrade, r) - newEffectMagnitude(upgrade, r - 1);
          if (newDelta < oldDelta) {
            refund += upgradeCost(upgrade, r - 1);
          }
        }
      }
    }
    if (refund > 0) {
      normalized.scrap = (normalized.scrap ?? 0) + refund;
      // eslint-disable-next-line no-console
      console.log(`[meta] migration v2 refund: +${refund} scrap`);
    }
    normalized.migrationVersion = CURRENT_MIGRATION_VERSION;
  }

  return normalized;
}

export function applyMetaProgress(player, meta) {
  const normalized = normalizeMetaProgress(meta);
  for (const upgrade of PERMANENT_UPGRADES) {
    const level = normalized.upgrades[upgrade.id] ?? 0;
    if (level > 0) upgrade.apply(level, player);
  }

  for (const [slot, selectedId] of Object.entries(normalized.equipment)) {
    const item = EQUIPMENT[slot]?.find((candidate) => candidate.id === selectedId);
    item?.apply(player);
  }
  player.hp = Math.min(player.hp, player.stats.maxHp);
}

export function upgradeCost(upgrade, level) {
  const baseExp = upgrade.costExponent ?? 1.35;
  const softCap = upgrade.softCap ?? upgrade.maxLevel ?? 5;
  const over = Math.max(0, level - softCap + 1);
  const exp = baseExp + (0.35 * over) / softCap;
  return Math.round(upgrade.baseCost * Math.pow(level + 1, exp));
}

export function countMaxedPermanents(metaProgress) {
  const upgrades = metaProgress?.upgrades ?? {};
  let count = 0;
  for (const upgrade of PERMANENT_UPGRADES) {
    const level = upgrades[upgrade.id] ?? 0;
    if (level >= upgrade.softCap) count += 1;
  }
  return count;
}

export function calculateRunScrap(snapshot) {
  const player = snapshot.players.find((item) => item.id === snapshot.localPlayerId) ?? snapshot.players[0];
  const seconds = Math.floor(snapshot.elapsed);
  const kills = player?.kills ?? 0;
  const bonus = player?.stats?.salvageBonus ?? 0;
  const collectedScrap = player?.scrap ?? 0;
  const raw = seconds * 0.75 + kills * 4 + Math.max(0, snapshot.wave - 1) * 35 + collectedScrap;
  return Math.max(8, Math.floor(raw * (1 + bonus)));
}

// --- UI helpers -------------------------------------------------------------

const ROMAN = ["", "I", "II", "III", "IV", "V"];
function roman(n) {
  if (n <= 0) return "";
  if (n >= 5) return "V+";
  return ROMAN[n] ?? String(n);
}

export function prestigeTierIndex(upgrade, level) {
  const softCap = upgrade.softCap ?? upgrade.maxLevel ?? 5;
  if (level < softCap) return 0;
  return Math.floor((level - softCap) / softCap) + 1;
}

export function prestigeProgressFraction(upgrade, level) {
  const softCap = upgrade.softCap ?? upgrade.maxLevel ?? 5;
  if (level < softCap) return level / softCap;
  return ((level - softCap) % softCap) / softCap;
}

export function formatRankLabel(upgrade, level) {
  const softCap = upgrade.softCap ?? upgrade.maxLevel ?? 5;
  if (level < softCap) {
    return `Level ${level} · Tier I`;
  }
  const tier = prestigeTierIndex(upgrade, level);
  return `Level ${level} · Calibrated · Prestige ${roman(tier)}`;
}

export function nextRankCost(upgrade, level) {
  return upgradeCost(upgrade, level);
}

function formatEffectValue(upgrade, delta) {
  const unit = upgrade.effectUnit ?? "";
  switch (unit) {
    case "hp":
      return `${delta >= 0 ? "+" : ""}${delta.toFixed(1)} hp`;
    case "%damage":
      return `${delta >= 0 ? "+" : ""}${(delta * 100).toFixed(1)}% damage`;
    case "%fireRate":
      return `${delta >= 0 ? "+" : ""}${(delta * 100).toFixed(1)}% fire rate`;
    case "%speed":
      return `${delta >= 0 ? "+" : ""}${(delta * 100).toFixed(1)}% speed`;
    case "%salvage":
      return `${delta >= 0 ? "+" : ""}${(delta * 100).toFixed(1)}% salvage`;
    case "%repair":
      return `${delta >= 0 ? "+" : ""}${(delta * 100).toFixed(1)}% repair`;
    default:
      return `${delta >= 0 ? "+" : ""}${delta.toFixed(3)}`;
  }
}

export function nextRankEffectDelta(upgrade, level) {
  const current = newEffectMagnitude(upgrade, level);
  const next = newEffectMagnitude(upgrade, level + 1);
  return formatEffectValue(upgrade, next - current);
}

function permanent(opts) {
  const softCap = opts.softCap ?? opts.maxLevel ?? 5;
  // maxLevel kept as a backward-compat alias; new code reads softCap.
  return {
    ...opts,
    softCap,
    maxLevel: softCap,
  };
}

function equipment(id, name, description, slot, icon, effects, apply, options = {}) {
  const { unlockRequirement = null } = options;
  return { id, name, description, slot, icon, effects, apply, unlockRequirement };
}

export function isEquipmentUnlocked(item, metaProgress) {
  if (!item || !item.unlockRequirement) return true;
  const req = item.unlockRequirement;
  if (typeof req.maxedPermanents === "number") {
    if (countMaxedPermanents(metaProgress) < req.maxedPermanents) return false;
  }
  return true;
}

export function featuredUpgradeIdForDate(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const key = `${y}-${m}-${d}`;
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) {
    hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  }
  return PERMANENT_UPGRADES[hash % PERMANENT_UPGRADES.length].id;
}

export function discountedUpgradeCost(upgrade, level, isFeatured) {
  return Math.floor(upgradeCost(upgrade, level) * (isFeatured ? 0.75 : 1));
}
