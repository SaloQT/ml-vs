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

test("swift elite enemies weave while chasing instead of moving straight in", () => {
  const simulation = new GameSimulation({ seed: 23 });
  const player = resetArena(simulation);
  player.x = 0;
  player.y = 0;

  const swift = createEnemy("swift-1", "drone", -100, 0, 3, { eliteAffix: "swift" });
  simulation.enemies.set(swift.id, swift);

  simulation.updateEnemies(0.25);

  assert.equal(swift.eliteAffix, "swift");
  assert.ok(swift.x > -100, "swift enemy should still close distance on the target");
  assert.notEqual(Number(swift.y.toFixed(6)), 0);
  assert.ok(swift.strafePhase > 0);
});
