import { GameSimulation } from "../src/simulation.js";

// Headless step throughput benchmark. Drives a deterministic simulation with
// a moving player so spawns, projectiles, ailments, and pickups all engage,
// then measures pure simulation.step() wall time.

function makeSim(seed) {
  const sim = new GameSimulation({
    seed,
    localPlayerId: "p",
    headless: true,
    enableRunEvents: true,
  });
  // Make the player effectively unkillable so the benchmark sees a steady
  // workload rather than a death-then-restart cycle.
  const p = sim.players.get(sim.localPlayerId);
  p.stats.maxHp = 1e9;
  p.hp = 1e9;
  p.stats.armor = 1e6;
  return sim;
}

function driveTick(sim, t, dt) {
  sim.applyInput(sim.localPlayerId, {
    moveX: Math.cos(t * 0.7),
    moveY: Math.sin(t * 0.5),
    aimX: Math.cos(t * 1.1),
    aimY: Math.sin(t * 1.1),
  });
  sim.step(dt);
  if (sim.state === "upgrade") {
    const ids = sim.pendingUpgradeChoices.map((c) => c.id);
    sim.chooseUpgrade(ids[0]);
  }
  // Keep the player healthy so step() always has full work to do.
  const p = sim.players.get(sim.localPlayerId);
  p.hp = p.stats.maxHp;
}

function runOnce(seedOffset, warmTicks, measuredTicks) {
  const dt = 1 / 60;
  let sim = makeSim(1337 + seedOffset);
  let resetCount = 0;
  let restartSeed = 1337 + seedOffset;
  let warmedSoFar = 0;
  let virtualT = 0;
  while (warmedSoFar < warmTicks) {
    if (sim.state !== "playing" && sim.state !== "upgrade") {
      restartSeed += 1009;
      sim = makeSim(restartSeed);
      resetCount += 1;
    }
    driveTick(sim, virtualT, dt);
    virtualT += dt;
    warmedSoFar += 1;
  }
  let snapshotEnemies = sim.enemies.size;
  let snapshotProjectiles = sim.projectiles.size;
  let snapshotPickups = sim.pickups.size;
  const start = process.hrtime.bigint();
  let measuredSoFar = 0;
  while (measuredSoFar < measuredTicks) {
    if (sim.state !== "playing" && sim.state !== "upgrade") {
      restartSeed += 1009;
      sim = makeSim(restartSeed);
      resetCount += 1;
    }
    driveTick(sim, virtualT, dt);
    virtualT += dt;
    measuredSoFar += 1;
    if (measuredSoFar === measuredTicks >> 1) {
      snapshotEnemies = sim.enemies.size;
      snapshotProjectiles = sim.projectiles.size;
      snapshotPickups = sim.pickups.size;
    }
  }
  const end = process.hrtime.bigint();
  const ms = Number(end - start) / 1e6;
  return {
    ms,
    ticks: measuredTicks,
    enemies: snapshotEnemies,
    projectiles: snapshotProjectiles,
    pickups: snapshotPickups,
    resets: resetCount,
  };
}

const WARM = 60 * 60;          // 60s warmup
const MEASURED = 60 * 120;     // 120s measured
const RUNS = 5;

console.log(`Warm ${WARM} ticks, measured ${MEASURED} ticks per run, ${RUNS} runs`);
const results = [];
for (let i = 0; i < RUNS; i += 1) {
  const r = runOnce(i, WARM, MEASURED);
  const tps = (r.ticks / r.ms) * 1000;
  results.push({ ...r, tps });
  console.log(`run=${i} ms=${r.ms.toFixed(1)} tps=${tps.toFixed(0)} enemies=${r.enemies} projectiles=${r.projectiles} pickups=${r.pickups} resets=${r.resets}`);
}
const meanMs = results.reduce((a, r) => a + r.ms, 0) / results.length;
const meanTps = results.reduce((a, r) => a + r.tps, 0) / results.length;
console.log(`mean ms=${meanMs.toFixed(1)} mean tps=${meanTps.toFixed(0)}`);
