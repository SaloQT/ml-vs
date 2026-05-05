import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { DqnTrainer } from "../src/dqnTrainer.js";

const options = parseArgs(process.argv.slice(2));
const iterations = positiveInt(options.iterations, 200);
const batchSize = positiveInt(options.batchSize ?? options["batch-size"], 4);
const outputPath = options.out ?? options.output ?? "dqn-model.json";
const resumePath = options.resume ?? options.load;
const logEvery = positiveInt(options.logEvery ?? options["log-every"], 10);
const saveEvery = positiveInt(options.saveEvery ?? options["save-every"], 0);

const trainer = new DqnTrainer();
applyHyperparams(trainer, options);
if (resumePath) {
  if (!existsSync(resumePath)) {
    console.error(`resume file not found: ${resumePath}`);
    process.exit(1);
  }
  trainer.importModel(JSON.parse(readFileSync(resumePath, "utf8")));
  console.log(`resumed from ${resumePath} at iteration ${trainer.iteration}`);
}

console.log(
  `training: iterations=${iterations} batchSize=${batchSize} out=${outputPath}` +
    (saveEvery ? ` saveEvery=${saveEvery}` : ""),
);

const startedAt = performance.now();
for (let i = 0; i < iterations; i += 1) {
  const point = await trainer.trainBatch(batchSize);
  if (logEvery > 0 && (i % logEvery === 0 || i === iterations - 1)) {
    console.log(
      `[${point.iteration}] reward=${point.reward} score=${point.score} kills=${point.kills} ` +
        `damage=${point.damage} survival=${point.seconds}s death=${point.deathRate}% ` +
        `eps=${point.epsilon} loss=${point.tdLoss} tps=${point.ticksPerSecond}`,
    );
  }
  if (saveEvery > 0 && (i + 1) % saveEvery === 0) {
    saveModel(trainer, outputPath);
  }
}
const elapsedSeconds = (performance.now() - startedAt) / 1000;

saveModel(trainer, outputPath);
console.log(`done in ${elapsedSeconds.toFixed(1)}s — saved to ${outputPath}`);

function saveModel(trainer, path) {
  writeFileSync(path, JSON.stringify(trainer.exportModel()));
}

function applyHyperparams(trainer, options) {
  const map = {
    learningRate: ["learningRate", "lr"],
    gamma: ["gamma"],
    epsilonStart: ["epsilonStart", "eps-start"],
    epsilonEnd: ["epsilonEnd", "eps-end"],
    epsilonDecaySteps: ["epsilonDecaySteps", "eps-decay"],
    replayCapacity: ["replayCapacity", "replay-capacity"],
    replayMinSize: ["replayMinSize", "replay-min"],
    targetSyncEvery: ["targetSyncEvery", "target-sync"],
    minibatchSize: ["minibatchSize", "minibatch"],
    killReward: ["killReward", "kill-reward"],
    xpReward: ["xpReward", "xp-reward"],
    damageReward: ["damageReward", "damage-reward", "damage"],
    powerupReward: ["powerupReward", "powerup-reward"],
    damageTakenPenalty: ["damageTakenPenalty", "dmg-taken"],
    survivalBonus: ["survivalBonus", "survival-bonus"],
    deathPenalty: ["deathPenalty", "death-penalty"],
    maxEpisodeSeconds: ["maxEpisodeSeconds", "episode-seconds", "game-length"],
    warmupSeconds: ["warmupSeconds", "warmup"],
  };
  for (const [field, aliases] of Object.entries(map)) {
    for (const alias of aliases) {
      if (options[alias] !== undefined) {
        const value = Number(options[alias]);
        if (Number.isFinite(value)) trainer[field] = value;
        break;
      }
    }
  }
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq >= 0) {
      out[arg.slice(2, eq)] = arg.slice(eq + 1);
    } else {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        out[arg.slice(2)] = next;
        i += 1;
      } else {
        out[arg.slice(2)] = true;
      }
    }
  }
  return out;
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
