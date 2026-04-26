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
  statUpgrade("med-bay-protocol", "Med-Bay Protocol", "rare", "Bruisers are more likely to drop repair shields.", 3, (player) => {
    player.stats.repairDropBonus += 0.08;
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
];

export function pickUpgradeChoices(rng, player, count = 3) {
  const candidates = UPGRADE_POOL.filter((upgrade) => {
    const stacks = player.upgradeStacks?.get(upgrade.id) ?? 0;
    return stacks < upgrade.maxStacks;
  });
  const choices = [];
  while (choices.length < count && candidates.length) {
    const totalWeight = candidates.reduce((sum, upgrade) => sum + rarityWeight(upgrade.rarity), 0);
    let roll = rng.next() * totalWeight;
    const index = candidates.findIndex((upgrade) => {
      roll -= rarityWeight(upgrade.rarity);
      return roll <= 0;
    });
    choices.push(candidates.splice(Math.max(0, index), 1)[0]);
  }
  return choices;
}

function statUpgrade(id, name, rarity, description, maxStacks, apply) {
  return { id, name, rarity, description, maxStacks, apply };
}

function rarityWeight(rarity) {
  if (rarity === "epic") return 0.45;
  if (rarity === "rare") return 1.25;
  return 3;
}
