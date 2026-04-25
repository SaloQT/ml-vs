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

export const EQUIPMENT = {
  weapon: [
    equipment("pulse-laser", "Pulse Laser", "Balanced automatic plasma fire.", "weapon", (player) => {
      player.stats.damage *= 1;
    }),
    equipment("rail-cannon", "Rail Cannon", "Harder hits, slower cadence.", "weapon", (player) => {
      player.stats.damage *= 1.35;
      player.stats.fireRate *= 0.76;
      player.stats.projectileSpeed *= 1.18;
    }),
    equipment("scatter-core", "Scatter Core", "Extra projectile, weaker shots.", "weapon", (player) => {
      player.stats.projectiles += 1;
      player.stats.damage *= 0.78;
      player.stats.fireRate *= 0.9;
    }),
  ],
  hull: [
    equipment("scout-frame", "Scout Frame", "Fast frame with lighter plating.", "hull", (player) => {
      player.stats.speed *= 1.08;
      player.stats.maxHp -= 10;
      player.hp = Math.min(player.hp, player.stats.maxHp);
    }),
    equipment("bulwark-frame", "Bulwark Frame", "Heavy frame with armor and hull.", "hull", (player) => {
      player.stats.maxHp += 28;
      player.stats.armor += 3;
      player.stats.speed *= 0.92;
      player.hp = player.stats.maxHp;
    }),
    equipment("standard-frame", "Standard Frame", "Reliable starter hull.", "hull", () => {}),
  ],
  utility: [
    equipment("magnet-rig", "Magnet Rig", "Improved pickup range.", "utility", (player) => {
      player.stats.pickupRadius += 38;
    }),
    equipment("targeting-suite", "Targeting Suite", "Better critical chance.", "utility", (player) => {
      player.stats.critChance += 0.08;
    }),
    equipment("repair-cache", "Repair Cache", "More repair drops, less XP gain.", "utility", (player) => {
      player.stats.repairDropBonus += 0.08;
      player.stats.xpGain *= 0.94;
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
  const defaults = defaultMetaProgress();
  return {
    ...defaults,
    ...raw,
    upgrades: {
      ...defaults.upgrades,
      ...(raw.upgrades ?? {}),
    },
    equipment: {
      ...defaults.equipment,
      ...(raw.equipment ?? {}),
    },
    best: {
      ...defaults.best,
      ...(raw.best ?? {}),
    },
  };
}

export function applyMetaProgress(player, meta) {
  for (const upgrade of PERMANENT_UPGRADES) {
    const level = Math.min(upgrade.maxLevel, meta.upgrades[upgrade.id] ?? 0);
    if (level > 0) upgrade.apply(level, player);
  }

  for (const [slot, selectedId] of Object.entries(meta.equipment)) {
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
  const raw = seconds * 0.75 + kills * 4 + Math.max(0, snapshot.wave - 1) * 35;
  return Math.max(8, Math.floor(raw * (1 + bonus)));
}

function permanent(id, name, description, maxLevel, baseCost, apply) {
  return { id, name, description, maxLevel, baseCost, apply };
}

function equipment(id, name, description, slot, apply) {
  return { id, name, description, slot, apply };
}
