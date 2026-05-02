import test from "node:test";
import assert from "node:assert/strict";

import { RUN_EVENTS } from "../src/config.js";
import { GameSimulation } from "../src/simulation.js";

test("run events default on for visible runs and off for headless unless explicitly enabled", () => {
  assert.equal(new GameSimulation({ seed: 1 }).getSnapshot().runEvents.enabled, true);
  assert.equal(new GameSimulation({ seed: 1, headless: true }).getSnapshot().runEvents.enabled, false);
  assert.equal(new GameSimulation({ seed: 1, localPlayerId: "ppo" }).getSnapshot().runEvents.enabled, true);
  assert.equal(new GameSimulation({ seed: 1, headless: true, enableRunEvents: true }).getSnapshot().runEvents.enabled, true);
});

test("run event scheduler is deterministic for fixed seeds", () => {
  const first = new GameSimulation({ seed: 123, enableRunEvents: true });
  const second = new GameSimulation({ seed: 123, enableRunEvents: true });
  for (let i = 0; i < 1600; i += 1) {
    first.step(1 / 60);
    second.step(1 / 60);
  }

  assert.deepEqual(first.getSnapshot().runEvents, second.getSnapshot().runEvents);
});

test("upgrade pause stops run event progression", () => {
  const simulation = new GameSimulation({ seed: 2, enableRunEvents: true });
  const player = simulation.players.get("p1");
  simulation.runEvents.nextAt = simulation.elapsed + 0.5;
  simulation.gainXp(player, player.nextLevelXp);

  const pausedRunEvents = simulation.getSnapshot().runEvents;
  simulation.step(2);

  assert.equal(simulation.state, "upgrade");
  assert.deepEqual(simulation.getSnapshot().runEvents, pausedRunEvents);
});

test("lane sweep damages players inside the telegraphed lane once", () => {
  const simulation = new GameSimulation({ seed: 3, enableRunEvents: false });
  const player = simulation.players.get("p1");
  player.x = 0;
  player.y = 0;
  player.invulnerableFor = 0;
  const event = {
    id: "run-event-test",
    type: RUN_EVENTS.laneSweep.id,
    label: RUN_EVENTS.laneSweep.label,
    x: 0,
    y: 0,
    dirX: 1,
    dirY: 0,
    normalX: 0,
    normalY: 1,
    width: RUN_EVENTS.laneSweep.width,
    length: RUN_EVENTS.laneSweep.length,
    damage: RUN_EVENTS.laneSweep.damage,
    startedAt: 0,
    triggerAt: 1,
    endAt: 2,
    damagedPlayerIds: [],
  };

  simulation.elapsed = 1;
  simulation.updateLaneSweep(event);
  simulation.updateLaneSweep(event);

  assert.equal(player.hp, player.stats.maxHp - Math.max(1, RUN_EVENTS.laneSweep.damage - (player.stats.armor ?? 0)));
  assert.deepEqual(event.damagedPlayerIds, ["p1"]);
});

test("reward cache event creates a collectible cache after its telegraph", () => {
  const simulation = new GameSimulation({ seed: 4, enableRunEvents: true });
  simulation.pickRunEventType = () => RUN_EVENTS.rewardCache.id;
  simulation.pickups.clear();
  simulation.runEvents.nextAt = 0;

  simulation.updateRunEvents(0);
  assert.equal(simulation.runEvents.active.length, 1);
  assert.equal(simulation.pickups.size, 0);

  simulation.elapsed = simulation.runEvents.active[0].triggerAt;
  simulation.updateRunEvents(0);

  const [pickup] = [...simulation.pickups.values()];
  assert.equal(pickup.type, "cache");
  assert.equal(pickup.value, RUN_EVENTS.rewardCache.value);
  assert.equal(simulation.runEvents.active[0].pickupId, pickup.id);
  assert.equal(simulation.runEvents.active[0].collectedAt, null);
});

test("reward cache event collapses after its pickup is collected", () => {
  const simulation = new GameSimulation({ seed: 5, enableRunEvents: true });
  const player = simulation.players.get("p1");
  simulation.pickRunEventType = () => RUN_EVENTS.rewardCache.id;
  simulation.pickups.clear();
  simulation.runEvents.nextAt = 0;
  simulation.updateRunEvents(0);

  const event = simulation.runEvents.active[0];
  simulation.elapsed = event.triggerAt;
  simulation.updateRunEvents(0);
  const pickup = [...simulation.pickups.values()][0];
  player.x = pickup.x;
  player.y = pickup.y;
  simulation.updatePickups(0);

  assert.equal(simulation.pickups.size, 0);
  assert.equal(event.collectedAt, simulation.elapsed);
  assert.equal(event.endAt, simulation.elapsed + 0.4);
});

test("boss spawn telegraph exposes a fixed spawn point before spawning the boss", () => {
  const simulation = new GameSimulation({ seed: 6, enableRunEvents: false });
  simulation.enemies.clear();
  simulation.spawnTimer = 999;
  simulation.nextEliteSpawnAt = 999;
  simulation.elapsed = simulation.nextBossSpawnAt - 2.5;

  simulation.updateSpawning(0);
  const telegraph = simulation.getSnapshot().bossSpawnTelegraph;
  assert.equal(telegraph.bossId, "brood-splitter");
  assert.equal(telegraph.triggerAt, 135);
  assert.equal(telegraph.duration, 2.5);
  assert.equal(simulation.enemies.size, 0);

  simulation.elapsed = telegraph.triggerAt;
  simulation.updateSpawning(0);
  const [boss] = [...simulation.enemies.values()];
  assert.equal(boss.bossId, telegraph.bossId);
  assert.equal(boss.x, telegraph.x);
  assert.equal(boss.y, telegraph.y);
  assert.equal(simulation.getSnapshot().bossSpawnTelegraph, null);
  assert.ok([...simulation.effects.values()].some((effect) => effect.type === "bossSpawnBurst"));
});
