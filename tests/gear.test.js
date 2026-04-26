import assert from "node:assert/strict";
import test from "node:test";

import { PLAYER_BASE } from "../src/config.js";
import { createPlayer } from "../src/entities.js";
import { applyMetaProgress, defaultMetaProgress, EQUIPMENT, normalizeMetaProgress } from "../src/metaProgression.js";

function approx(actual, expected, epsilon = 1e-9) {
  assert.ok(Math.abs(actual - expected) < epsilon, `expected ${actual} to be within ${epsilon} of ${expected}`);
}

test("equipment catalog includes expanded slot choices with display effects", () => {
  assert.ok(EQUIPMENT.weapon.some((item) => item.id === "coil-repeater"));
  assert.ok(EQUIPMENT.weapon.some((item) => item.id === "ion-lance"));
  assert.ok(EQUIPMENT.weapon.some((item) => item.id === "flak-array"));
  assert.ok(EQUIPMENT.weapon.some((item) => item.id === "prism-carbine"));
  assert.ok(EQUIPMENT.weapon.some((item) => item.id === "nova-mortar"));
  assert.ok(EQUIPMENT.hull.some((item) => item.id === "interceptor-frame"));
  assert.ok(EQUIPMENT.hull.some((item) => item.id === "aegis-frame"));
  assert.ok(EQUIPMENT.hull.some((item) => item.id === "reactor-frame"));
  assert.ok(EQUIPMENT.utility.some((item) => item.id === "salvage-net"));
  assert.ok(EQUIPMENT.utility.some((item) => item.id === "overclock-relay"));
  assert.ok(EQUIPMENT.utility.some((item) => item.id === "stabilizer-vanes"));

  for (const [slot, items] of Object.entries(EQUIPMENT)) {
    for (const item of items) {
      assert.equal(item.slot, slot);
      assert.ok(item.effects.length > 0, `${item.id} should explain its stat effects`);
    }
  }
});

test("applyMetaProgress wires unique weapon mechanic stats and colors", () => {
  const prismPlayer = createPlayer("prism");
  applyMetaProgress(prismPlayer, { equipment: { weapon: "prism-carbine" } });

  assert.equal(prismPlayer.stats.ricochetBounces, 2);
  assert.equal(prismPlayer.stats.ricochetRange, 260);
  assert.equal(prismPlayer.stats.ricochetDamageMultiplier, 0.72);
  assert.equal(prismPlayer.stats.projectileColor, "#a78bfa");
  approx(prismPlayer.stats.damage, 24 * 0.92);
  approx(prismPlayer.stats.fireRate, 0.94);

  const novaPlayer = createPlayer("nova");
  applyMetaProgress(novaPlayer, { equipment: { weapon: "nova-mortar" } });

  assert.equal(novaPlayer.stats.splashRadius, 96);
  assert.equal(novaPlayer.stats.splashDamageMultiplier, 0.55);
  assert.equal(novaPlayer.stats.projectileRadius, 8);
  assert.equal(novaPlayer.stats.projectileColor, "#ffb020");
  approx(novaPlayer.stats.damage, 24 * 1.24);
  approx(novaPlayer.stats.fireRate, 0.7);
  approx(novaPlayer.stats.projectileSpeed, 620 * 0.78);
});

test("normalizeMetaProgress keeps known new gear and falls back from invalid saved gear", () => {
  const normalized = normalizeMetaProgress({
    scrap: 75,
    equipment: {
      weapon: "ion-lance",
      hull: "missing-frame",
      utility: "overclock-relay",
      experimental: "ignored",
    },
  });
  const defaults = defaultMetaProgress();

  assert.equal(normalized.scrap, 75);
  assert.deepEqual(normalized.equipment, {
    weapon: "ion-lance",
    hull: defaults.equipment.hull,
    utility: "overclock-relay",
  });
});

test("applyMetaProgress applies new weapon hull and utility tradeoffs through player stats", () => {
  const player = createPlayer("test");

  applyMetaProgress(player, {
    upgrades: {
      "reinforced-hull": 1,
      "combat-drills": 2,
      "reactor-tuning": 3,
      "nav-school": 1,
    },
    equipment: {
      weapon: "coil-repeater",
      hull: "reactor-frame",
      utility: "salvage-net",
    },
  });

  assert.equal(player.stats.maxHp, PLAYER_BASE.maxHp + 8 - 16);
  assert.equal(player.hp, player.stats.maxHp);
  assert.equal(player.stats.armor, -1);
  approx(player.stats.damage, 24 * (1 + 2 * 0.04) * 0.88 * 1.16);
  approx(player.stats.fireRate, (1 + 3 * 0.035) * 1.28 * 1.1);
  approx(player.stats.speed, PLAYER_BASE.speed * (1 + 1 * 0.025) * 0.96);
  approx(player.stats.projectileSpeed, 620 * 0.92);
  assert.equal(player.stats.pickupRadius, PLAYER_BASE.pickupRadius + 20);
  assert.equal(player.stats.salvageBonus, 0.1);
});

test("applyMetaProgress normalizes invalid equipment before applying defaults", () => {
  const player = createPlayer("test");

  applyMetaProgress(player, {
    equipment: {
      weapon: "does-not-exist",
      hull: "also-missing",
      utility: "bad-rig",
    },
  });

  assert.equal(player.stats.damage, 24);
  assert.equal(player.stats.fireRate, 1);
  assert.equal(player.stats.maxHp, PLAYER_BASE.maxHp);
  assert.equal(player.stats.pickupRadius, PLAYER_BASE.pickupRadius + 38);
});
