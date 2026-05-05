// Render path exercise: drive Renderer.render() against synthetic snapshots
// that touch every conditional branch in render.js. Catches per-frame
// ReferenceErrors / TypeErrors that node --test otherwise misses because no
// other test loads render.js. The TWO_PI2 / TWO_PI<digit> sed-mangled-constant
// class of bug is exactly what this is for.

import { test } from "node:test";
import assert from "node:assert/strict";

// Stubs must be installed before importing render.js (it touches no DOM at
// module load now, but be defensive in case future code does).
const noop = () => {};
const ctx = new Proxy(
  {
    canvas: { width: 1280, height: 720 },
    measureText: () => ({ width: 0 }),
    createLinearGradient: () => ({ addColorStop: noop }),
    createRadialGradient: () => ({ addColorStop: noop }),
    createPattern: () => null,
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
  },
  {
    get(target, prop) {
      if (prop in target) return target[prop];
      // Numeric / string canvas state fields read back as 0 / "".
      return noop;
    },
    set() { return true; },
  },
);
const canvas = {
  getContext: () => ctx,
  width: 1280,
  height: 720,
  addEventListener: noop,
  getBoundingClientRect: () => ({ width: 1280, height: 720, left: 0, top: 0, right: 1280, bottom: 720 }),
  style: {},
};
if (typeof globalThis.document === "undefined") {
  globalThis.document = { createElement: () => canvas, getElementById: () => canvas };
}
if (typeof globalThis.Image === "undefined") globalThis.Image = class { constructor() {} };
if (typeof globalThis.window === "undefined") globalThis.window = { devicePixelRatio: 1, addEventListener: noop };
else if (!globalThis.window.addEventListener) globalThis.window.addEventListener = noop;

const { Renderer } = await import("../src/render.js");

function makeRenderer() {
  return new Renderer(canvas, { screenShake: false, lighting: false, particles: false });
}

function baseSnapshot(overrides = {}) {
  return {
    protocolVersion: 1,
    tick: 1,
    elapsed: 1.0,
    state: "playing",
    runMode: "player",
    outcome: null,
    difficulty: { tier: 1, label: "Normal" },
    wave: 1,
    localPlayerId: "p",
    players: [{
      id: "p", x: 0, y: 0, hp: 100, maxHp: 100, shield: 0, maxShield: 0,
      stats: { ramDamage: 0, hullDamageReflection: 0, contactKnockback: 0, invulnerabilityBonus: 0, area: 1 },
      facingX: 1, facingY: 0, aimX: 1, aimY: 0,
      ownedUpgrades: new Set(), upgradeStacks: new Map(),
      level: 1, xp: 0, xpToNext: 10, scrap: 0,
      invulnerableFor: 0, radius: 14, dashCooldown: 0,
    }],
    enemies: [],
    projectiles: [],
    pickups: [],
    effects: [],
    runEvents: { enabled: true, nextAt: null, active: [], alert: null },
    bossSpawnTelegraph: null,
    pendingUpgradeChoices: [],
    targeting: { primaryWeapon: { strategy: "nearest", maxRange: 0, enemyTypes: [] } },
    ...overrides,
  };
}

function makeEnemy(over = {}) {
  return {
    id: "e1", type: "drone", x: 50, y: 0, hp: 50, maxHp: 50,
    radius: 16, speed: 80, damage: 10, xp: 1, splitCount: 0, splitChildType: null,
    rank: "normal", phase: 1, affixes: [], eliteAffix: null,
    hitVx: 0, hitVy: 0, hitFlash: 0, ailments: {}, _hasActiveAilments: false,
    siphonFor: 0, armoredFlashFor: 0, ...over,
  };
}

test("render: empty snapshot", () => {
  const r = makeRenderer();
  r.render(baseSnapshot());
});

test("render: with normal enemy", () => {
  const r = makeRenderer();
  r.render(baseSnapshot({ enemies: [makeEnemy()] }));
});

test("render: volatile elite, low hp triggers volatileWarning aura branch", () => {
  // hp/maxHp <= 0.18 makes drawAffixAuras enter the volatileWarning branch.
  // This is the exact branch that masked the TWO_PI2 bug for ~24 hours.
  const r = makeRenderer();
  r.render(baseSnapshot({
    enemies: [makeEnemy({
      id: "e_volatile", rank: "elite", eliteAffix: "volatile",
      affixes: ["volatile"], hp: 5, maxHp: 50, volatileBurstIn: 0.3,
    })],
  }));
});

test("render: boss with telegraph", () => {
  const r = makeRenderer();
  r.render(baseSnapshot({
    enemies: [makeEnemy({ id: "boss1", rank: "boss", radius: 32, hp: 1000, maxHp: 1000, bossId: "alpha" })],
    bossSpawnTelegraph: { bossId: "alpha", x: 0, y: 0, startedAt: 0, duration: 2, color: "#ff5b79" },
  }));
});

test("render: every elite affix aura branch", () => {
  // drawAffixAuras dispatches on affix string. Hit each one to make sure no
  // affix style path has another sed-mangled constant.
  const affixes = ["hasted", "armored", "siphon", "warden", "rare", "volatile", "shielded"];
  const r = makeRenderer();
  r.render(baseSnapshot({
    enemies: affixes.map((a, i) => makeEnemy({
      id: `e_${a}`, rank: "elite", eliteAffix: a, affixes: [a],
      x: i * 30, hp: a === "volatile" ? 5 : 50,
    })),
  }));
});

test("render: pickups, projectiles, effects in flight", () => {
  const r = makeRenderer();
  r.render(baseSnapshot({
    pickups: [
      { id: "pk1", x: 10, y: 10, type: "xp", value: 1, radius: 8 },
      { id: "pk2", x: 20, y: 10, type: "scrap", value: 1, radius: 9 },
      { id: "pk3", x: 30, y: 10, type: "shield", value: 1, radius: 12 },
    ],
    projectiles: [{
      id: "pr1", ownerId: "p", x: 5, y: 0, vx: 100, vy: 0, radius: 5, damage: 10,
      ttl: 1.0, color: "#8ff3ff", glowColor: "rgba(100,225,255,0.42)",
      hitEnemyIds: new Set(),
    }],
    effects: [{ id: "fx1", type: "hit", x: 10, y: 10, ttl: 0.2, elapsed: 0 }],
  }));
});

test("render: paused / upgrade / gameover states", () => {
  const r = makeRenderer();
  for (const state of ["upgrade", "gameover", "paused"]) {
    r.render(baseSnapshot({ state, pendingUpgradeChoices: state === "upgrade" ? [] : [] }));
  }
});
