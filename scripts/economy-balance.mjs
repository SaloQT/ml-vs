#!/usr/bin/env node

import { GAME } from "../src/config.js";
import { GameSimulation } from "../src/simulation.js";
import { calculateRunScrap, defaultMetaProgress, PERMANENT_UPGRADES, upgradeCost } from "../src/metaProgression.js";

const DEFAULT_SEEDS = [101, 202, 303, 404, 505, 606, 707, 808];
const UPGRADE_PRIORITY = [
  "splitter-warheads",
  "phase-lance",
  "orbital-drone",
  "gravity-well",
  "arc-conductor",
  "quantum-rails",
  "ion-lens",
  "plasma-overclock",
  "twin-core-reactor",
  "cargo-magnet",
  "combat-scavenger",
  "shield-harmonics",
  "thruster-array",
  "wide-bore",
  "salvage-rig",
  "reactive-plating",
  "reactor-siphon",
  "targeting-ai",
  "med-bay-protocol",
  "capacitor-bank",
  "singularity-array",
];

const args = parseArgs(process.argv.slice(2));
const seeds = args.seeds.length ? args.seeds : DEFAULT_SEEDS;
const maxSeconds = args.seconds ?? 10 * 60;

const results = seeds.map((seed) => simulateRun({ seed, maxSeconds }));
printReport(results, { maxSeconds });

function simulateRun({ seed, maxSeconds }) {
  const simulation = new GameSimulation({
    seed,
    targeting: {
      primaryWeapon: {
        strategy: "nearest",
        maxRange: 1400,
        firingAngleDegrees: 14,
      },
    },
  });

  const dt = GAME.fixedStep;
  const maxTicks = Math.ceil(maxSeconds / dt);

  for (let tick = 0; tick < maxTicks && simulation.state !== "gameover"; tick += 1) {
    if (simulation.state === "upgrade") {
      choosePriorityUpgrade(simulation);
      continue;
    }

    const input = chooseInput(simulation);
    simulation.applyInput(simulation.localPlayerId, input);
    simulation.step(dt);
  }

  const snapshot = simulation.getSnapshot();
  const player = snapshot.players.find((item) => item.id === snapshot.localPlayerId) ?? snapshot.players[0];
  const scrap = calculateRunScrap(snapshot);
  const hours = Math.max(snapshot.elapsed / 3600, 1 / 3600);

  return {
    seed,
    survival: snapshot.elapsed,
    capped: snapshot.state !== "gameover",
    kills: player?.kills ?? 0,
    wave: snapshot.wave,
    level: player?.level ?? 1,
    scrap,
    scrapPerHour: scrap / hours,
  };
}

function choosePriorityUpgrade(simulation) {
  const choices = simulation.pendingUpgradeChoices;
  const byPriority = [...choices].sort((a, b) => {
    const aIndex = UPGRADE_PRIORITY.indexOf(a.id);
    const bIndex = UPGRADE_PRIORITY.indexOf(b.id);
    return priorityRank(aIndex) - priorityRank(bIndex);
  });
  simulation.chooseUpgrade(byPriority[0]?.id ?? choices[0]?.id);
}

function priorityRank(index) {
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

function chooseInput(simulation) {
  const player = simulation.players.get(simulation.localPlayerId);
  if (!player) return { moveX: 0, moveY: 0 };

  const enemies = [...simulation.enemies.values()];
  const nearestEnemy = nearest(player, enemies);
  const nearestPickup = nearest(player, [...simulation.pickups.values()]);

  let moveX = 0;
  let moveY = 0;

  if (nearestEnemy && nearestEnemy.distance < 360) {
    const awayX = player.x - nearestEnemy.entity.x;
    const awayY = player.y - nearestEnemy.entity.y;
    const tangent = simulation.rng.next() < 0.5 ? -1 : 1;
    moveX += awayX * 1.2 + -awayY * 0.35 * tangent;
    moveY += awayY * 1.2 + awayX * 0.35 * tangent;
  } else if (nearestPickup && nearestPickup.distance < 520) {
    moveX += nearestPickup.entity.x - player.x;
    moveY += nearestPickup.entity.y - player.y;
  } else if (nearestEnemy) {
    const awayX = player.x - nearestEnemy.entity.x;
    const awayY = player.y - nearestEnemy.entity.y;
    moveX += -awayY * 0.6 + awayX * 0.25;
    moveY += awayX * 0.6 + awayY * 0.25;
  }

  if (Math.hypot(player.x, player.y) > GAME.worldRadius * 0.75) {
    moveX += -player.x * 0.9;
    moveY += -player.y * 0.9;
  }

  const length = Math.hypot(moveX, moveY);
  if (!length) return { moveX: 0, moveY: 0 };
  return { moveX: moveX / length, moveY: moveY / length };
}

function nearest(origin, entities) {
  let best = null;
  let bestDistanceSq = Infinity;
  for (const entity of entities) {
    const dx = entity.x - origin.x;
    const dy = entity.y - origin.y;
    const distanceSq = dx * dx + dy * dy;
    if (distanceSq < bestDistanceSq) {
      best = entity;
      bestDistanceSq = distanceSq;
    }
  }
  return best ? { entity: best, distance: Math.sqrt(bestDistanceSq) } : null;
}

function printReport(results, { maxSeconds }) {
  const averages = averageResults(results);
  const scrapPerHour = averages.scrapPerHour;
  const meta = defaultMetaProgress();
  const upgradeRows = PERMANENT_UPGRADES.map((upgrade) => {
    const level = meta.upgrades[upgrade.id] ?? 0;
    const cost = upgradeCost(upgrade, level);
    return {
      name: upgrade.name,
      nextLevel: level + 1,
      cost,
      hours: cost / scrapPerHour,
    };
  });

  console.log(`Economy balance sample (${results.length} fixed-seed runs, ${formatTime(maxSeconds)} cap)`);
  console.log("");
  console.log(formatTable(["seed", "survival", "kills", "wave", "level", "scrap", "scrap/hour"], results.map((result) => [
    result.seed,
    `${formatTime(result.survival)}${result.capped ? "*" : ""}`,
    result.kills,
    result.wave,
    result.level,
    result.scrap,
    Math.round(result.scrapPerHour),
  ])));
  console.log("");
  console.log(`Average: survival ${formatTime(averages.survival)}, kills ${averages.kills.toFixed(1)}, wave ${averages.wave.toFixed(1)}, scrap ${averages.scrap.toFixed(1)}, scrap/hour ${Math.round(scrapPerHour)}`);
  if (results.some((result) => result.capped)) {
    console.log("* reached the time cap before game over");
  }
  console.log("");
  console.log("Starter permanent upgrade estimates at average scrap/hour:");
  console.log(formatTable(["upgrade", "next", "cost", "rough time"], upgradeRows.map((row) => [
    row.name,
    row.nextLevel,
    row.cost,
    formatDurationHours(row.hours),
  ])));
}

function averageResults(results) {
  return results.reduce((acc, result, _, list) => {
    const weight = 1 / list.length;
    acc.survival += result.survival * weight;
    acc.kills += result.kills * weight;
    acc.wave += result.wave * weight;
    acc.scrap += result.scrap * weight;
    acc.scrapPerHour += result.scrapPerHour * weight;
    return acc;
  }, { survival: 0, kills: 0, wave: 0, scrap: 0, scrapPerHour: 0 });
}

function formatTable(headers, rows) {
  const strings = [headers, ...rows].map((row) => row.map((cell) => String(cell)));
  const widths = headers.map((_, index) => Math.max(...strings.map((row) => row[index].length)));
  return strings.map((row, rowIndex) => {
    const line = row.map((cell, index) => cell.padEnd(widths[index])).join("  ");
    return rowIndex === 0 ? `${line}\n${widths.map((width) => "-".repeat(width)).join("  ")}` : line;
  }).join("\n");
}

function parseArgs(rawArgs) {
  const parsed = { seeds: [], seconds: null };
  for (const arg of rawArgs) {
    if (arg.startsWith("--seeds=")) {
      parsed.seeds = arg.slice("--seeds=".length).split(",").map((value) => Number.parseInt(value, 10)).filter(Number.isFinite);
    } else if (arg.startsWith("--seconds=")) {
      const value = Number.parseFloat(arg.slice("--seconds=".length));
      if (Number.isFinite(value) && value > 0) parsed.seconds = value;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }
  return parsed;
}

function printHelp() {
  console.log("Usage: node scripts/economy-balance.mjs [--seeds=101,202,303] [--seconds=600]");
  console.log("");
  console.log("Runs deterministic GameSimulation samples and prints scrap economy estimates.");
}

function formatTime(seconds) {
  const total = Math.round(seconds);
  const minutes = Math.floor(total / 60);
  const remainder = total % 60;
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function formatDurationHours(hours) {
  if (!Number.isFinite(hours) || hours <= 0) return "n/a";
  if (hours < 1 / 60) return "<1m";
  if (hours < 1) return `${Math.ceil(hours * 60)}m`;
  return `${hours.toFixed(1)}h`;
}
