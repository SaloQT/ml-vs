export const UPGRADE_POOL = [
  statUpgrade("plasma-overclock", "Plasma Overclock", "common", "Pulse lasers fire 14% faster.", 5, (player) => {
    player.stats.fireRate *= 1.14;
  }),
  statUpgrade("ion-lens", "Ion Lens", "common", "Projectiles hit 16% harder.", 5, (player) => {
    player.stats.damage *= 1.16;
  }),
  statUpgrade("thruster-array", "Thruster Array", "common", "Move 9% faster.", 4, (player) => {
    player.stats.speed *= 1.09;
  }),
  statUpgrade("cargo-magnet", "Cargo Magnet", "common", "Collect cores from farther away.", 4, (player) => {
    player.stats.pickupRadius += 30;
  }),
  statUpgrade("momentum-scoop", "Momentum Scoop", "common", "Collecting pickups grants a 1.2s speed burst.", 3, (player) => {
    player.stats.pickupSpeedBurstDuration += 1.2;
    player.stats.pickupSpeedBurstMultiplier += 0.1;
  }),
  statUpgrade("capacitor-bank", "Capacitor Bank", "common", "Bolts last 20% longer.", 3, (player) => {
    player.stats.projectileTtl *= 1.2;
  }),
  statUpgrade("wide-bore", "Wide Bore", "common", "Bolts and energy bursts grow 12%.", 4, (player) => {
    player.stats.projectileRadius += 1;
    player.stats.area *= 1.12;
  }),
  statUpgrade("combat-scavenger", "Combat Scavenger", "common", "Gain 10% more XP from cores.", 4, (player) => {
    player.stats.xpGain *= 1.1;
  }),
  statUpgrade("core-transmuter", "Core Transmuter", "common", "Every third XP core collected also yields 1 scrap.", 4, (player) => {
    player.stats.xpPickupScrapEvery = 3;
    player.stats.xpPickupScrapValue += 1;
  }),
  statUpgrade("reactive-plating", "Reactive Plating", "common", "Reduce incoming collision damage by 2.", 4, (player) => {
    player.stats.armor += 2;
  }),
  statUpgrade("shield-harmonics", "Shield Harmonics", "rare", "Restore hull and raise max hull by 20.", 4, (player) => {
    player.stats.maxHp += 20;
    player.hp = Math.min(player.stats.maxHp, player.hp + 38);
  }),
  statUpgrade("splitter-warheads", "Splitter Warheads", "rare", "Launch one extra bolt per volley.", 3, (player) => {
    player.stats.projectiles += 1;
    player.stats.fireRate *= 0.94;
  }),
  statUpgrade("phase-lance", "Phase Lance", "rare", "Bolts pierce one additional enemy.", 2, (player) => {
    player.stats.projectilePierce += 1;
    player.stats.projectileTtl *= 1.08;
  }),
  statUpgrade("orbital-drone", "Orbital Drone", "rare", "Adds a rotating drone that burns nearby enemies.", 4, (player) => {
    player.stats.drones += 1;
  }),
  statUpgrade("targeting-ai", "Targeting AI", "rare", "Critical chance rises by 7%.", 4, (player) => {
    player.stats.critChance += 0.07;
  }),
  statUpgrade("reactor-siphon", "Reactor Siphon", "rare", "Regenerate hull slowly while under 70%.", 3, (player) => {
    player.stats.regen += 1.1;
  }),
  statUpgrade("salvage-rig", "Salvage Rig", "rare", "Earn 12% more permanent scrap from this run.", 3, (player) => {
    player.stats.salvageBonus += 0.12;
  }),
  statUpgrade("scrap-contract", "Scrap Contract", "rare", "Scrap pickups are worth 35% more and grant 1 XP.", 3, (player) => {
    player.stats.scrapValueMultiplier *= 1.35;
    player.stats.scrapGrantsXp += 1;
  }),
  statUpgrade("pulse-magnetron", "Pulse Magnetron", "rare", "Magnet pickups last 1.5s longer and pull from 160 farther out.", 3, (player) => {
    player.stats.magnetPickupDurationBonus += 1.5;
    player.stats.magnetBurstRadiusBonus += 160;
  }),
  statUpgrade("med-bay-protocol", "Med-Bay Protocol", "rare", "Bruisers are more likely to drop repair shields.", 3, (player) => {
    player.stats.repairDropBonus += 0.08;
  }),
  statUpgrade("cache-codebreaker", "Cache Codebreaker", "rare", "Caches pay 50% more scrap and XP.", 3, (player) => {
    player.stats.cacheValueBonus += 0.5;
  }),
  statUpgrade("survey-drones", "Survey Drones", "rare", "Future level-up choices favor rarer upgrade signals.", 2, (player) => {
    player.stats.choiceQualityBonus += 0.35;
  }),
  statUpgrade("kinetic-capacitor", "Kinetic Capacitor", "rare", "Weapon hits gain up to 18% damage while moving at full thrust.", 3, (player) => {
    player.stats.velocityDamageBonus += 0.18;
  }),
  statUpgrade("breaker-coils", "Breaker Coils", "rare", "Kills shave 0.08 seconds off the next weapon cooldown.", 4, (player) => {
    player.stats.killCooldownRefund += 0.08;
  }),
  statUpgrade("impact-shielding", "Impact Shielding", "rare", "Shielded collisions discharge 18 damage into the attacker.", 3, (player) => {
    player.stats.ramDamage += 18;
  }),
  statUpgrade("rail-accelerator", "Rail Accelerator", "rare", "Bolts accelerate in flight, up to 60% bonus speed.", 3, (player) => {
    player.stats.projectileAcceleration += 0.9;
    player.stats.projectileMaxSpeedMultiplier += 0.6;
  }),
  statUpgrade("thermite-jacket", "Thermite Jacket", "rare", "Projectile hits burn enemies for 10 damage per second.", 3, (player) => {
    player.stats.burnDps += 10;
    player.stats.burnDuration = Math.max(player.stats.burnDuration, 1.8);
  }),
  statUpgrade("hunter-mark", "Hunter Mark", "rare", "Projectile hits mark targets to take 18% more follow-up damage.", 3, (player) => {
    player.stats.markDamageTakenMultiplier += 0.18;
    player.stats.markDuration = Math.max(player.stats.markDuration, 2.2);
  }),
  statUpgrade("drone-relay", "Drone Relay", "rare", "Projectile hits call each drone to arc 25% weapon damage into a nearby enemy.", 3, (player) => {
    player.stats.droneArcDamagePerDrone += 0.25;
    player.stats.droneArcRange += 35;
  }),
  statUpgrade("aegis-reservoir", "Aegis Reservoir", "rare", "Shield pickups restore 20% more and can overcharge 30 extra shield.", 3, (player) => {
    player.stats.maxShield += 30;
    player.stats.shieldPickupMultiplier += 0.2;
  }),
  statUpgrade("flux-recharger", "Flux Recharger", "rare", "After 3 seconds without damage, rebuild 5 shield per second up to 25.", 3, (player) => {
    player.stats.shieldRechargeRate += 5;
    player.stats.shieldRechargeCap += 25;
  }),
  statUpgrade("ablative-matrix", "Ablative Matrix", "rare", "Every 25 active shield counts as 1 armor before incoming damage.", 3, (player) => {
    player.stats.shieldArmorConversion += 1;
  }),
  statUpgrade("repulsor-field", "Repulsor Field", "rare", "Enemy contact throws attackers farther back after they hit you.", 3, (player) => {
    player.stats.contactKnockback += 34;
  }),
  statUpgrade("trauma-nanites", "Trauma Nanites", "rare", "Once per run below 30% hull, repair 24 hull over 4 seconds.", 2, (player) => {
    player.stats.crisisRepair += 24;
  }),
  statUpgrade("phase-bulwark", "Phase Bulwark", "rare", "Taking damage grants 0.12 seconds more invulnerability.", 3, (player) => {
    player.stats.invulnerabilityBonus += 0.12;
  }),
  statUpgrade("mirror-plating", "Mirror Plating", "epic", "Reflect 35% of hull damage back into contact attackers.", 2, (player) => {
    player.stats.hullDamageReflection += 0.35;
  }),
  statUpgrade("gravity-well", "Gravity Well", "epic", "Every tenth shot creates a singularity burst.", 3, (player) => {
    player.stats.gravityWell += 1;
  }),
  statUpgrade("quantum-rails", "Quantum Rails", "epic", "Bolts travel 18% faster and hit 28% harder.", 2, (player) => {
    player.stats.projectileSpeed *= 1.18;
    player.stats.damage *= 1.28;
  }),
  statUpgrade("arc-conductor", "Arc Conductor", "epic", "Projectile hits chain lightning to a nearby enemy.", 3, (player) => {
    player.stats.chainArcs += 1;
    player.stats.chainDamageMultiplier += 0.12;
  }),
  statUpgrade("forked-conductor", "Forked Conductor", "epic", "Chain lightning forks from the first target into two nearby enemies.", 2, (player) => {
    player.stats.chainForks += 2;
    player.stats.chainDamageMultiplier += 0.08;
  }),
  statUpgrade("detonation-catalyst", "Detonation Catalyst", "epic", "Splash impacts hammer the main target harder for each enemy caught in the blast.", 2, (player) => {
    player.stats.splashCenterBonusPerTarget += 0.18;
    player.stats.splashDamageMultiplier = Math.max(player.stats.splashDamageMultiplier, 0.45);
  }),
  statUpgrade("execution-protocol", "Execution Protocol", "epic", "Critical hits execute enemies left below 12% hull.", 2, (player) => {
    player.stats.critExecuteThreshold += 0.12;
    player.stats.critChance += 0.04;
  }),
  statUpgrade("reaper-volley", "Reaper Volley", "epic", "Kills launch three seeking shards from the wreck into nearby enemies.", 2, (player) => {
    player.stats.killVolleyProjectiles += 3;
    player.stats.killVolleyDamageMultiplier += 0.08;
  }),
  statUpgrade("reclaimer-matrix", "Reclaimer Matrix", "epic", "Overflow repair and shield pickups convert into scrap.", 2, (player) => {
    player.stats.repairOverflowScrap += 0.4;
    player.stats.shieldOverflowScrap += 0.25;
  }),
  statUpgrade("twin-core-reactor", "Twin-Core Reactor", "epic", "Fire 24% faster, but max hull drops by 12.", 2, (player) => {
    player.stats.fireRate *= 1.24;
    player.stats.maxHp = Math.max(60, player.stats.maxHp - 12);
    player.hp = Math.min(player.hp, player.stats.maxHp);
  }),
  statUpgrade("singularity-array", "Singularity Array", "epic", "Energy effects grow 28% and pull harder.", 2, (player) => {
    player.stats.area *= 1.28;
    player.stats.gravityWell += 1;
  }),
  statUpgrade("last-stand-grid", "Last-Stand Grid", "epic", "Once per run, dropping below 35% hull grants a 45-point shield.", 1, (player) => {
    player.stats.emergencyShield += 45;
  }),
  statUpgrade("plague-lance", "Plague Lance", "rare", "Equip a slow chaos-tipped lance that pierces 3 enemies and reliably poisons.", 1, (player) => {
    player.stats.plagueLanceLevel += 1;
  }),
  requiresUpgrade(
    statUpgrade("virulence-1", "Virulence I — Festering Wounds", "rare", "Your poisons deal 50% more damage over time.", 1, (player) => {
      player.stats.virulence1 = 1;
    }),
    "plague-lance",
  ),
  requiresUpgrade(
    statUpgrade("virulence-2", "Virulence II — Contagion", "epic", "Enemies dying with 4+ poison stacks erupt in a chaos burst that re-poisons neighbours.", 1, (player) => {
      player.stats.virulence2 = 1;
    }),
    "virulence-1",
  ),
  requiresUpgrade(
    statUpgrade("virulence-3", "Virulence III — Pandemic", "epic", "Your poison stack cap rises from 8 to 12.", 1, (player) => {
      player.stats.virulence3 = 1;
    }),
    "virulence-2",
  ),
  statUpgrade("rime-lance", "Rime Lance", "rare", "Equip a slow cold lance that pierces 2 enemies and reliably chills/freezes.", 1, (player) => {
    player.stats.rimeLanceLevel += 1;
  }),
  requiresUpgrade(
    statUpgrade("glaciation-1", "Glaciation I — Permafrost", "rare", "Rime Lance hits deal 35% more damage to chilled, frozen, or brittle enemies.", 1, (player) => {
      player.stats.glaciation1 = 1;
    }),
    "rime-lance",
  ),
  requiresUpgrade(
    statUpgrade("glaciation-2", "Glaciation II — Shatterpoint", "epic", "Rime Lance hits on frozen or brittle enemies erupt in a cold shatter burst.", 1, (player) => {
      player.stats.glaciation2 = 1;
    }),
    "glaciation-1",
  ),
  requiresUpgrade(
    statUpgrade("glaciation-3", "Glaciation III — Cryoclasm", "epic", "Critical Rime Lance hits double the shatter burst and extend brittle by 0.10 magnitude.", 1, (player) => {
      player.stats.glaciation3 = 1;
    }),
    "glaciation-2",
  ),
];

function requiresUpgrade(upgrade, requiredId) {
  upgrade.requires = requiredId;
  return upgrade;
}

export function pickUpgradeChoices(rng, player, count = 3) {
  const owned = player.ownedUpgrades ?? new Set();
  const candidates = UPGRADE_POOL.filter((upgrade) => {
    const stacks = player.upgradeStacks?.get(upgrade.id) ?? 0;
    if (stacks >= upgrade.maxStacks) return false;
    if (upgrade.requires && !owned.has(upgrade.requires)) return false;
    return true;
  });
  const choices = [];
  while (choices.length < count && candidates.length) {
    const totalWeight = candidates.reduce((sum, upgrade) => sum + rarityWeight(upgrade.rarity, player), 0);
    let roll = rng.next() * totalWeight;
    const index = candidates.findIndex((upgrade) => {
      roll -= rarityWeight(upgrade.rarity, player);
      return roll <= 0;
    });
    choices.push(candidates.splice(Math.max(0, index), 1)[0]);
  }
  return choices;
}

function statUpgrade(id, name, rarity, description, maxStacks, apply) {
  return { id, name, rarity, description, maxStacks, apply };
}

function rarityWeight(rarity, player = null) {
  const quality = Math.max(0, player?.stats?.choiceQualityBonus ?? 0);
  if (rarity === "epic") return 0.45 * (1 + quality * 1.6);
  if (rarity === "rare") return 1.25 * (1 + quality);
  if (quality) return Math.max(0.45, 3 * (1 - quality * 0.45));
  return 3;
}
