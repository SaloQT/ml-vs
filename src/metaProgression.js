export const META_STORAGE_KEY = "space-survivors-meta";

export const PERMANENT_UPGRADES = [
  permanent("reinforced-hull", "Reinforced Hull", "Start each run with more max hull.", 5, 85, (level, player) => {
    player.stats.maxHp += level * 8;
    player.hp = player.stats.maxHp;
  }),
  permanent("reactor-tuning", "Reactor Tuning", "Small permanent fire-rate increase.", 5, 110, (level, player) => {
    player.stats.fireRate *= 1 + level * 0.035;
  }),
  permanent("combat-drills", "Combat Drills", "Small permanent damage increase.", 5, 120, (level, player) => {
    player.stats.damage *= 1 + level * 0.04;
  }),
  permanent("nav-school", "Nav School", "Start runs with better thruster calibration.", 4, 95, (level, player) => {
    player.stats.speed *= 1 + level * 0.025;
  }),
  permanent("scrap-charter", "Scrap Charter", "Earn more permanent scrap from runs.", 5, 140, (level, player) => {
    player.stats.salvageBonus += level * 0.05;
  }),
  permanent("field-medicine", "Field Medicine", "Repair drops restore more hull.", 4, 130, (level, player) => {
    player.stats.repairDropBonus += level * 0.025;
  }),
];

export const EQUIPMENT_SLOTS = {
  weapon: "Weapon",
  hull: "Hull",
  utility: "Utility",
};

export const EQUIPMENT = {
  weapon: [
    equipment("pulse-laser", "Pulse Laser", "Balanced automatic plasma fire.", "weapon", ["Baseline damage and cadence"], (player) => {
      player.stats.damage *= 1;
    }),
    equipment("rail-cannon", "Rail Cannon", "Harder hits, slower cadence.", "weapon", ["+35% damage", "-24% fire rate", "+18% projectile speed"], (player) => {
      player.stats.damage *= 1.35;
      player.stats.fireRate *= 0.76;
      player.stats.projectileSpeed *= 1.18;
    }),
    equipment("scatter-core", "Scatter Core", "Extra projectile, weaker shots.", "weapon", ["+1 projectile", "-22% damage", "-10% fire rate"], (player) => {
      player.stats.projectiles += 1;
      player.stats.damage *= 0.78;
      player.stats.fireRate *= 0.9;
    }),
    equipment("coil-repeater", "Coil Repeater", "Rapid cycling coils with lighter impact.", "weapon", ["+28% fire rate", "-12% damage", "-8% projectile speed"], (player) => {
      player.stats.fireRate *= 1.28;
      player.stats.damage *= 0.88;
      player.stats.projectileSpeed *= 0.92;
    }),
    equipment("ion-lance", "Ion Lance", "Precision beam tuned for critical strikes.", "weapon", ["+10% crit chance", "+35% crit damage", "-12% fire rate"], (player) => {
      player.stats.critChance += 0.1;
      player.stats.critDamage += 0.35;
      player.stats.fireRate *= 0.88;
    }),
    equipment("flak-array", "Flak Array", "Wide blast pattern for close-range swarms.", "weapon", ["+1 projectile", "+18% area", "-16% damage", "-12% projectile speed"], (player) => {
      player.stats.projectiles += 1;
      player.stats.area *= 1.18;
      player.stats.damage *= 0.84;
      player.stats.projectileSpeed *= 0.88;
    }),
  ],
  hull: [
    equipment("scout-frame", "Scout Frame", "Fast frame with lighter plating.", "hull", ["+8% speed", "-10 max hull"], (player) => {
      player.stats.speed *= 1.08;
      player.stats.maxHp -= 10;
      player.hp = Math.min(player.hp, player.stats.maxHp);
    }),
    equipment("bulwark-frame", "Bulwark Frame", "Heavy frame with armor and hull.", "hull", ["+28 max hull", "+3 armor", "-8% speed"], (player) => {
      player.stats.maxHp += 28;
      player.stats.armor += 3;
      player.stats.speed *= 0.92;
      player.hp = player.stats.maxHp;
    }),
    equipment("standard-frame", "Standard Frame", "Reliable starter hull.", "hull", ["No stat tradeoffs"], () => {}),
    equipment("interceptor-frame", "Interceptor Frame", "Stripped pursuit frame for aggressive piloting.", "hull", ["+14% speed", "+8% fire rate", "-22 max hull"], (player) => {
      player.stats.speed *= 1.14;
      player.stats.fireRate *= 1.08;
      player.stats.maxHp -= 22;
      player.hp = Math.min(player.hp, player.stats.maxHp);
    }),
    equipment("aegis-frame", "Aegis Frame", "Dense plating with redundant repair channels.", "hull", ["+18 max hull", "+2 armor", "+6% repair drops", "-5% speed"], (player) => {
      player.stats.maxHp += 18;
      player.stats.armor += 2;
      player.stats.repairDropBonus += 0.06;
      player.stats.speed *= 0.95;
      player.hp = player.stats.maxHp;
    }),
    equipment("reactor-frame", "Reactor Frame", "Expanded reactor bay that trades shielding for output.", "hull", ["+16% damage", "+10% fire rate", "-16 max hull", "-1 armor"], (player) => {
      player.stats.damage *= 1.16;
      player.stats.fireRate *= 1.1;
      player.stats.maxHp -= 16;
      player.stats.armor -= 1;
      player.hp = Math.min(player.hp, player.stats.maxHp);
    }),
  ],
  utility: [
    equipment("magnet-rig", "Magnet Rig", "Improved pickup range.", "utility", ["+38 pickup radius"], (player) => {
      player.stats.pickupRadius += 38;
    }),
    equipment("targeting-suite", "Targeting Suite", "Better critical chance.", "utility", ["+8% crit chance"], (player) => {
      player.stats.critChance += 0.08;
    }),
    equipment("repair-cache", "Repair Cache", "More repair drops, less XP gain.", "utility", ["+8% repair drops", "-6% XP gain"], (player) => {
      player.stats.repairDropBonus += 0.08;
      player.stats.xpGain *= 0.94;
    }),
    equipment("salvage-net", "Salvage Net", "Scrap reclamation rig with a wider collection field.", "utility", ["+10% salvage", "+20 pickup radius", "-4% speed"], (player) => {
      player.stats.salvageBonus += 0.1;
      player.stats.pickupRadius += 20;
      player.stats.speed *= 0.96;
    }),
    equipment("overclock-relay", "Overclock Relay", "Pushes weapon power at the cost of repairs.", "utility", ["+9% damage", "+9% fire rate", "-5% repair drops"], (player) => {
      player.stats.damage *= 1.09;
      player.stats.fireRate *= 1.09;
      player.stats.repairDropBonus -= 0.05;
    }),
    equipment("stabilizer-vanes", "Stabilizer Vanes", "Tighter flight and faster rounds with less draw range.", "utility", ["+6% speed", "+10% projectile speed", "-18 pickup radius"], (player) => {
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
  };
}

export function normalizeMetaProgress(raw = {}) {
  const source = raw && typeof raw === "object" ? raw : {};
  const defaults = defaultMetaProgress();
  const rawEquipment = source.equipment && typeof source.equipment === "object" ? source.equipment : {};
  return {
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
}

export function applyMetaProgress(player, meta) {
  const normalized = normalizeMetaProgress(meta);
  for (const upgrade of PERMANENT_UPGRADES) {
    const level = Math.min(upgrade.maxLevel, normalized.upgrades[upgrade.id] ?? 0);
    if (level > 0) upgrade.apply(level, player);
  }

  for (const [slot, selectedId] of Object.entries(normalized.equipment)) {
    const item = EQUIPMENT[slot]?.find((candidate) => candidate.id === selectedId);
    item?.apply(player);
  }
  player.hp = Math.min(player.hp, player.stats.maxHp);
}

export function upgradeCost(upgrade, currentLevel) {
  return Math.round(upgrade.baseCost * (currentLevel + 1) ** 1.55);
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

function permanent(id, name, description, maxLevel, baseCost, apply) {
  return { id, name, description, maxLevel, baseCost, apply };
}

function equipment(id, name, description, slot, effects, apply) {
  return { id, name, description, slot, effects, apply };
}
