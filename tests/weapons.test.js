import test from "node:test";
import assert from "node:assert/strict";

import { createEnemy, createProjectile } from "../src/entities.js";
import { GameSimulation } from "../src/simulation.js";
import { UPGRADE_POOL } from "../src/upgrades.js";

function resetCombat(simulation) {
  const player = simulation.players.get("p1");
  player.x = 0;
  player.y = 0;
  player.hp = player.stats.maxHp;
  player.cooldown = 999;
  player.kills = 0;
  simulation.enemies.clear();
  simulation.projectiles.clear();
  simulation.pickups.clear();
  simulation.effects.clear();
  return player;
}

function addEnemy(simulation, id, x, y, hp = 20) {
  const enemy = createEnemy(id, "drone", x, y, 1);
  enemy.hp = hp;
  enemy.maxHp = hp;
  simulation.enemies.set(enemy.id, enemy);
  return enemy;
}

test("phase lance upgrade enables and scales projectile pierce", () => {
  const simulation = new GameSimulation({ seed: 14 });
  const player = resetCombat(simulation);
  const upgrade = UPGRADE_POOL.find((item) => item.id === "phase-lance");

  upgrade.apply(player);
  upgrade.apply(player);

  assert.equal(player.stats.projectilePierce, 2);
  assert.equal(Number(player.stats.projectileTtl.toFixed(6)), Number((1.4 * 1.08 * 1.08).toFixed(6)));
});

test("piercing projectile kills multiple enemies and survives until pierce is spent", () => {
  const simulation = new GameSimulation({ seed: 15 });
  const player = resetCombat(simulation);
  addEnemy(simulation, "enemy-1", 100, 0, 10);
  addEnemy(simulation, "enemy-2", 160, 0, 10);
  const survivor = addEnemy(simulation, "enemy-3", 220, 0, 10);
  simulation.projectiles.set(
    "projectile-1",
    createProjectile("projectile-1", "p1", 100, 0, 0, 0, 10, 5, 1, { pierce: 1 }),
  );

  simulation.updateProjectiles(0);
  assert.equal(simulation.projectiles.has("projectile-1"), true);
  assert.equal(player.kills, 1);

  const projectile = simulation.projectiles.get("projectile-1");
  projectile.x = 160;
  simulation.updateProjectiles(0);

  assert.equal(simulation.projectiles.has("projectile-1"), false);
  assert.equal(simulation.enemies.has("enemy-1"), false);
  assert.equal(simulation.enemies.has("enemy-2"), false);
  assert.equal(simulation.enemies.has(survivor.id), true);
  assert.equal(player.kills, 2);
  assert.equal(simulation.pickups.size, 2);
  assert.equal(player.hp, player.stats.maxHp);
});

test("piercing projectile does not damage the same enemy twice", () => {
  const simulation = new GameSimulation({ seed: 16 });
  resetCombat(simulation);
  const enemy = addEnemy(simulation, "enemy-1", 100, 0, 30);
  simulation.projectiles.set(
    "projectile-1",
    createProjectile("projectile-1", "p1", 100, 0, 0, 0, 10, 5, 1, { pierce: 1 }),
  );

  simulation.updateProjectiles(0);
  simulation.updateProjectiles(0);

  assert.equal(enemy.hp, 20);
  assert.equal(simulation.projectiles.has("projectile-1"), true);
});

test("arc conductor chains deterministically to nearest enemies", () => {
  const simulation = new GameSimulation({ seed: 17 });
  const player = resetCombat(simulation);
  addEnemy(simulation, "primary", 100, 0, 40);
  const near = addEnemy(simulation, "near", 150, 0, 40);
  const farther = addEnemy(simulation, "farther", 180, 0, 40);
  const outside = addEnemy(simulation, "outside", 360, 0, 40);
  simulation.projectiles.set(
    "projectile-1",
    createProjectile("projectile-1", "p1", 100, 0, 0, 0, 20, 5, 1, {
      chainArcs: 2,
      chainRange: 100,
      chainDamageMultiplier: 0.5,
    }),
  );

  simulation.updateProjectiles(0);

  assert.equal(near.hp, 30);
  assert.equal(farther.hp, 30);
  assert.equal(outside.hp, 40);
  assert.equal(player.kills, 0);
});

test("chain kills preserve projectile owner kill and pickup semantics", () => {
  const simulation = new GameSimulation({ seed: 18 });
  const player = resetCombat(simulation);
  addEnemy(simulation, "primary", 100, 0, 40);
  addEnemy(simulation, "chain-target", 150, 0, 10);
  simulation.projectiles.set(
    "projectile-1",
    createProjectile("projectile-1", "p1", 100, 0, 0, 0, 20, 5, 1, {
      chainArcs: 1,
      chainRange: 100,
      chainDamageMultiplier: 0.5,
    }),
  );

  simulation.updateProjectiles(0);

  assert.equal(simulation.enemies.has("chain-target"), false);
  assert.equal(player.kills, 1);
  assert.equal(simulation.pickups.size, 1);
  assert.equal(player.hp, player.stats.maxHp);
});
