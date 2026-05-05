import { PpoTrainer } from "../src/ppoTrainer.js";
import { ReinforceTrainer } from "../src/reinforceTrainer.js";
import { A2cTrainer } from "../src/a2cTrainer.js";
import { DqnTrainer } from "../src/dqnTrainer.js";

const args = parseArgs(process.argv.slice(2));
const iterations = positiveInt(args.iterations ?? args.iters, 30);
const batchSize = positiveInt(args.batchSize ?? args.batch, 2);
const logEvery = positiveInt(args.logEvery ?? args["log-every"], 5);
const only = args.only ? String(args.only).split(",") : null;

const ALGOS = [
  { key: "ppo", name: "PPO", color: "\x1b[36m", Trainer: PpoTrainer },
  { key: "reinforce", name: "REINFORCE", color: "\x1b[33m", Trainer: ReinforceTrainer },
  { key: "a2c", name: "A2C", color: "\x1b[32m", Trainer: A2cTrainer },
  { key: "dqn", name: "DQN", color: "\x1b[35m", Trainer: DqnTrainer },
].filter((a) => !only || only.includes(a.key));

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";

console.log(`${DIM}benchmark: ${ALGOS.map((a) => a.name).join(" · ")} | iters=${iterations} batch=${batchSize}${RESET}\n`);

const results = [];
for (const algo of ALGOS) {
  const trainer = new algo.Trainer();
  const startedAt = performance.now();
  let last = null;
  for (let i = 0; i < iterations; i += 1) {
    last = await trainer.trainBatch(batchSize);
    if (logEvery > 0 && (i % logEvery === 0 || i === iterations - 1)) {
      console.log(
        `${algo.color}[${algo.name.padEnd(9)}]${RESET} iter=${String(last.iteration).padStart(3)} ` +
        `reward=${String(last.reward).padStart(5)} kills=${String(last.kills).padStart(3)} ` +
        `surv=${String(last.seconds).padStart(2)}s death=${String(last.deathRate).padStart(3)}% ` +
        `tps=${last.ticksPerSecond}`,
      );
    }
  }
  const wallSeconds = (performance.now() - startedAt) / 1000;
  results.push({ algo, last, wallSeconds, history: trainer.history.slice() });
  console.log("");
}

// Final ranking
console.log(`${DIM}=== Final ranking by mean reward (last 5 iters) ===${RESET}`);
const ranked = results.map((r) => {
  const tail = r.history.slice(-5);
  const meanReward = tail.length ? tail.reduce((s, p) => s + p.reward, 0) / tail.length : 0;
  return { ...r, meanReward };
}).sort((a, b) => b.meanReward - a.meanReward);

for (let i = 0; i < ranked.length; i += 1) {
  const r = ranked[i];
  console.log(
    `${i + 1}. ${r.algo.color}${r.algo.name.padEnd(10)}${RESET} ` +
    `meanReward=${r.meanReward.toFixed(1).padStart(7)} ` +
    `final=${String(r.last.reward).padStart(5)} ` +
    `kills=${String(r.last.kills).padStart(3)} ` +
    `wall=${r.wallSeconds.toFixed(1)}s`,
  );
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq >= 0) out[arg.slice(2, eq)] = arg.slice(eq + 1);
    else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) { out[arg.slice(2)] = argv[++i]; }
    else out[arg.slice(2)] = true;
  }
  return out;
}

function positiveInt(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
