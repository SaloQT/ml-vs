import test from "node:test";
import assert from "node:assert/strict";

import { createEnemy, createPickup } from "../src/entities.js";
import { calculateRunScrap } from "../src/metaProgression.js";
import { GameSimulation } from "../src/simulation.js";

function resetArena(simulation) {
  const player = simulation.players.get("p1");
  player.x = 0;
  player.y = 0;
  player.cooldown = 999;
  simulation.enemies.clear();
  simulation.projectiles.clear();
  simulation.pickups.clear();
  simulation.effects.clear();
  return player;
}

test("enemy drop rolls create deterministic pickup variety", () => {
  const cases = [
    { seed: 438, enemyType: "drone", expectedType: "cache" },
    { seed: 361, enemyType: "drone", expectedType: "overdrive" },
    { seed: 196, enemyType: "drone", expectedType: "magnet" },
    { seed: 20, enemyType: "drone", expectedType: "shield" },
    { seed: 32, enemyType: "drone", expectedType: "scrap" },
    { seed: 245, enemyType: "drone", expectedType: "xp" },
    { seed: 438, enemyType: "bruiser", expectedType: "repair" },
  ];

  for (const { seed, enemyType, expectedType } of cases) {
    const simulation = new GameSimulation({ seed });
    const enemy = createEnemy("enemy-1", enemyType, 12, -8, 1);
    const pickup = simulation.createEnemyDrop(enemy, simulation.players.get("p1"));

    assert.equal(pickup.type, expectedType, `seed ${seed} should create ${expectedType}`);
    assert.equal(pickup.kind, "pickup");
    assert.equal(pickup.x, enemy.x);
    assert.equal(pickup.y, enemy.y);
    assert.ok(pickup.radius > 0);
  }
});

test("new pickup types are visible in snapshots", () => {
  const simulation = new GameSimulation({ seed: 1 });
  resetArena(simulation);
  const pickup = createPickup("cache-1", 40, -20, 24, "cache");
  simulation.pickups.set(pickup.id, pickup);

  const snapshotPickup = simulation.getSnapshot().pickups[0];

  assert.deepEqual(snapshotPickup, pickup);
  assert.equal(snapshotPickup.type, "cache");
  assert.equal(snapshotPickup.radius, 15);
});

test("collection effects apply scrap, overdrive, magnet burst, shield, and cache rewards", () => {
  const simulation = new GameSimulation({ seed: 2 });
  const player = resetArena(simulation);
  player.hp = 40;
  player.nextLevelXp = 100;

  const pickups = [
    createPickup("scrap-1", 0, 0, 7, "scrap"),
    createPickup("overdrive-1", 0, 0, 5, "overdrive"),
    createPickup("magnet-1", 0, 0, 4, "magnet"),
    createPickup("shield-1", 0, 0, 24, "shield"),
    createPickup("cache-1", 0, 0, 18, "cache"),
    createPickup("repair-1", 0, 0, 30, "repair"),
  ];
  for (const pickup of pickups) simulation.pickups.set(pickup.id, pickup);

  simulation.updatePickups(0);

  assert.equal(simulation.pickups.size, 0);
  assert.equal(player.scrap, 25);
  assert.equal(player.overdriveFor, 5);
  assert.equal(player.magnetBurstFor, 4);
  assert.equal(player.shield, 24);
  assert.equal(player.hp, 70);
  assert.equal(player.xp, 6);
  assert.deepEqual(
    [...simulation.effects.values()].map((effect) => effect.type).sort(),
    ["cacheOpened", "magnetBurst", "overdrive"],
  );
});

test("shield pickups absorb contact damage before hull", () => {
  const simulation = new GameSimulation({ seed: 3 });
  const player = resetArena(simulation);
  player.hp = player.stats.maxHp;
  player.shield = 10;
  player.invulnerableFor = 0;

  const enemy = createEnemy("enemy-1", "bruiser", player.radius + 4, 0, 1);
  simulation.enemies.set(enemy.id, enemy);

  simulation.updateEnemies(0);

  assert.equal(player.shield, 0);
  assert.equal(player.hp, player.stats.maxHp - (enemy.damage - 10));
});

test("collected scrap contributes to end-of-run scrap reward", () => {
  const simulation = new GameSimulation({ seed: 4 });
  const player = resetArena(simulation);
  player.scrap = 23;
  player.kills = 2;
  simulation.elapsed = 10;

  assert.equal(calculateRunScrap(simulation.getSnapshot()), 38);
});
