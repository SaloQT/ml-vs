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
