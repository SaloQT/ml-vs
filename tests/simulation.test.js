import test from "node:test";
import assert from "node:assert/strict";

import { PLAYER_BASE } from "../src/config.js";
import { createEnemy, createProjectile } from "../src/entities.js";
import { asymptoticEffect } from "../src/metaProgression.js";
import { GameSimulation } from "../src/simulation.js";

function approxEq(a, b, eps = 1e-6) {
  assert.ok(Math.abs(a - b) < eps, `expected ${a} ≈ ${b}`);
}

function deterministicSummary(simulation) {
  const snapshot = simulation.getSnapshot();
  return {
    tick: snapshot.tick,
    elapsed: Number(snapshot.elapsed.toFixed(6)),
    state: snapshot.state,
    wave: snapshot.wave,
    players: snapshot.players.map((player) => ({
      id: player.id,
      x: Number(player.x.toFixed(6)),
      y: Number(player.y.toFixed(6)),
      hp: Number(player.hp.toFixed(6)),
      facingX: Number(player.facingX.toFixed(6)),
      facingY: Number(player.facingY.toFixed(6)),
      cooldown: Number(player.cooldown.toFixed(6)),
      kills: player.kills,
      level: player.level,
      xp: Number(player.xp.toFixed(6)),
    })),
    enemies: snapshot.enemies.map((enemy) => ({
      id: enemy.id,
      type: enemy.type,
      x: Number(enemy.x.toFixed(6)),
      y: Number(enemy.y.toFixed(6)),
      hp: Number(enemy.hp.toFixed(6)),
    })),
    projectiles: snapshot.projectiles.map((projectile) => ({
      id: projectile.id,
      ownerId: projectile.ownerId,
      x: Number(projectile.x.toFixed(6)),
      y: Number(projectile.y.toFixed(6)),
      damage: Number(projectile.damage.toFixed(6)),
      ttl: Number(projectile.ttl.toFixed(6)),
    })),
    pickups: snapshot.pickups.map((pickup) => ({
      id: pickup.id,
      type: pickup.type,
      x: Number(pickup.x.toFixed(6)),
      y: Number(pickup.y.toFixed(6)),
      value: pickup.value,
    })),
  };
}

function runScriptedSimulation(seed) {
  const simulation = new GameSimulation({ seed });
  const inputs = [
    { moveX: 1, moveY: 0 },
    { moveX: 0.25, moveY: 0.9 },
    { moveX: -0.8, moveY: 0.1 },
    { moveX: 0, moveY: -1 },
  ];

  for (let i = 0; i < 180; i += 1) {
    simulation.applyInput("p1", inputs[i % inputs.length]);
    simulation.step(1 / 60);
  }

  return deterministicSummary(simulation);
}

test("fixed seeds produce deterministic simulation snapshots", () => {
  assert.deepEqual(runScriptedSimulation(12345), runScriptedSimulation(12345));
  assert.notDeepEqual(runScriptedSimulation(12345), runScriptedSimulation(54321));
});

test("projectile kills create rewards without applying contact damage", () => {
  const simulation = new GameSimulation({ seed: 7 });
  const player = simulation.players.get("p1");
  player.x = 0;
  player.y = 0;
  player.hp = player.stats.maxHp;
  player.cooldown = 999;
  simulation.enemies.clear();
  simulation.projectiles.clear();
  simulation.pickups.clear();
  simulation.effects.clear();

  const enemy = createEnemy("enemy-1", "drone", 120, 0, 1);
  enemy.hp = 10;
  enemy.maxHp = 10;
  simulation.enemies.set(enemy.id, enemy);
  simulation.projectiles.set("projectile-1", createProjectile("projectile-1", "p1", 120, 0, 0, 0, 10, 5, 1));

  simulation.updateProjectiles(0);

  assert.equal(simulation.enemies.has(enemy.id), false);
  assert.equal(simulation.projectiles.has("projectile-1"), false);
  assert.equal(player.hp, player.stats.maxHp);
  assert.equal(player.kills, 1);
  assert.equal(simulation.pickups.size, 1);
  assert.equal([...simulation.pickups.values()][0].type, "xp");
});

test("enemy contact damages the player without counting as a projectile kill", () => {
  const simulation = new GameSimulation({ seed: 8 });
  const player = simulation.players.get("p1");
  player.x = 0;
  player.y = 0;
  player.hp = player.stats.maxHp;
  player.invulnerableFor = 0;
  player.cooldown = 999;
  simulation.enemies.clear();
  simulation.projectiles.clear();
  simulation.pickups.clear();
  simulation.effects.clear();

  const enemy = createEnemy("enemy-1", "drone", player.radius + 5, 0, 1);
  simulation.enemies.set(enemy.id, enemy);

  simulation.updateEnemies(0);

  assert.equal(player.hp, player.stats.maxHp - Math.max(1, enemy.damage - (player.stats.armor ?? 0)));
  assert.equal(player.invulnerableFor, PLAYER_BASE.invulnerability);
  assert.equal(simulation.enemies.has(enemy.id), true);
  assert.equal(player.kills, 0);
  assert.equal(simulation.pickups.size, 0);
});

test("level-up upgrade choice pauses stepping and choosing resumes play", () => {
  const simulation = new GameSimulation({ seed: 99 });
  const player = simulation.players.get("p1");

  simulation.gainXp(player, player.nextLevelXp);

  assert.equal(simulation.state, "upgrade");
  assert.equal(player.level, 2);
  assert.equal(simulation.pendingUpgradeChoices.length, 3);

  const pausedTick = simulation.tick;
  const pausedElapsed = simulation.elapsed;
  simulation.step(1);
  assert.equal(simulation.tick, pausedTick);
  assert.equal(simulation.elapsed, pausedElapsed);

  const chosenUpgrade = simulation.pendingUpgradeChoices[0];
  simulation.chooseUpgrade(chosenUpgrade.id);

  assert.equal(simulation.state, "playing");
  assert.equal(simulation.pendingUpgradeChoices.length, 0);
  assert.equal(player.ownedUpgrades.has(chosenUpgrade.id), true);
  assert.equal(player.upgradeStacks.get(chosenUpgrade.id), 1);

  simulation.step(1 / 60);
  assert.equal(simulation.tick, pausedTick + 1);
  assert.equal(simulation.elapsed, pausedElapsed + 1 / 60);
});

test("meta progression and equipment are applied to starting player stats", () => {
  const simulation = new GameSimulation({
    seed: 11,
    metaProgress: {
      upgrades: {
        "reinforced-hull": 2,
        "combat-drills": 3,
        "reactor-tuning": 4,
        "nav-school": 2,
      },
      equipment: {
        weapon: "rail-cannon",
        hull: "bulwark-frame",
        utility: "targeting-suite",
      },
    },
  });
  const player = simulation.players.get("p1");

  const hullBonus = asymptoticEffect(2, 80, 0.13863);
  const damageBonus = asymptoticEffect(3, 0.60, 0.12344);
  const fireRateBonus = asymptoticEffect(4, 0.40, 0.23368);
  const speedBonus = asymptoticEffect(2, 0.25, 0.28443);
  approxEq(player.stats.maxHp, PLAYER_BASE.maxHp + hullBonus + 28);
  assert.equal(player.hp, player.stats.maxHp);
  assert.equal(player.stats.armor, 3);
  assert.equal(player.stats.pickupRadius, PLAYER_BASE.pickupRadius);
  assert.equal(player.stats.critChance, 0.04 + 0.08);
  approxEq(player.stats.damage, 24 * (1 + damageBonus) * 1.35);
  approxEq(player.stats.fireRate, (1 + fireRateBonus) * 0.76);
  approxEq(player.stats.speed, PLAYER_BASE.speed * (1 + speedBonus) * 0.92);
});
