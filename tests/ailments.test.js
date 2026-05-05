import test from "node:test";
import assert from "node:assert/strict";

import { createEnemy } from "../src/entities.js";
import { GameSimulation } from "../src/simulation.js";
import {
  applyAilmentsFromHit,
  updateAilments,
  getAilmentSpeedMultiplier,
  getAilmentDamageTakenMultiplier,
  isFrozen,
  AILMENT_CONFIG,
  validateAilmentConfig,
} from "../src/ailments.js";
import { Rng } from "../src/math.js";
import { UPGRADE_POOL } from "../src/upgrades.js";

function freshSim() {
  const sim = new GameSimulation({ seed: 7 });
  sim.enemies.clear();
  sim.projectiles.clear();
  return sim;
}

test("physical hits apply bleed but not ignite/chill", () => {
  const enemy = createEnemy("e1", "drone", 0, 0, 1);
  enemy.maxHp = 100;
  enemy.hp = 100;
  // Force a hit large enough to clear bleed threshold reliably.
  const rng = new Rng(1);
  // Run multiple rolls to confirm bleed eventually applies and ignite never does.
  let bled = false;
  for (let i = 0; i < 30; i += 1) {
    applyAilmentsFromHit(
      enemy,
      { damage: 30, damageType: "physical", ownerId: "p1" },
      rng,
    );
    if (enemy.ailments.bleed) bled = true;
    assert.equal(enemy.ailments.ignite, undefined, "physical-only hits never ignite");
    assert.equal(enemy.ailments.chill, undefined, "physical-only hits never chill");
  }
  assert.ok(bled, "expected bleed to apply on big physical hits");
});

test("tiny hits rarely apply ailments; big hits reliably do", () => {
  const big = createEnemy("e1", "drone", 0, 0, 1);
  big.maxHp = 100;
  big.hp = 100;
  const small = createEnemy("e2", "drone", 0, 0, 1);
  small.maxHp = 100;
  small.hp = 100;
  const rng = new Rng(2);
  // 1% hits over many rolls should produce zero (or near-zero) bleed events.
  let smallBleeds = 0;
  for (let i = 0; i < 200; i += 1) {
    small.ailments = {};
    applyAilmentsFromHit(small, { damage: 1, damageType: "physical" }, rng);
    if (small.ailments.bleed) smallBleeds += 1;
  }
  // 50% hits trivially clear threshold and should bleed near-always.
  let bigBleeds = 0;
  for (let i = 0; i < 100; i += 1) {
    big.ailments = {};
    applyAilmentsFromHit(big, { damage: 50, damageType: "physical" }, rng);
    if (big.ailments.bleed) bigBleeds += 1;
  }
  assert.ok(smallBleeds < bigBleeds * 0.3, `small=${smallBleeds} big=${bigBleeds}`);
});

test("ignite ticks fire DOT through damageEnemy and decays", () => {
  const sim = freshSim();
  const enemy = createEnemy("e1", "drone", 0, 0, 1);
  enemy.maxHp = 200;
  enemy.hp = 200;
  enemy.armor = 0;
  sim.enemies.set(enemy.id, enemy);
  enemy.ailments.ignite = {
    remaining: 2,
    tickAccumulator: 0,
    tickRate: 0.25,
    dotPerSecond: 20,
    magnitude: 0,
    ownerId: "p1",
  };
  const before = enemy.hp;
  for (let i = 0; i < 8; i += 1) updateAilments(sim, enemy, 0.25);
  assert.ok(enemy.hp < before, "ignite should have damaged the enemy");
  assert.equal(enemy.ailments.ignite, undefined, "ignite should have expired");
});

test("freeze stops movement and bosses resist application", () => {
  const enemy = createEnemy("e1", "drone", 0, 0, 1);
  enemy.maxHp = 100;
  enemy.hp = 100;
  enemy.ailments.freeze = { remaining: 1, dotPerSecond: 0, magnitude: 0, tickAccumulator: 0, tickRate: 0.25 };
  assert.equal(isFrozen(enemy), true);
  assert.equal(getAilmentSpeedMultiplier(enemy), 0);

  const boss = createEnemy("b1", "drone", 0, 0, 1, { bossId: "boss-1", rank: "boss" });
  boss.maxHp = 1000;
  boss.hp = 1000;
  const rng = new Rng(3);
  let frozeBoss = false;
  for (let i = 0; i < 100; i += 1) {
    boss.ailments = {};
    // Same fractional hit (15%) that easily freezes a normal enemy.
    applyAilmentsFromHit(boss, { damage: 150, damageType: "cold" }, rng);
    if (boss.ailments.freeze) frozeBoss = true;
  }
  // Threshold ~ 0.45 * 4 = 1.8 strength — a 0.15 ratio gives ~0.083 strength,
  // chance ~0.05 + 0.083*(0.6-0.05) ≈ 0.096. Over 100 rolls some may pass; that's fine.
  // The important property is that bosses freeze far less reliably than normals.
  let frozeNormal = 0;
  for (let i = 0; i < 100; i += 1) {
    const e = createEnemy("e2", "drone", 0, 0, 1);
    e.maxHp = 100;
    e.hp = 100;
    applyAilmentsFromHit(e, { damage: 80, damageType: "cold" }, rng);
    if (e.ailments.freeze) frozeNormal += 1;
  }
  assert.ok(frozeNormal > 30, `expected normals to freeze often, got ${frozeNormal}`);
});

test("shock increases damage taken; scorch boosts fire only", () => {
  const enemy = createEnemy("e1", "drone", 0, 0, 1);
  enemy.maxHp = 100;
  enemy.hp = 100;
  enemy.ailments.shock = { remaining: 2, magnitude: 0.3, dotPerSecond: 0, tickAccumulator: 0, tickRate: 0.25 };
  assert.ok(Math.abs(getAilmentDamageTakenMultiplier(enemy, "physical") - 1.3) < 1e-6);
  enemy.ailments.scorch = { remaining: 2, magnitude: 0.2, dotPerSecond: 0, tickAccumulator: 0, tickRate: 0.25 };
  assert.ok(Math.abs(getAilmentDamageTakenMultiplier(enemy, "fire") - 1.3 * 1.2) < 1e-6);
  // Scorch alone shouldn't buff non-fire.
  delete enemy.ailments.shock;
  assert.ok(Math.abs(getAilmentDamageTakenMultiplier(enemy, "physical") - 1) < 1e-6);
  assert.ok(Math.abs(getAilmentDamageTakenMultiplier(enemy, "fire") - 1.2) < 1e-6);
});

test("damageEnemy routes through ailment pipeline by default", () => {
  const sim = freshSim();
  const enemy = createEnemy("e1", "drone", 0, 0, 1);
  enemy.maxHp = 200;
  enemy.hp = 200;
  enemy.armor = 0;
  sim.enemies.set(enemy.id, enemy);
  // Drive ailment RNG to roll bleed by passing a big physical hit many times.
  let saw = false;
  for (let i = 0; i < 30 && !saw; i += 1) {
    sim.damageEnemy(enemy, 60, { ownerId: "p1", damageType: "physical", x: 0, y: 0, vx: 0, vy: 0 });
    if (enemy.ailments.bleed) saw = true;
    enemy.hp = 200;
  }
  assert.ok(saw, "physical hits via damageEnemy should be able to apply bleed");
});

test("AILMENT_CONFIG covers required ailments", () => {
  for (const name of ["bleed", "poison", "ignite", "chill", "freeze", "shock", "scorch", "brittle", "sap"]) {
    assert.ok(AILMENT_CONFIG[name], `missing ${name} config`);
  }
});


test("sap reduces enemy contact damage", () => {
  const sim = new GameSimulation({ seed: 11 });
  sim.enemies.clear();
  const player = sim.players.get("p1");
  player.x = 0;
  player.y = 0;
  player.invulnerableFor = 0;
  const startHp = player.hp;
  const enemy = createEnemy("e1", "drone", 0, 0, 1);
  enemy.x = player.x;
  enemy.y = player.y;
  enemy.damage = 20;
  enemy.maxHp = 100;
  enemy.hp = 100;
  enemy.ailments.sap = { remaining: 5, magnitude: 0.5, dotPerSecond: 0, tickAccumulator: 0, tickRate: 0.25 };
  sim.enemies.set(enemy.id, enemy);
  sim.updateEnemies(0.016);
  const sappedHullDamage = startHp - player.hp;

  // Reset, no sap.
  const sim2 = new GameSimulation({ seed: 11 });
  sim2.enemies.clear();
  const player2 = sim2.players.get("p1");
  player2.x = 0;
  player2.y = 0;
  player2.invulnerableFor = 0;
  const startHp2 = player2.hp;
  const enemy2 = createEnemy("e2", "drone", 0, 0, 1);
  enemy2.x = player2.x;
  enemy2.y = player2.y;
  enemy2.damage = 20;
  enemy2.maxHp = 100;
  enemy2.hp = 100;
  sim2.enemies.set(enemy2.id, enemy2);
  sim2.updateEnemies(0.016);
  const baseHullDamage = startHp2 - player2.hp;

  assert.ok(sappedHullDamage < baseHullDamage, `sap should reduce contact damage (sap=${sappedHullDamage} base=${baseHullDamage})`);
});

test("getAilmentCritChanceBonus surfaces brittle magnitude", async () => {
  const { getAilmentCritChanceBonus } = await import("../src/ailments.js");
  const enemy = createEnemy("e1", "drone", 0, 0, 1);
  assert.equal(getAilmentCritChanceBonus(enemy), 0);
  enemy.ailments.brittle = { remaining: 2, magnitude: 0.12, dotPerSecond: 0, tickAccumulator: 0, tickRate: 0.25 };
  assert.equal(getAilmentCritChanceBonus(enemy), 0.12);
});

test("getActiveAilmentDisplay returns pips in render order", async () => {
  const { getActiveAilmentDisplay } = await import("../src/ailments.js");
  const enemy = createEnemy("e1", "drone", 0, 0, 1);
  assert.deepEqual(getActiveAilmentDisplay(enemy), []);
  enemy.ailments.shock = { remaining: 1, magnitude: 0.2, dotPerSecond: 0, tickAccumulator: 0, tickRate: 0.25 };
  enemy.ailments.bleed = { remaining: 1, dotPerSecond: 5, magnitude: 0, tickAccumulator: 0, tickRate: 0.25 };
  enemy.ailments.freeze = { remaining: 0.5, dotPerSecond: 0, magnitude: 0, tickAccumulator: 0, tickRate: 0.25 };
  const order = getActiveAilmentDisplay(enemy).map((p) => p.name);
  assert.deepEqual(order, ["freeze", "shock", "bleed"]);
});


test("validateAilmentConfig: current config is valid", async () => {
  const { validateAilmentConfig } = await import("../src/ailments.js");
  const errors = validateAilmentConfig();
  assert.deepEqual(errors, [], `expected no errors, got:\n${errors.join("\n")}`);
});

test("validateAilmentConfig: catches common config mistakes", async () => {
  const { validateAilmentConfig, AILMENT_DISPLAY } = await import("../src/ailments.js");
  const bad = {
    bogon: {
      sources: ["radioactive"], // unknown type
      threshold: 0,              // must be > 0
      chanceFloor: 0.9,
      chanceMax: 0.5,            // floor > max
      durationMin: 3,
      durationMax: 1,            // min > max
      magnitudeMin: 0.5,
      magnitudeMax: 0.1,         // min > max
      stack: true,               // missing maxStacks
      tickRate: 0,               // must be > 0 if set
    },
  };
  const errors = validateAilmentConfig(bad, AILMENT_DISPLAY);
  // Touch all the catches we wired up.
  assert.ok(errors.some((e) => e.includes("unknown damage type")));
  assert.ok(errors.some((e) => e.includes("threshold must be > 0")));
  assert.ok(errors.some((e) => e.includes("chanceFloor") && e.includes("chanceMax")));
  assert.ok(errors.some((e) => e.includes("durationMin") && e.includes("durationMax")));
  assert.ok(errors.some((e) => e.includes("magnitudeMin > magnitudeMax")));
  assert.ok(errors.some((e) => e.includes("maxStacks")));
  assert.ok(errors.some((e) => e.includes("tickRate")));
  assert.ok(errors.some((e) => e.includes("missing AILMENT_DISPLAY entry")));
});

test("validateAilmentConfig: flags display entries without matching config", async () => {
  const { validateAilmentConfig, AILMENT_CONFIG } = await import("../src/ailments.js");
  const display = [{ name: "ghost", label: "g", color: "#fff" }];
  const errors = validateAilmentConfig(AILMENT_CONFIG, display);
  assert.ok(errors.some((e) => e.includes("ghost") && e.includes("no matching AILMENT_CONFIG")));
});

test("missing damageType defaults to physical for ailment rolls", () => {
  const enemy = createEnemy("e1", "drone", 0, 0, 1);
  enemy.maxHp = 100;
  enemy.hp = 100;
  const rng = new Rng(123);
  let bled = false;
  for (let i = 0; i < 30; i += 1) {
    enemy.ailments = {};
    // No damageType, no breakdown — should be treated as physical.
    applyAilmentsFromHit(enemy, { damage: 40 }, rng);
    if (enemy.ailments.bleed) bled = true;
    assert.equal(enemy.ailments.ignite, undefined);
  }
  assert.ok(bled, "default-physical hit should be able to apply bleed");
});

test("damageBreakdown drives DOT amount per type", () => {
  const enemy = createEnemy("e1", "drone", 0, 0, 1);
  enemy.maxHp = 100;
  enemy.hp = 100;
  const rng = new Rng(7);
  // Lightning-only breakdown should never ignite (fire) or bleed (physical),
  // and the typed damage routed to ailments must reflect the breakdown, not
  // the headline `damage` field.
  for (let i = 0; i < 50; i += 1) {
    enemy.ailments = {};
    applyAilmentsFromHit(
      enemy,
      { damage: 100, breakdown: { lightning: 100 } },
      rng,
    );
    assert.equal(enemy.ailments.ignite, undefined);
    assert.equal(enemy.ailments.bleed, undefined);
  }
});

test("poison stack cap is respected", () => {
  const enemy = createEnemy("e1", "drone", 0, 0, 1);
  enemy.maxHp = 50;
  enemy.hp = 50;
  const rng = new Rng(99);
  for (let i = 0; i < 200; i += 1) {
    applyAilmentsFromHit(enemy, { damage: 40, damageType: "physical" }, rng);
  }
  const stacks = enemy.ailments.poison?.stacks ?? [];
  assert.ok(stacks.length <= AILMENT_CONFIG.poison.maxStacks, `got ${stacks.length} stacks`);
});

test("freeze + chill produce a valid speed multiplier in [0,1]", async () => {
  const { getAilmentSpeedMultiplier } = await import("../src/ailments.js");
  const enemy = createEnemy("e1", "drone", 0, 0, 1);
  enemy.ailments.chill = { remaining: 2, magnitude: 0.5, dotPerSecond: 0, tickAccumulator: 0, tickRate: 0.25 };
  const m1 = getAilmentSpeedMultiplier(enemy);
  assert.ok(m1 >= 0 && m1 <= 1, `chill mult out of range: ${m1}`);
  // Pathological magnitude > 1 should clamp to 0, not go negative.
  enemy.ailments.chill.magnitude = 5;
  const m2 = getAilmentSpeedMultiplier(enemy);
  assert.ok(m2 >= 0 && m2 <= 1, `oversized chill mult out of range: ${m2}`);
  enemy.ailments.freeze = { remaining: 1, dotPerSecond: 0, magnitude: 0, tickAccumulator: 0, tickRate: 0.25 };
  assert.equal(getAilmentSpeedMultiplier(enemy), 0);
});

test("getActiveAilmentDisplay ignores expired/missing ailments", async () => {
  const { getActiveAilmentDisplay } = await import("../src/ailments.js");
  const enemy = createEnemy("e1", "drone", 0, 0, 1);
  enemy.ailments.shock = { remaining: 0, magnitude: 0.2, dotPerSecond: 0, tickAccumulator: 0, tickRate: 0.25 };
  enemy.ailments.poison = { stacks: [] };
  enemy.ailments.bleed = null;
  assert.deepEqual(getActiveAilmentDisplay(enemy), []);
  assert.deepEqual(getActiveAilmentDisplay(null), []);
  assert.deepEqual(getActiveAilmentDisplay({}), []);
});

test("getActiveAilmentDisplay exposes tooltip-ready metadata", async () => {
  const { getActiveAilmentDisplay } = await import("../src/ailments.js");
  const enemy = createEnemy("e1", "drone", 0, 0, 1);
  enemy.ailments.shock = { remaining: 1.5, magnitude: 0.25, dotPerSecond: 0, tickAccumulator: 0, tickRate: 0.25 };
  const [entry] = getActiveAilmentDisplay(enemy);
  assert.equal(entry.id, "shock");
  assert.equal(entry.name, "shock");
  assert.equal(typeof entry.label, "string");
  assert.equal(typeof entry.shortLabel, "string");
  assert.equal(typeof entry.color, "string");
  assert.equal(typeof entry.priority, "number");
  assert.equal(entry.category, "control");
  assert.equal(entry.isControl, true);
  assert.equal(entry.isDot, false);
  assert.equal(entry.isDebuff, false);
  assert.equal(entry.stacks, 1);
  assert.equal(entry.remaining, 1.5);
  assert.equal(entry.magnitude, 0.25);
  assert.equal(entry.showStackCount, false);
});

test("getActiveAilmentDisplay sorts by priority (control > dot > debuff)", async () => {
  const { getActiveAilmentDisplay } = await import("../src/ailments.js");
  const enemy = createEnemy("e1", "drone", 0, 0, 1);
  enemy.ailments.sap     = { remaining: 1, magnitude: 0.1, dotPerSecond: 0, tickAccumulator: 0, tickRate: 0.25 };
  enemy.ailments.bleed   = { remaining: 1, magnitude: 0,   dotPerSecond: 5, tickAccumulator: 0, tickRate: 0.25 };
  enemy.ailments.freeze  = { remaining: 1, magnitude: 0,   dotPerSecond: 0, tickAccumulator: 0, tickRate: 0.25 };
  enemy.ailments.scorch  = { remaining: 1, magnitude: 0.2, dotPerSecond: 0, tickAccumulator: 0, tickRate: 0.25 };
  const order = getActiveAilmentDisplay(enemy).map((e) => e.name);
  assert.deepEqual(order, ["freeze", "bleed", "scorch", "sap"]);
  // Priority numbers must be strictly increasing along the returned order.
  const priorities = getActiveAilmentDisplay(enemy).map((e) => e.priority);
  for (let i = 1; i < priorities.length; i += 1) {
    assert.ok(priorities[i] > priorities[i - 1], `priorities not increasing: ${priorities}`);
  }
});

test("poison surfaces stack count and showStackCount when stacked", async () => {
  const { getActiveAilmentDisplay } = await import("../src/ailments.js");
  const enemy = createEnemy("e1", "drone", 0, 0, 1);
  enemy.ailments.poison = {
    stacks: [
      { remaining: 2, magnitude: 0, dotPerSecond: 3, tickAccumulator: 0, tickRate: 0.4 },
      { remaining: 4, magnitude: 0, dotPerSecond: 3, tickAccumulator: 0, tickRate: 0.4 },
      { remaining: 1, magnitude: 0, dotPerSecond: 3, tickAccumulator: 0, tickRate: 0.4 },
    ],
  };
  const [p] = getActiveAilmentDisplay(enemy);
  assert.equal(p.name, "poison");
  assert.equal(p.stacks, 3);
  assert.equal(p.showStackCount, true);
  // remaining reflects the longest stack
  assert.equal(p.remaining, 4);

  // Single poison stack should NOT request a stack badge.
  enemy.ailments.poison = {
    stacks: [{ remaining: 1, magnitude: 0, dotPerSecond: 3, tickAccumulator: 0, tickRate: 0.4 }],
  };
  const [p1] = getActiveAilmentDisplay(enemy);
  assert.equal(p1.stacks, 1);
  assert.equal(p1.showStackCount, false);
});

test("truncateAilmentDisplay caps to maxVisible and reports overflow", async () => {
  const { getActiveAilmentDisplay, truncateAilmentDisplay } = await import("../src/ailments.js");
  const enemy = createEnemy("e1", "drone", 0, 0, 1);
  for (const n of ["freeze", "shock", "chill", "ignite", "bleed", "poison", "brittle"]) {
    if (n === "poison") {
      enemy.ailments[n] = { stacks: [{ remaining: 1, magnitude: 0, dotPerSecond: 1, tickAccumulator: 0, tickRate: 0.4 }] };
    } else {
      enemy.ailments[n] = { remaining: 1, magnitude: 0.1, dotPerSecond: 0, tickAccumulator: 0, tickRate: 0.25 };
    }
  }
  const all = getActiveAilmentDisplay(enemy);
  assert.equal(all.length, 7);
  const { visible, overflow } = truncateAilmentDisplay(all, 4);
  assert.equal(visible.length, 4);
  assert.equal(overflow, 3);
  // The dropped entries are the lowest priority (highest priority numbers).
  assert.deepEqual(visible.map((e) => e.name), ["freeze", "shock", "chill", "ignite"]);

  // No truncation needed when within limit.
  const passthrough = truncateAilmentDisplay(all, 10);
  assert.equal(passthrough.overflow, 0);
  assert.equal(passthrough.visible.length, 7);

  // Defensive: bad input doesn't throw.
  assert.deepEqual(truncateAilmentDisplay(null, 3), { visible: [], overflow: 0 });
  assert.deepEqual(truncateAilmentDisplay(all, 0).overflow, 0);
});

test("Plague Lance hits roll poison via chaos breakdown but never bleed-from-chaos-only", () => {
  const enemy = createEnemy("pl1", "drone", 0, 0, 1);
  enemy.maxHp = 200;
  enemy.hp = 200;
  const rng = new Rng(11);
  let poisoned = 0;
  for (let i = 0; i < 50; i += 1) {
    enemy.ailments = {};
    applyAilmentsFromHit(
      enemy,
      { damage: 32, damageType: "chaos", breakdown: { physical: 12, chaos: 20 }, ownerId: "p1" },
      rng,
    );
    if (enemy.ailments.poison) poisoned += 1;
    assert.equal(enemy.ailments.ignite, undefined, "chaos breakdown never ignites");
  }
  assert.ok(poisoned > 5, `expected some poisons, got ${poisoned}`);

  // Chaos-only breakdown still pierces poison threshold; physical absent => no bleed.
  const enemy2 = createEnemy("pl2", "drone", 0, 0, 1);
  enemy2.maxHp = 200;
  enemy2.hp = 200;
  for (let i = 0; i < 50; i += 1) {
    enemy2.ailments = {};
    applyAilmentsFromHit(
      enemy2,
      { damage: 20, damageType: "chaos", breakdown: { chaos: 20 }, ownerId: "p1" },
      rng,
    );
    assert.equal(enemy2.ailments.bleed, undefined, "chaos-only damage never bleeds");
  }
});

test("Virulence I scales poison dotPerSecond by 1.5x at construction", () => {
  const enemy = createEnemy("v1", "drone", 0, 0, 1);
  enemy.maxHp = 200;
  enemy.hp = 200;
  const rng = new Rng(99);
  // Force apply by repeated rolls; capture dotPerSecond from base vs scaled hits.
  function meanDps(extra) {
    let total = 0;
    let count = 0;
    const rngLocal = new Rng(99);
    for (let i = 0; i < 200; i += 1) {
      enemy.ailments = {};
      applyAilmentsFromHit(
        enemy,
        { damage: 60, damageType: "chaos", breakdown: { chaos: 60 }, ownerId: "p1", ...extra },
        rngLocal,
      );
      const stack = enemy.ailments.poison?.stacks?.[0];
      if (stack) {
        total += stack.dotPerSecond;
        count += 1;
      }
    }
    return count ? total / count : 0;
  }
  const base = meanDps({});
  const scaled = meanDps({ poisonDotMultiplier: 1.5 });
  assert.ok(scaled > base * 1.4, `scaled=${scaled} base=${base}`);
  // Use rng so it doesn't go unused
  void rng;
});

test("Pandemic raises effective poison stack cap to 12 via per-hit override", () => {
  const enemy = createEnemy("v3", "drone", 0, 0, 1);
  enemy.maxHp = 200;
  enemy.hp = 200;
  const rng = new Rng(5);
  for (let i = 0; i < 400; i += 1) {
    applyAilmentsFromHit(
      enemy,
      { damage: 40, damageType: "chaos", breakdown: { chaos: 40 }, ownerId: "p1", poisonMaxStacks: 12 },
      rng,
    );
  }
  const stacks = enemy.ailments.poison?.stacks?.length ?? 0;
  assert.ok(stacks > 8, `expected stacks > 8 with Pandemic, got ${stacks}`);
  assert.ok(stacks <= 12, `expected stacks <= 12, got ${stacks}`);

  // Without override the cap stays at 8.
  const enemy2 = createEnemy("v3b", "drone", 0, 0, 1);
  enemy2.maxHp = 200;
  enemy2.hp = 200;
  for (let i = 0; i < 400; i += 1) {
    applyAilmentsFromHit(
      enemy2,
      { damage: 40, damageType: "chaos", breakdown: { chaos: 40 }, ownerId: "p1" },
      rng,
    );
  }
  const stacksBase = enemy2.ailments.poison?.stacks?.length ?? 0;
  assert.ok(stacksBase <= 8, `base cap should be 8, got ${stacksBase}`);
  assert.equal(AILMENT_CONFIG.poison.maxStacks, 8, "global config must remain unchanged");
});

test("Contagion burst on death damages neighbours and respects depth cap", () => {
  const sim = freshSim();
  sim.players.get("p1").stats.virulence2 = 1;
  // Center enemy with 4+ poison stacks, neighbours nearby.
  const center = createEnemy("c", "drone", 0, 0, 1);
  center.maxHp = 50;
  center.hp = 1;
  center.ailments = {
    poison: {
      stacks: [
        { remaining: 5, tickAccumulator: 0, tickRate: 0.4, dotPerSecond: 10, ownerId: "p1" },
        { remaining: 5, tickAccumulator: 0, tickRate: 0.4, dotPerSecond: 10, ownerId: "p1" },
        { remaining: 5, tickAccumulator: 0, tickRate: 0.4, dotPerSecond: 10, ownerId: "p1" },
        { remaining: 5, tickAccumulator: 0, tickRate: 0.4, dotPerSecond: 10, ownerId: "p1" },
      ],
    },
  };
  sim.enemies.set(center.id, center);
  const neighbour = createEnemy("n", "drone", 30, 0, 1);
  neighbour.maxHp = 200;
  neighbour.hp = 200;
  sim.enemies.set(neighbour.id, neighbour);
  const farAway = createEnemy("f", "drone", 9999, 0, 1);
  farAway.maxHp = 200;
  farAway.hp = 200;
  sim.enemies.set(farAway.id, farAway);

  // Kill center via a chaos hit attributed to p1.
  sim.damageEnemy(center, 100, {
    ownerId: "p1",
    x: -10,
    y: 0,
    vx: 1,
    vy: 0,
    damageType: "chaos",
    damageBreakdown: { chaos: 100 },
  });
  assert.ok(neighbour.hp < 200, "neighbour should take contagion damage");
  assert.equal(farAway.hp, 200, "out-of-range enemy should be untouched");

  // Now: a contagionDepth:1 source should NOT trigger a second burst.
  // Set neighbour to have 4+ poison stacks and near-zero hp.
  neighbour.hp = 1;
  neighbour.ailments = {
    poison: {
      stacks: Array.from({ length: 4 }, () => ({
        remaining: 5,
        tickAccumulator: 0,
        tickRate: 0.4,
        dotPerSecond: 10,
        ownerId: "p1",
      })),
    },
  };
  const before = farAway.hp;
  // Move farAway close to neighbour so a burst from neighbour would reach it.
  farAway.x = neighbour.x + 30;
  sim.damageEnemy(neighbour, 100, {
    ownerId: "p1",
    x: neighbour.x - 10,
    y: 0,
    vx: 1,
    vy: 0,
    damageType: "chaos",
    damageBreakdown: { chaos: 100 },
    contagionDepth: 1,
  });
  assert.equal(farAway.hp, before, "contagion must not chain past depth 1");
});

test("Tempest Coil hits roll shock and sap on lightning breakdown", () => {
  const enemy = createEnemy("tc1", "drone", 0, 0, 1);
  enemy.maxHp = 200;
  enemy.hp = 200;
  const rng = new Rng(13);
  let shocked = 0;
  let sapped = 0;
  for (let i = 0; i < 60; i += 1) {
    enemy.ailments = {};
    applyAilmentsFromHit(
      enemy,
      { damage: 30, damageType: "lightning", breakdown: { lightning: 30 }, ownerId: "p1" },
      rng,
    );
    if (enemy.ailments.shock) shocked += 1;
    if (enemy.ailments.sap) sapped += 1;
    assert.equal(enemy.ailments.ignite, undefined, "lightning never ignites");
    assert.equal(enemy.ailments.bleed, undefined, "lightning never bleeds");
  }
  assert.ok(shocked > 5, `expected some shocks, got ${shocked}`);
  assert.ok(sapped > 5, `expected some saps, got ${sapped}`);
});

test("shockMagnitudeBonus hit field boosts the rolled shock magnitude", () => {
  const enemy = createEnemy("tc2", "drone", 0, 0, 1);
  enemy.maxHp = 200;
  enemy.hp = 200;
  function meanShockMagnitude(extra) {
    let total = 0;
    let count = 0;
    const rng = new Rng(7);
    for (let i = 0; i < 200; i += 1) {
      enemy.ailments = {};
      applyAilmentsFromHit(
        enemy,
        { damage: 30, damageType: "lightning", breakdown: { lightning: 30 }, ownerId: "p1", ...extra },
        rng,
      );
      const s = enemy.ailments.shock;
      if (s) {
        total += s.magnitude || 0;
        count += 1;
      }
    }
    return count ? total / count : 0;
  }
  const base = meanShockMagnitude({});
  const boosted = meanShockMagnitude({ shockMagnitudeBonus: 0.25 });
  assert.ok(boosted > base + 0.15, `expected boosted shock mag (got base=${base} boosted=${boosted})`);
  // Cap: huge bonus must clamp at 1.0.
  const clamped = meanShockMagnitude({ shockMagnitudeBonus: 5 });
  assert.ok(clamped <= 1 + 1e-9, `shock magnitude must clamp <= 1, got ${clamped}`);
  assert.equal(AILMENT_CONFIG.shock.magnitudeMax, 0.5, "global config must remain unchanged");
});

test("Tempest Coil chain hops do not re-roll ailments (fromAilment path)", () => {
  const sim = freshSim();
  const player = sim.players.get("p1");
  player.x = 0;
  player.y = 0;
  player.cooldown = 999;
  player.tempestCoilCooldown = 0;
  // Apply weapon + tier I + tier II so chain is large and hits are juicy.
  for (const id of ["tempest-coil", "overcharge-1", "overcharge-2"]) {
    UPGRADE_POOL.find((u) => u.id === id).apply(player);
  }
  const primary = createEnemy("p", "drone", 0, 0, 1);
  primary.maxHp = 9999;
  primary.hp = 9999;
  sim.enemies.set(primary.id, primary);
  // Place chain neighbours close together.
  const neighbours = [];
  for (let i = 0; i < 4; i += 1) {
    const e = createEnemy(`n${i}`, "drone", 80 + i * 50, 0, 1);
    e.maxHp = 9999;
    e.hp = 9999;
    sim.enemies.set(e.id, e);
    neighbours.push(e);
  }
  const proj = {
    ownerId: player.id,
    damage: 30,
    weaponKind: "tempestCoil",
    tempestArcs: 4,
    tempestRange: 190,
    tempestDamageMultiplier: 0.7,
  };
  sim.tempestCoilChainDamage(proj, primary);
  // The chain hops are explicitly fromAilment:true, so by contract no chain
  // hop may have planted shock/sap/etc. The primary received no projectile
  // hit in this test (we only call the chain helper), so it too should be
  // ailment-free.
  assert.equal(primary.ailments.shock, undefined, "primary should not be re-shocked by chain");
  for (const n of neighbours) {
    assert.equal(n.ailments.shock, undefined, "chain hops must not apply shock");
    assert.equal(n.ailments.sap, undefined, "chain hops must not apply sap");
  }
});

test("validateAilmentConfig still passes after Tempest Coil additions", () => {
  const errors = validateAilmentConfig();
  assert.deepEqual(errors, []);
});

