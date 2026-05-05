import { GameSimulation } from "../src/simulation.js";

function makeSim(seed) {
  const sim = new GameSimulation({ seed, localPlayerId: "p", headless: true, enableRunEvents: true });
  const p = sim.players.get(sim.localPlayerId);
  p.stats.maxHp = 1e9;
  p.hp = 1e9;
  p.stats.armor = 1e6;
  return sim;
}

const sim = makeSim(1337);
const dt = 1 / 60;
let t = 0;
for (let i = 0; i < 4500; i++) {
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
}

console.log(`State: enemies=${sim.enemies.size} projectiles=${sim.projectiles.size} pickups=${sim.pickups.size} effects=${sim.effects.size}`);

const ITER = 20000;
const RUNS = 5;
let totalMs = 0;
for (let r = 0; r < RUNS; r++) {
  const t0 = performance.now();
  for (let i = 0; i < ITER; i++) sim.getSnapshot();
  const ms = performance.now() - t0;
  totalMs += ms;
  console.log(`run=${r} ms=${ms.toFixed(2)} per_call_us=${((ms * 1000) / ITER).toFixed(2)}`);
}
console.log(`mean_per_call_us=${((totalMs * 1000) / (ITER * RUNS)).toFixed(2)}`);
