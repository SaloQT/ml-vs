// Determinism trace: drives the sim with a fixed input pattern for N ticks
// and prints a rolling hash of key per-tick state. Two runs of this script
// (with the same arg) MUST print identical output. Used to verify that
// refactors do not change observable simulation behavior.

import { GameSimulation } from "../src/simulation.js";

function makeSim(seed) {
  const sim = new GameSimulation({ seed, localPlayerId: "p", headless: true, enableRunEvents: true });
  const p = sim.players.get(sim.localPlayerId);
  p.stats.maxHp = 1e9;
  p.hp = 1e9;
  p.stats.armor = 1e6;
  return sim;
}

// FNV-1a 32-bit, fed integers
function mixHash(h, v) {
  v = v | 0;
  h = (h ^ (v & 0xff)) >>> 0;       h = Math.imul(h, 0x01000193) >>> 0;
  h = (h ^ ((v >>> 8) & 0xff)) >>> 0; h = Math.imul(h, 0x01000193) >>> 0;
  h = (h ^ ((v >>> 16) & 0xff)) >>> 0; h = Math.imul(h, 0x01000193) >>> 0;
  h = (h ^ ((v >>> 24) & 0xff)) >>> 0; h = Math.imul(h, 0x01000193) >>> 0;
  return h;
}
function mixFloat(h, f) {
  // Round to fixed precision so any insignificant FP drift is caught at higher precision later
  // but we do compare bit-identical here: convert to Float64 bytes via DataView.
  return mixHash(mixHash(h, dv.getInt32(0, true)), dv.getInt32(4, true));
}
const buf = new ArrayBuffer(8);
const dv = new DataView(buf);
const f64 = new Float64Array(buf);
function fHash(h, v) {
  f64[0] = v;
  return mixHash(mixHash(h, dv.getInt32(0, true)), dv.getInt32(4, true));
}

function hashState(sim) {
  let h = 0x811c9dc5 >>> 0;
  h = mixHash(h, sim.tick | 0);
  h = fHash(h, sim.elapsed);
  h = mixHash(h, sim.wave | 0);
  h = mixHash(h, sim.enemies.size);
  h = mixHash(h, sim.projectiles.size);
  h = mixHash(h, sim.pickups.size);
  // Players
  for (const p of sim.players.values()) {
    h = fHash(h, p.x); h = fHash(h, p.y); h = fHash(h, p.hp);
  }
  // Enemies — iterate via Map (insertion-order canonical)
  for (const e of sim.enemies.values()) {
    h = fHash(h, e.x); h = fHash(h, e.y); h = fHash(h, e.hp);
    h = mixHash(h, e._numericId | 0);
  }
  for (const pr of sim.projectiles.values()) {
    h = fHash(h, pr.x); h = fHash(h, pr.y);
  }
  for (const pk of sim.pickups.values()) {
    h = fHash(h, pk.x); h = fHash(h, pk.y);
  }
  return h >>> 0;
}

const TICKS = Number(process.argv[2] ?? 6000);
const REPORT = Number(process.argv[3] ?? 500);
const SEED = Number(process.argv[4] ?? 1337);

const sim = makeSim(SEED);
const dt = 1 / 60;
let t = 0;
let restartSeed = SEED;
let resets = 0;

for (let tick = 0; tick < TICKS; tick++) {
  // If dead/over, restart deterministically
  if (sim.state !== "playing" && sim.state !== "upgrade") {
    restartSeed += 1009;
    Object.assign(sim, makeSim(restartSeed));
    resets += 1;
  }
  sim.applyInput(sim.localPlayerId, {
    moveX: Math.cos(t * 0.7), moveY: Math.sin(t * 0.5),
    aimX: Math.cos(t * 1.1), aimY: Math.sin(t * 1.1),
  });
  sim.step(dt);
  if (sim.state === "upgrade") {
    const ids = sim.pendingUpgradeChoices.map((c) => c.id);
    sim.chooseUpgrade(ids[0]);
  }
  const p = sim.players.get(sim.localPlayerId);
  p.hp = p.stats.maxHp;
  t += dt;
  if ((tick + 1) % REPORT === 0) {
    const h = hashState(sim);
    console.log(`tick=${tick + 1} h=${h.toString(16).padStart(8, "0")} enemies=${sim.enemies.size} proj=${sim.projectiles.size}`);
  }
}
const finalH = hashState(sim);
console.log(`FINAL ticks=${TICKS} h=${finalH.toString(16).padStart(8, "0")} enemies=${sim.enemies.size} resets=${resets}`);
