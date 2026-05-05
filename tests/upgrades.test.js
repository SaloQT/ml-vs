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

test("Tempest Coil fires a lightning projectile with chain metadata", () => {
  const simulation = new GameSimulation({ seed: 17 });
  const player = resetArena(simulation);
  upgrade("tempest-coil").apply(player);
  player.cooldown = 999;
  player.tempestCoilCooldown = 0;
  simulation.inputs.set(player.id, { moveX: 0, moveY: 0, aimX: 1, aimY: 0 });
  simulation.updatePlayers(0.016);
  const projs = [...simulation.projectiles.values()];
  assert.equal(projs.length, 1);
  const p = projs[0];
  assert.equal(p.weaponKind, "tempestCoil");
  assert.equal(p.damageType, "lightning");
  assert.equal(p.pierce, 3);
  assert.equal(p.tempestArcs, 2);
  assert.ok(p.tempestRange > 0);
  assert.ok(p.tempestDamageMultiplier > 0);
  assert.equal(p.shockMagnitudeBonus, 0);
});

test("Overcharge chain requires its prerequisite", () => {
  const o1 = upgrade("overcharge-1");
  const o2 = upgrade("overcharge-2");
  const o3 = upgrade("overcharge-3");
  const coil = upgrade("tempest-coil");
  assert.equal(o1.requires, "tempest-coil");
  assert.equal(o2.requires, "overcharge-1");
  assert.equal(o3.requires, "overcharge-2");
  assert.equal(coil.requires, undefined);
});

test("Overcharge I deepens the Tempest Coil chain and scales hop damage", () => {
  const simulation = new GameSimulation({ seed: 21 });
  const player = resetArena(simulation);
  upgrade("tempest-coil").apply(player);
  upgrade("overcharge-1").apply(player);
  player.cooldown = 999;
  player.tempestCoilCooldown = 0;
  simulation.inputs.set(player.id, { moveX: 0, moveY: 0, aimX: 1, aimY: 0 });
  simulation.updatePlayers(0.016);
  const p = [...simulation.projectiles.values()][0];
  assert.equal(p.tempestArcs, 4);
  assert.ok(p.tempestDamageMultiplier > 0.6, `expected boosted hop dmg, got ${p.tempestDamageMultiplier}`);
});

test("Overcharge II adds shock+sap magnitude bonuses to Tempest Coil hits", () => {
  const simulation = new GameSimulation({ seed: 22 });
  const player = resetArena(simulation);
  upgrade("tempest-coil").apply(player);
  upgrade("overcharge-1").apply(player);
  upgrade("overcharge-2").apply(player);
  player.cooldown = 999;
  player.tempestCoilCooldown = 0;
  simulation.inputs.set(player.id, { moveX: 0, moveY: 0, aimX: 1, aimY: 0 });
  simulation.updatePlayers(0.016);
  const p = [...simulation.projectiles.values()][0];
  assert.ok(p.shockMagnitudeBonus > 0);
  assert.ok(p.sapMagnitudeBonus > 0);
});

test("Tempest Coil chain caps depth and never re-hits the same target", () => {
  const simulation = new GameSimulation({ seed: 31 });
  const player = resetArena(simulation);
  upgrade("tempest-coil").apply(player);
  upgrade("overcharge-1").apply(player);
  // Place a string of targets within tempestRange of each other.
  const enemies = [];
  for (let i = 0; i < 8; i += 1) {
    const e = createEnemy(`chain-${i}`, "drone", 100 + i * 60, 0, 1);
    e.maxHp = 9999;
    e.hp = 9999;
    simulation.enemies.set(e.id, e);
    enemies.push(e);
  }
  // Build a fake projectile and detonate the chain directly.
  const proj = {
    ownerId: player.id,
    damage: 30,
    weaponKind: "tempestCoil",
    tempestArcs: 4,
    tempestRange: 190,
    tempestDamageMultiplier: 0.7,
  };
  const before = enemies.map((e) => e.hp);
  simulation.tempestCoilChainDamage(proj, enemies[0]);
  const damaged = enemies.filter((e, i) => e.hp < before[i]);
  // First enemy is the primary; chain should hit at most 4 additional, all
  // distinct, and never re-hit the primary.
  assert.ok(damaged.length <= 4, `chain hit ${damaged.length} additional, expected <=4`);
  assert.equal(enemies[0].hp, before[0], "chain must not re-hit the primary target");
  // No target should have lost more than one hop's worth of HP.
  for (let i = 1; i < enemies.length; i += 1) {
    const hpDelta = before[i] - enemies[i].hp;
    const oneHop = proj.damage * proj.tempestDamageMultiplier;
    assert.ok(hpDelta <= oneHop + 0.001, `enemy ${i} took ${hpDelta}, more than one hop ${oneHop}`);
  }
});

test("Overcharge III triggers a single static discharge on shocked-kill", () => {
  const simulation = new GameSimulation({ seed: 41 });
  const player = resetArena(simulation);
  upgrade("tempest-coil").apply(player);
  upgrade("overcharge-1").apply(player);
  upgrade("overcharge-2").apply(player);
  upgrade("overcharge-3").apply(player);
  const center = createEnemy("dc-center", "drone", 0, 0, 1);
  center.maxHp = 50;
  center.hp = 1;
  center.ailments = { shock: { remaining: 2, magnitude: 0.4, ownerId: player.id } };
  simulation.enemies.set(center.id, center);
  const neighbour = createEnemy("dc-near", "drone", 40, 0, 1);
  neighbour.maxHp = 200;
  neighbour.hp = 200;
  simulation.enemies.set(neighbour.id, neighbour);
  const farAway = createEnemy("dc-far", "drone", 9999, 0, 1);
  farAway.maxHp = 200;
  farAway.hp = 200;
  simulation.enemies.set(farAway.id, farAway);
  // Kill center with a lightning hit attributed to player.
  simulation.damageEnemy(center, 100, {
    ownerId: player.id,
    x: -10,
    y: 0,
    vx: 1,
    vy: 0,
    damageType: "lightning",
    damageBreakdown: { lightning: 100 },
  });
  assert.ok(neighbour.hp < 200, "neighbour should take static discharge damage");
  assert.equal(farAway.hp, 200, "out-of-range enemy should be untouched");
});

test("Static discharge does not fire on un-shocked deaths", () => {
  const simulation = new GameSimulation({ seed: 42 });
  const player = resetArena(simulation);
  upgrade("tempest-coil").apply(player);
  upgrade("overcharge-1").apply(player);
  upgrade("overcharge-2").apply(player);
  upgrade("overcharge-3").apply(player);
  const center = createEnemy("nd-center", "drone", 0, 0, 1);
  center.maxHp = 50;
  center.hp = 1;
  center.ailments = {};
  simulation.enemies.set(center.id, center);
  const neighbour = createEnemy("nd-near", "drone", 40, 0, 1);
  neighbour.maxHp = 200;
  neighbour.hp = 200;
  simulation.enemies.set(neighbour.id, neighbour);
  simulation.damageEnemy(center, 100, {
    ownerId: player.id,
    x: -10,
    y: 0,
    vx: 1,
    vy: 0,
    damageType: "physical",
  });
  assert.equal(neighbour.hp, 200, "no shock => no discharge");
});
