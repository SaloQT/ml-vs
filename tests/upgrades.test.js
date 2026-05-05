import test from "node:test";
import assert from "node:assert/strict";

import { createEnemy } from "../src/entities.js";
import { GameSimulation } from "../src/simulation.js";
import { UPGRADE_POOL } from "../src/upgrades.js";

function upgrade(id) {
  return UPGRADE_POOL.find((item) => item.id === id);
}

function resetArena(simulation) {
  const player = simulation.players.get("p1");
  player.x = 0;
  player.y = 0;
  player.hp = player.stats.maxHp;
  player.cooldown = 999;
  player.invulnerableFor = 0;
  simulation.enemies.clear();
  simulation.projectiles.clear();
  simulation.pickups.clear();
  simulation.effects.clear();
  return player;
}

test("new upgrade choices expose clear descriptions and stack limits", () => {
  const expected = [
    ["kinetic-capacitor", "Weapon hits gain up to 18% damage while moving at full thrust.", 3],
    ["breaker-coils", "Kills shave 0.08 seconds off the next weapon cooldown.", 4],
    ["impact-shielding", "Shielded collisions discharge 18 damage into the attacker.", 3],
    ["last-stand-grid", "Once per run, dropping below 35% hull grants a 45-point shield.", 1],
  ];

  for (const [id, description, maxStacks] of expected) {
    const item = upgrade(id);
    assert.ok(item, `${id} should be in the upgrade pool`);
    assert.equal(item.description, description);
    assert.equal(item.maxStacks, maxStacks);
  }
});

test("kinetic capacitor scales weapon damage with current movement speed", () => {
  const simulation = new GameSimulation({ seed: 41 });
  const player = resetArena(simulation);
  upgrade("kinetic-capacitor").apply(player);
  upgrade("kinetic-capacitor").apply(player);

  player.vx = 0;
  player.vy = 0;
  assert.equal(simulation.rollDamage(player), 24);

  player.vx = simulation.playerSpeed(player);
  player.vy = 0;
  assert.equal(Number(simulation.rollDamage(player).toFixed(6)), Number((24 * 1.36).toFixed(6)));
});

test("breaker coils refund weapon cooldown when owned player gets kills", () => {
  const simulation = new GameSimulation({ seed: 42 });
  const player = resetArena(simulation);
  upgrade("breaker-coils").apply(player);
  upgrade("breaker-coils").apply(player);
  player.cooldown = 0.3;

  const enemy = createEnemy("cooldown-target", "drone", 100, 0, 1);
  simulation.enemies.set(enemy.id, enemy);
  simulation.damageEnemy(enemy, enemy.hp, { ownerId: player.id, x: 80, y: 0, vx: 1, vy: 0 });

  assert.equal(player.kills, 1);
  assert.equal(Number(player.cooldown.toFixed(6)), 0.14);
});

test("last-stand grid grants its shield once when hull falls low", () => {
  const simulation = new GameSimulation({ seed: 43 });
  const player = resetArena(simulation);
  upgrade("last-stand-grid").apply(player);

  player.hp = player.stats.maxHp * 0.35;
  simulation.updatePlayers(0);

  assert.equal(player.shield, 45);
  assert.equal(player.emergencyShieldUsed, true);
  assert.ok([...simulation.effects.values()].some((effect) => effect.type === "shield"));

  player.shield = 0;
  player.hp = player.stats.maxHp * 0.2;
  simulation.updatePlayers(0);

  assert.equal(player.shield, 0);
});

test("impact shielding damages collision attackers only when shield absorbs damage", () => {
  const simulation = new GameSimulation({ seed: 44 });
  const player = resetArena(simulation);
  upgrade("impact-shielding").apply(player);
  player.shield = 60;

  const enemy = createEnemy("ram-target", "drone", player.radius + 10, 0, 1);
  const startingHp = enemy.hp;
  simulation.enemies.set(enemy.id, enemy);

  simulation.updateEnemies(0);

  assert.equal(enemy.hp, startingHp - 18);
  assert.equal(player.hp, player.stats.maxHp);
  assert.ok(player.shield < 60);
});

test("Plague Lance fires a chaos-breakdown projectile", () => {
  const simulation = new GameSimulation({ seed: 7 });
  const player = resetArena(simulation);
  upgrade("plague-lance").apply(player);
  player.cooldown = 999;
  player.plagueLanceCooldown = 0;
  simulation.inputs.set(player.id, { moveX: 0, moveY: 0, aimX: 1, aimY: 0 });
  simulation.updatePlayers(0.016);
  const projs = [...simulation.projectiles.values()];
  assert.equal(projs.length, 1);
  assert.equal(projs[0].damageType, "chaos");
  assert.deepEqual(projs[0].damageBreakdown, { physical: 12, chaos: 20 });
  assert.equal(projs[0].pierce, 3);
});

test("Pyre Brand fires a fire-breakdown projectile that pierces 2", () => {
  const simulation = new GameSimulation({ seed: 8 });
  const player = resetArena(simulation);
  upgrade("pyre-brand").apply(player);
  player.cooldown = 999;
  player.pyreBrandCooldown = 0;
  simulation.inputs.set(player.id, { moveX: 0, moveY: 0, aimX: 1, aimY: 0 });
  simulation.updatePlayers(0.016);
  const projs = [...simulation.projectiles.values()];
  assert.equal(projs.length, 1);
  assert.equal(projs[0].damageType, "fire");
  assert.deepEqual(projs[0].damageBreakdown, { physical: 8, fire: 20 });
  assert.equal(projs[0].pierce, 2);
});

test("Conflagration chain requires its prerequisite", () => {
  const c1 = upgrade("conflagration-1");
  const c2 = upgrade("conflagration-2");
  const c3 = upgrade("conflagration-3");
  const brand = upgrade("pyre-brand");
  assert.equal(c1.requires, "pyre-brand");
  assert.equal(c2.requires, "conflagration-1");
  assert.equal(c3.requires, "conflagration-2");
  assert.equal(brand.requires, undefined);
});

test("Rime Lance fires a cold-breakdown projectile with frostbite metadata", () => {
  const simulation = new GameSimulation({ seed: 17 });
  const player = resetArena(simulation);
  upgrade("rime-lance").apply(player);
  player.cooldown = 999;
  player.rimeLanceCooldown = 0;
  simulation.inputs.set(player.id, { moveX: 0, moveY: 0, aimX: 1, aimY: 0 });
  simulation.updatePlayers(0.016);
  const projs = [...simulation.projectiles.values()];
  assert.equal(projs.length, 1);
  assert.equal(projs[0].damageType, "cold");
  assert.deepEqual(projs[0].damageBreakdown, { physical: 10, cold: 22 });
  assert.equal(projs[0].pierce, 2);
  assert.equal(projs[0].frostbite, true);
  assert.equal(projs[0].permafrostBonus, 0);
  assert.equal(projs[0].shatterpoint, false);
});

test("Glaciation chain requires its prerequisite", () => {
  const g1 = upgrade("glaciation-1");
  const g2 = upgrade("glaciation-2");
  const g3 = upgrade("glaciation-3");
  const lance = upgrade("rime-lance");
  assert.equal(g1.requires, "rime-lance");
  assert.equal(g2.requires, "glaciation-1");
  assert.equal(g3.requires, "glaciation-2");
  assert.equal(lance.requires, undefined);
});

test("Glaciation tiers stack onto Rime Lance projectile metadata", () => {
  const simulation = new GameSimulation({ seed: 19 });
  const player = resetArena(simulation);
  upgrade("rime-lance").apply(player);
  upgrade("glaciation-1").apply(player);
  upgrade("glaciation-2").apply(player);
  upgrade("glaciation-3").apply(player);
  player.cooldown = 999;
  player.rimeLanceCooldown = 0;
  simulation.inputs.set(player.id, { moveX: 0, moveY: 0, aimX: 1, aimY: 0 });
  simulation.updatePlayers(0.016);
  const proj = [...simulation.projectiles.values()][0];
  assert.equal(proj.permafrostBonus, 0.35);
  assert.equal(proj.shatterpoint, true);
  assert.ok(proj.shatterDamage > 0);
  assert.equal(proj.shatterCritMultiplier, 2);
  assert.equal(proj.cryoclasmBrittleBonus, 0.1);
});

test("Permafrost amplifies Rime Lance damage against chilled targets", () => {
  const simulation = new GameSimulation({ seed: 23 });
  const player = resetArena(simulation);
  upgrade("rime-lance").apply(player);
  upgrade("glaciation-1").apply(player);

  const baseEnemy = createEnemy("base", "drone", 0, 0, 1);
  baseEnemy.maxHp = 1000; baseEnemy.hp = 1000; baseEnemy.armor = 0;
  simulation.enemies.set(baseEnemy.id, baseEnemy);

  const chilledEnemy = createEnemy("chilled", "drone", 0, 0, 1);
  chilledEnemy.maxHp = 1000; chilledEnemy.hp = 1000; chilledEnemy.armor = 0;
  chilledEnemy.ailments.chill = { remaining: 2, magnitude: 0.2, dotPerSecond: 0, tickAccumulator: 0, tickRate: 0.25 };
  simulation.enemies.set(chilledEnemy.id, chilledEnemy);

  const source = {
    ownerId: player.id, x: 0, y: 0, vx: 1, vy: 0,
    damageType: "cold", damageBreakdown: { cold: 100 },
    frostbite: true, permafrostBonus: 0.35,
  };
  simulation.damageEnemy(baseEnemy, 100, source);
  simulation.damageEnemy(chilledEnemy, 100, source);

  const baseDealt = 1000 - baseEnemy.hp;
  const chilledDealt = 1000 - chilledEnemy.hp;
  assert.ok(chilledDealt > baseDealt * 1.3, `chilled=${chilledDealt} base=${baseDealt}`);
});

test("Shatterpoint burst hits neighbours, sets fromAilment so it cannot re-apply ailments", () => {
  const simulation = new GameSimulation({ seed: 29 });
  const player = resetArena(simulation);
  upgrade("rime-lance").apply(player);
  upgrade("glaciation-2").apply(player);

  const frozen = createEnemy("frozen", "drone", 0, 0, 1);
  frozen.maxHp = 1000; frozen.hp = 1000; frozen.armor = 0;
  frozen.ailments.freeze = { remaining: 2, magnitude: 0, dotPerSecond: 0, tickAccumulator: 0, tickRate: 0.25 };
  simulation.enemies.set(frozen.id, frozen);

  const neighbour = createEnemy("neigh", "drone", 30, 0, 1);
  neighbour.maxHp = 1000; neighbour.hp = 1000; neighbour.armor = 0;
  simulation.enemies.set(neighbour.id, neighbour);

  const farAway = createEnemy("far", "drone", 9999, 0, 1);
  farAway.maxHp = 1000; farAway.hp = 1000; farAway.armor = 0;
  simulation.enemies.set(farAway.id, farAway);

  simulation.damageEnemy(frozen, 30, {
    ownerId: player.id, x: -10, y: 0, vx: 1, vy: 0,
    damageType: "cold", damageBreakdown: { cold: 30 },
    shatterpoint: true, shatterRadius: 70, shatterDamage: 25, shatterCritMultiplier: 1,
  });

  assert.ok(frozen.hp < 1000 - 30, "frozen target should take both lance + shatter damage");
  assert.ok(neighbour.hp < 1000, "neighbour in shatter radius takes burst damage");
  assert.equal(farAway.hp, 1000, "out-of-range enemy untouched");
  // Shatter is fromAilment:true, so neighbour shouldn't have any new chill/freeze
  // (only the lance hit on the originally frozen enemy can apply ailments).
  // Ensure neighbour did NOT acquire freeze from the shatter.
  assert.equal(neighbour.ailments.freeze, undefined, "shatter must not freeze neighbours");
});

test("Shatterpoint payoff still works on freeze-immune bosses via brittle", () => {
  const simulation = new GameSimulation({ seed: 31 });
  const player = resetArena(simulation);
  upgrade("rime-lance").apply(player);
  upgrade("glaciation-2").apply(player);

  const boss = createEnemy("b1", "drone", 0, 0, 1, { bossId: "test-boss", rank: "boss" });
  boss.maxHp = 5000; boss.hp = 5000; boss.armor = 0;
  // Boss can be brittle (no boss resistance on brittle in config).
  boss.ailments.brittle = { remaining: 3, magnitude: 0.1, dotPerSecond: 0, tickAccumulator: 0, tickRate: 0.25 };
  simulation.enemies.set(boss.id, boss);

  const before = boss.hp;
  simulation.damageEnemy(boss, 30, {
    ownerId: player.id, x: -10, y: 0, vx: 1, vy: 0,
    damageType: "cold", damageBreakdown: { cold: 30 },
    shatterpoint: true, shatterRadius: 70, shatterDamage: 25, shatterCritMultiplier: 1,
  });
  // Lance hit (~30) + shatter burst (~25) should deal more than just the lance hit.
  const dealt = before - boss.hp;
  assert.ok(dealt > 40, `expected lance+shatter on brittle boss, dealt=${dealt}`);
});

test("Cryoclasm bumps brittle magnitude on Rime Lance hits", () => {
  const stubRng = { next() { return 0; } };
  const sim = new GameSimulation({ seed: 1 });
  sim.enemies.clear();
  sim.rng = stubRng;

  const e = createEnemy("e", "drone", 0, 0, 1);
  e.maxHp = 200; e.hp = 200; e.armor = 0;
  sim.enemies.set(e.id, e);
  sim.damageEnemy(e, 80, {
    ownerId: "p1", x: -10, y: 0, vx: 1, vy: 0,
    damageType: "cold", damageBreakdown: { cold: 80 },
    cryoclasmBrittleBonus: 0.1,
  });
  const brittleMag = e.ailments.brittle?.magnitude ?? 0;
  assert.ok(brittleMag >= 0.1, `expected brittle magnitude boosted by cryoclasm, got ${brittleMag}`);

  const e2 = createEnemy("e2", "drone", 0, 0, 1);
  e2.maxHp = 200; e2.hp = 200; e2.armor = 0;
  sim.enemies.set(e2.id, e2);
  sim.damageEnemy(e2, 80, {
    ownerId: "p1", x: -10, y: 0, vx: 1, vy: 0,
    damageType: "cold", damageBreakdown: { cold: 80 },
  });
  const baseMag = e2.ailments.brittle?.magnitude ?? 0;
  assert.ok(brittleMag > baseMag, `cryoclasm bonus (${brittleMag}) should exceed base (${baseMag})`);
});

test("Virulence chain requires its prerequisite", () => {
  const v1 = upgrade("virulence-1");
  const v2 = upgrade("virulence-2");
  const v3 = upgrade("virulence-3");
  const lance = upgrade("plague-lance");
  assert.equal(v1.requires, "plague-lance");
  assert.equal(v2.requires, "virulence-1");
  assert.equal(v3.requires, "virulence-2");
  assert.equal(lance.requires, undefined);
});
