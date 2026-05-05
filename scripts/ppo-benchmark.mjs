import { PpoTrainer } from "../src/ppoTrainer.js";

const options = parseArgs(process.argv.slice(2));
const iterations = positiveInt(options.iterations ?? options.batches, 6);
const batchSize = positiveInt(options.batchSize ?? options["batch-size"], 4);
const evalSeeds = (options.evalSeeds ?? options["eval-seeds"] ?? "501,502,503,504,505,506,507,508")
  .split(",")
  .map((seed) => Number.parseInt(seed, 10))
  .filter(Number.isFinite);

const trainer = new PpoTrainer({ useOrt: false });
const evalBefore = evaluatePolicy(trainer, evalSeeds);
const startedAt = performance.now();
const history = [];
for (let i = 0; i < iterations; i += 1) {
  history.push(trainer.trainBatch(batchSize));
}
const elapsedMs = performance.now() - startedAt;
const evalAfter = evaluatePolicy(trainer, evalSeeds);
const ticks = history.reduce((sum, point) => sum + point.ticks, 0);
const deterministic = deterministicCheck(iterations, batchSize, history, trainer.weights);
const first = history[0] ?? emptyPoint();
const last = history.at(-1) ?? emptyPoint();

console.log(
  JSON.stringify(
    {
      iterations,
      batchSize,
      episodes: iterations * batchSize,
      elapsedMs: Number(elapsedMs.toFixed(2)),
      ticks,
      ticksPerSecond: Math.round(ticks / Math.max(0.001, elapsedMs / 1000)),
      deterministic,
      trainingFirst: qualitySummary(first),
      trainingLast: qualitySummary(last),
      trainingDelta: {
        reward: last.reward - first.reward,
        score: last.score - first.score,
        kills: last.kills - first.kills,
        damage: last.damage - first.damage,
        deathRate: last.deathRate - first.deathRate,
      },
      evalSeeds,
      evalBefore,
      evalAfter,
      evalDelta: deltaSummary(evalBefore, evalAfter),
    },
    null,
    2,
  ),
);

function deterministicCheck(iterationsToRun, episodesPerBatch, expectedHistory, expectedWeights) {
  const checkTrainer = new PpoTrainer({ useOrt: false });
  const checkHistory = [];
  for (let i = 0; i < iterationsToRun; i += 1) {
    checkHistory.push(checkTrainer.trainBatch(episodesPerBatch));
  }

  return (
    JSON.stringify(checkHistory.map(stablePoint)) === JSON.stringify(expectedHistory.map(stablePoint)) &&
    JSON.stringify(roundWeights(checkTrainer.weights)) === JSON.stringify(roundWeights(expectedWeights))
  );
}

function stablePoint(point) {
  return {
    iteration: point.iteration,
    reward: point.reward,
    seconds: point.seconds,
    kills: point.kills,
    damage: point.damage,
    damageTaken: point.damageTaken,
    score: point.score,
    deathRate: point.deathRate,
    episodes: point.episodes,
    ticks: point.ticks,
  };
}

function qualitySummary(point) {
  return {
    iteration: point.iteration,
    reward: point.reward,
    score: point.score,
    seconds: point.seconds,
    kills: point.kills,
    damage: point.damage,
    damageTaken: point.damageTaken,
    deathRate: point.deathRate,
    ticksPerSecond: point.ticksPerSecond,
  };
}

function evaluatePolicy(trainer, seeds) {
  const episodes = seeds.map((seed) => trainer.runEpisode(seed));
  return {
    reward: roundedMean(episodes.map((episode) => episode.reward)),
    score: roundedMean(episodes.map((episode) => episode.score)),
    seconds: roundedMean(episodes.map((episode) => episode.seconds)),
    kills: roundedMean(episodes.map((episode) => episode.kills)),
    damage: roundedMean(episodes.map((episode) => episode.damageDealt)),
    damageTaken: roundedMean(episodes.map((episode) => episode.damageTaken)),
    deathRate: Math.round((episodes.filter((episode) => episode.dead).length / Math.max(1, episodes.length)) * 100),
  };
}

function deltaSummary(before, after) {
  return Object.fromEntries(Object.keys(after).map((key) => [key, Number((after[key] - before[key]).toFixed(2))]));
}

function roundedMean(values) {
  return Number((values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length)).toFixed(2));
}

function emptyPoint() {
  return {
    iteration: 0,
    reward: 0,
    score: 0,
    seconds: 0,
    kills: 0,
    damage: 0,
    damageTaken: 0,
    deathRate: 0,
    ticksPerSecond: 0,
  };
}

function roundWeights(weights) {
  return weights.map((row) => row.map((value) => Number(value.toFixed(9))));
}

function parseArgs(args) {
  return Object.fromEntries(
    args.map((arg) => {
      const [key, value = "true"] = arg.replace(/^--/, "").split("=");
      return [key, value];
    }),
  );
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
