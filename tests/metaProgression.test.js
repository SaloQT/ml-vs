import test from "node:test";
import assert from "node:assert/strict";

import { createPlayer } from "../src/entities.js";
import {
  PERMANENT_UPGRADES,
  applyMetaProgress,
  asymptoticEffect,
  formatRankLabel,
  logEffect,
  nextRankCost,
  nextRankEffectDelta,
  normalizeMetaProgress,
  prestigeProgressFraction,
  prestigeTierIndex,
  upgradeCost,
} from "../src/metaProgression.js";

function findUpgrade(id) {
  return PERMANENT_UPGRADES.find((u) => u.id === id);
}

test("each permanent upgrade exposes a softCap and matching maxLevel alias", () => {
  for (const u of PERMANENT_UPGRADES) {
    assert.ok(typeof u.softCap === "number" && u.softCap > 0, `${u.id} softCap`);
    assert.equal(u.maxLevel, u.softCap, `${u.id} maxLevel alias`);
  }
});

test("upgradeCost ramps the exponent past the soft cap", () => {
  const cd = findUpgrade("combat-drills");
  // Sanity: cost is monotonically increasing.
  let prev = 0;
  for (let lvl = 0; lvl < 25; lvl += 1) {
    const c = upgradeCost(cd, lvl);
    assert.ok(c > prev, `cost should increase at level ${lvl}`);
    prev = c;
  }
});

test("combat-drills cost matches the piecewise-exponent formula", () => {
  const cd = findUpgrade("combat-drills");
  // Expected values computed directly from the spec formula:
  //   exp(level) = 1.35 + 0.35 * max(0, level - 4) / 5
  //   cost = round(120 * (level+1)^exp)
  for (const lvl of [5, 10, 15, 20]) {
    const baseExp = 1.35;
    const over = Math.max(0, lvl - cd.softCap + 1);
    const exp = baseExp + (0.35 * over) / cd.softCap;
    const expected = Math.round(cd.baseCost * Math.pow(lvl + 1, exp));
    assert.equal(upgradeCost(cd, lvl), expected, `level ${lvl}`);
  }
});

test("asymptotic effect is bounded by the cap even at very high ranks", () => {
  const cd = findUpgrade("combat-drills");
  const e50 = asymptoticEffect(50, cd.effectCap, cd.effectK);
  assert.ok(e50 <= cd.effectCap, `e50 ${e50} should be ≤ ${cd.effectCap}`);
  // Approaches the cap (within tiny epsilon at very high ranks).
  const e500 = asymptoticEffect(500, cd.effectCap, cd.effectK);
  assert.ok(e500 <= cd.effectCap);
  assert.ok(cd.effectCap - e500 < 1e-6);
});

test("damage bonus stays bounded across rank 5 → 100", () => {
  const cd = findUpgrade("combat-drills");
  for (let lvl = 5; lvl <= 100; lvl += 5) {
    const bonus = asymptoticEffect(lvl, cd.effectCap, cd.effectK);
    assert.ok(bonus < cd.effectCap, `bonus at ${lvl} should be under cap`);
  }
});

test("rank-5 effects approximately match the previous linear baseline (±5%)", () => {
  const targets = {
    "reinforced-hull": 40,
    "reactor-tuning": Math.pow(1.05, 5) - 1,
    "combat-drills": Math.pow(1.05, 5) - 1,
    "field-medicine": 0.10,
  };
  for (const [id, target] of Object.entries(targets)) {
    const u = findUpgrade(id);
    const got = asymptoticEffect(u.softCap, u.effectCap, u.effectK);
    const tolerance = Math.max(0.05 * Math.abs(target), 1e-3);
    assert.ok(
      Math.abs(got - target) <= tolerance,
      `${id}: got ${got}, target ${target}`,
    );
  }
  // nav-school uses softCap=4 with target 1.04^4 - 1
  const ns = findUpgrade("nav-school");
  const nsGot = asymptoticEffect(ns.softCap, ns.effectCap, ns.effectK);
  const nsTarget = Math.pow(1.04, 4) - 1;
  assert.ok(Math.abs(nsGot - nsTarget) <= 0.05 * nsTarget);
});

test("scrap-charter uses logarithmic growth (slight nerf from old linear)", () => {
  const sc = findUpgrade("scrap-charter");
  const got = logEffect(sc.softCap, sc.logScale);
  // Old: 5 * 0.05 = 0.25. New: 0.10 * ln(6) ≈ 0.1792
  assert.ok(got < 0.25, `scrap-charter@5 should be < old 0.25, got ${got}`);
  assert.ok(got > 0.15);
});

test("migration v2 refunds scrap when the new effect is worse than old", () => {
  const normalized = normalizeMetaProgress({
    scrap: 0,
    upgrades: { "scrap-charter": 5 },
    // migrationVersion intentionally undefined
  });
  assert.equal(normalized.migrationVersion, 2);
  assert.ok(normalized.scrap > 0, `expected refund, got ${normalized.scrap}`);
});

test("migration v2 does not refund upgrades that are equal-or-better", () => {
  const normalized = normalizeMetaProgress({
    scrap: 0,
    upgrades: { "combat-drills": 5 },
  });
  assert.equal(normalized.migrationVersion, 2);
  // combat-drills new effect at rank 5 is ≥ old (within ±5%); should not refund
  // a meaningful amount. Allow zero or a tiny refund only.
  assert.ok(normalized.scrap === 0, `combat-drills should not refund, got ${normalized.scrap}`);
});

test("migration is idempotent once migrationVersion is current", () => {
  const once = normalizeMetaProgress({ upgrades: { "scrap-charter": 5 } });
  const twice = normalizeMetaProgress(once);
  assert.equal(twice.scrap, once.scrap);
});

test("formatRankLabel produces tier and prestige strings", () => {
  const cd = findUpgrade("combat-drills");
  assert.equal(formatRankLabel(cd, 4), "Level 4 · Tier I");
  assert.equal(formatRankLabel(cd, 5), "Level 5 · Calibrated · Prestige I");
  assert.equal(formatRankLabel(cd, 10), "Level 10 · Calibrated · Prestige II");
  assert.equal(formatRankLabel(cd, 15), "Level 15 · Calibrated · Prestige III");
});

test("prestigeTierIndex / prestigeProgressFraction track soft-cap math", () => {
  const cd = findUpgrade("combat-drills");
  assert.equal(prestigeTierIndex(cd, 0), 0);
  assert.equal(prestigeTierIndex(cd, 4), 0);
  assert.equal(prestigeTierIndex(cd, 5), 1);
  assert.equal(prestigeTierIndex(cd, 10), 2);
  assert.equal(prestigeProgressFraction(cd, 0), 0);
  assert.equal(prestigeProgressFraction(cd, 5), 0);
  assert.equal(Number(prestigeProgressFraction(cd, 7).toFixed(2)), 0.4);
});

test("nextRankCost equals upgradeCost and effect delta is non-empty", () => {
  const cd = findUpgrade("combat-drills");
  assert.equal(nextRankCost(cd, 5), upgradeCost(cd, 5));
  const delta = nextRankEffectDelta(cd, 5);
  assert.ok(typeof delta === "string" && delta.length > 0);
  assert.ok(delta.includes("damage"));
});

test("applyMetaProgress drops the level clamp and accepts arbitrary ranks", () => {
  const player = createPlayer("p");
  const baseDmg = player.stats.damage;
  applyMetaProgress(player, {
    upgrades: { "combat-drills": 50 },
    migrationVersion: 2,
  });
  const cd = findUpgrade("combat-drills");
  const expected = baseDmg * (1 + asymptoticEffect(50, cd.effectCap, cd.effectK));
  assert.ok(Math.abs(player.stats.damage - expected) < 1e-6);
});
