import test from "node:test";
import assert from "node:assert/strict";

import { createEnemy } from "../src/entities.js";
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

test("splitter enemies spawn deterministic shard children when destroyed", () => {
  const simulation = new GameSimulation({ seed: 21 });
  resetArena(simulation);
  simulation.wave = 4;

  const splitter = createEnemy("splitter-1", "splitter", 100, 50, simulation.wave);
  simulation.enemies.set(splitter.id, splitter);

  simulation.damageEnemy(splitter, splitter.hp, { ownerId: "p1", x: 80, y: 50, vx: 1, vy: 0 });

  const shards = [...simulation.enemies.values()];
  assert.equal(simulation.enemies.has(splitter.id), false);
  assert.equal(shards.length, 3);
  assert.deepEqual(
    shards.map((enemy) => ({
      type: enemy.type,
      splitDepth: enemy.splitDepth,
      x: Number(enemy.x.toFixed(3)),
      y: Number(enemy.y.toFixed(3)),
      hitSpeed: Number(Math.hypot(enemy.hitVx, enemy.hitVy).toFixed(3)),
    })),
    [
      { type: "shard", splitDepth: 1, x: 111.387, y: 75.58, hitSpeed: 80 },
      { type: "shard", splitDepth: 1, x: 72.154, y: 47.071, hitSpeed: 80 },
      { type: "shard", splitDepth: 1, x: 116.46, y: 27.349, hitSpeed: 80 },
    ],
  );
  assert.equal([...simulation.pickups.values()][0].value, splitter.xp);
});

test("armored elite enemies mitigate incoming damage and expose affix state", () => {
  const simulation = new GameSimulation({ seed: 22 });
  resetArena(simulation);

  const armored = createEnemy("armored-1", "drone", 120, 0, 3, { eliteAffix: "armored" });
  simulation.enemies.set(armored.id, armored);
  const startingHp = armored.hp;

  simulation.damageEnemy(armored, 10, { ownerId: "p1", x: 100, y: 0, vx: 1, vy: 0 });

  assert.equal(armored.eliteAffix, "armored");
  assert.equal(armored.armor, 6);
  assert.equal(armored.hp, startingHp - 4);
  assert.equal(simulation.getSnapshot().enemies[0].eliteAffix, "armored");
});

test("hasted elite enemies weave while chasing instead of moving straight in", () => {
  const simulation = new GameSimulation({ seed: 23 });
  const player = resetArena(simulation);
  player.x = 0;
  player.y = 0;

  const hasted = createEnemy("hasted-1", "drone", -100, 0, 3, { affixes: ["hasted"] });
  simulation.enemies.set(hasted.id, hasted);

  simulation.updateEnemies(0.25);

  assert.deepEqual(hasted.affixes, ["hasted"]);
  assert.equal(hasted.eliteAffix, "hasted");
  assert.ok(hasted.x > -100, "hasted enemy should still close distance on the target");
  assert.notEqual(Number(hasted.y.toFixed(6)), 0);
  assert.ok(hasted.strafePhase > 0);
});

test("rare enemies can stack distinct affixes and regenerate", () => {
  const simulation = new GameSimulation({ seed: 24 });
  resetArena(simulation);

  const rare = createEnemy("rare-1", "bulwark", 160, 0, 8, { affixes: ["armored", "regenerating", "hasted"] });
  simulation.enemies.set(rare.id, rare);
  rare.hp -= 20;
  const damagedHp = rare.hp;

  simulation.updateEnemies(0.5);

  assert.equal(rare.rarity, "rare");
  assert.deepEqual(rare.affixes, ["armored", "regenerating", "hasted"]);
  assert.equal(rare.eliteAffix, "armored");
  assert.ok(rare.armor >= 6);
  assert.ok(rare.regenPerSecond > 0);
  assert.ok(rare.hp > damagedHp);
  assert.ok(rare.hp <= rare.maxHp);
});

test("volatile affix creates a distinguishable burst and damages nearby players on death", () => {
  const simulation = new GameSimulation({ seed: 25 });
  const player = resetArena(simulation);
  player.x = 0;
  player.y = 0;
  player.invulnerableFor = 0;

  const volatile = createEnemy("volatile-1", "stalker", 40, 0, 7, { affixes: ["volatile"] });
  simulation.enemies.set(volatile.id, volatile);

  simulation.damageEnemy(volatile, volatile.hp, { ownerId: "p1", x: 20, y: 0, vx: 1, vy: 0 });

  assert.equal(simulation.enemies.has(volatile.id), false);
  assert.ok(player.hp < player.stats.maxHp);
  assert.ok([...simulation.effects.values()].some((effect) => effect.type === "volatileBurst"));
});

test("charger enemies lock into a burst line and cover extra ground", () => {
  const simulation = new GameSimulation({ seed: 26 });
  const player = resetArena(simulation);
  player.x = 0;
  player.y = 0;

  const charger = createEnemy("charger-1", "charger", -220, 0, 5);
  simulation.enemies.set(charger.id, charger);

  simulation.updateEnemies(0.25);

  assert.equal(charger.type, "charger");
  assert.ok(charger.chargeFor > 0, "charger should enter its burst state inside charge range");
  assert.ok(charger.chargeCooldown > 0, "charger should start a cooldown after committing");
  assert.ok(charger.x > -220 + charger.speed * 0.25 * 2.5, "charge burst should move much faster than base speed");
  assert.equal(Number(charger.chargeDirY.toFixed(6)), 0);
});

test("siphon enemies drain shields first, then heal from nearby players", () => {
  const simulation = new GameSimulation({ seed: 27 });
  const player = resetArena(simulation);
  player.x = 0;
  player.y = 0;
  player.shield = 3;

  const siphon = createEnemy("siphon-1", "siphon", 100, 0, 6);
  simulation.enemies.set(siphon.id, siphon);
  siphon.hp -= 20;
  const damagedHp = siphon.hp;

  simulation.updateEnemies(1);

  assert.equal(player.shield, 0);
  assert.equal(player.hp, player.stats.maxHp - 4);
  assert.ok(siphon.hp > damagedHp, "siphon should convert the drain into healing");
  assert.ok(siphon.hp <= siphon.maxHp);
});

test("warden enemies grant nearby allies an armor aura without shielding themselves", () => {
  const simulation = new GameSimulation({ seed: 28 });
  resetArena(simulation);

  const warden = createEnemy("warden-1", "warden", 0, 0, 8);
  const guarded = createEnemy("guarded-1", "drone", 120, 0, 8);
  const isolated = createEnemy("isolated-1", "drone", 360, 0, 8);
  simulation.enemies.set(warden.id, warden);
  simulation.enemies.set(guarded.id, guarded);
  simulation.enemies.set(isolated.id, isolated);

  simulation.damageEnemy(guarded, 12, { ownerId: "p1", x: 90, y: 0, vx: 1, vy: 0 });
  simulation.damageEnemy(isolated, 12, { ownerId: "p1", x: 330, y: 0, vx: 1, vy: 0 });
  simulation.damageEnemy(warden, 12, { ownerId: "p1", x: -30, y: 0, vx: 1, vy: 0 });

  assert.equal(guarded.hp, guarded.maxHp - 7);
  assert.equal(isolated.hp, isolated.maxHp - 12);
  assert.equal(warden.hp, warden.maxHp - 12);
});
