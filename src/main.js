import { GAME } from "./config.js";
import { InputController } from "./input.js";
import {
  calculateRunScrap,
  EQUIPMENT,
  EQUIPMENT_SLOTS,
  META_STORAGE_KEY,
  normalizeMetaProgress,
  PERMANENT_UPGRADES,
  upgradeCost,
} from "./metaProgression.js";
import { PpoTrainer } from "./ppoTrainer.js";
import { Renderer } from "./render.js";
import { GameSimulation } from "./simulation.js";

const canvas = document.querySelector("#game");
const mainMenu = document.querySelector("#main-menu");
const startRun = document.querySelector("#start-run");
const openArmory = document.querySelector("#open-armory");
const openOptions = document.querySelector("#open-options");
const openPpo = document.querySelector("#open-ppo");
const armoryPanel = document.querySelector("#armory-panel");
const closeArmory = document.querySelector("#close-armory");
const ppoPanel = document.querySelector("#ppo-panel");
const closePpo = document.querySelector("#close-ppo");
const startPpo = document.querySelector("#start-ppo");
const ppoAverageWindowInput = document.querySelector("#ppo-average-window");
const ppoGraphs = [...document.querySelectorAll("[data-ppo-chart]")];
const closeOptions = document.querySelector("#close-options");
const optionsPanel = document.querySelector("#options-panel");
const optionInputs = {
  screenShake: document.querySelector("#option-screen-shake"),
  lighting: document.querySelector("#option-lighting"),
  particles: document.querySelector("#option-particles"),
};
const upgradePanel = document.querySelector("#upgrade-panel");
const upgradeOptions = document.querySelector("#upgrade-options");
const debugOverlay = document.querySelector("#debug-overlay");

const visualOptions = loadVisualOptions();
const renderer = new Renderer(canvas, visualOptions);
const input = new InputController();
let metaProgress = loadMetaProgress();
let ppoTrainer = new PpoTrainer({ metaProgress });
let simulation = createSimulation();
let runStarted = false;
let runRewardAwarded = false;
let ppoRunning = false;

let accumulator = 0;
let lastTime = performance.now();
let debugVisible = false;
const fpsMeter = {
  frames: 0,
  lastSample: performance.now(),
  value: 0,
};
const damageMeter = {
  seenEffectIds: new Set(),
  samples: [],
  total: 0,
  windowSeconds: 5,
};
let ppoGraphAverageWindow = Number.parseInt(ppoAverageWindowInput?.value ?? "8", 10) || 8;

startRun.addEventListener("click", () => {
  simulation = createSimulation();
  accumulator = 0;
  lastTime = performance.now();
  resetDebugMeters();
  runStarted = true;
  runRewardAwarded = false;
  mainMenu.classList.add("hidden");
  canvas.focus?.();
});

openArmory.addEventListener("click", () => openPanel(armoryPanel, closeArmory));
openOptions.addEventListener("click", () => {
  optionsPanel.classList.remove("hidden");
  closeOptions.focus();
});
openPpo.addEventListener("click", () => openPanel(ppoPanel, startPpo));

closeOptions.addEventListener("click", closeOptionsPanel);
closeArmory.addEventListener("click", () => closePanel(armoryPanel, openArmory));
closePpo.addEventListener("click", () => closePanel(ppoPanel, openPpo));
startPpo.addEventListener("click", () => {
  ppoRunning = !ppoRunning;
  startPpo.textContent = ppoRunning ? "Pause" : "Start";
});

ppoAverageWindowInput?.addEventListener("change", () => {
  ppoGraphAverageWindow = clampInteger(ppoAverageWindowInput.value, 1, 50, 8);
  ppoAverageWindowInput.value = String(ppoGraphAverageWindow);
  renderPpoPanel();
});

optionsPanel.addEventListener("click", (event) => {
  if (event.target === optionsPanel) closeOptionsPanel();
});

window.addEventListener("keydown", (event) => {
  if (event.key === "F3" || event.key === "`") {
    event.preventDefault();
    debugVisible = !debugVisible;
    debugOverlay.classList.toggle("hidden", !debugVisible);
  } else if (event.key === "Escape" && !optionsPanel.classList.contains("hidden")) {
    closeOptionsPanel();
  } else if (event.key === "Escape" && !armoryPanel.classList.contains("hidden")) {
    closePanel(armoryPanel, openArmory);
  } else if (event.key === "Escape" && !ppoPanel.classList.contains("hidden")) {
    closePanel(ppoPanel, openPpo);
  }
});

for (const [key, inputElement] of Object.entries(optionInputs)) {
  inputElement.checked = visualOptions[key];
  inputElement.addEventListener("change", () => {
    visualOptions[key] = inputElement.checked;
    renderer.setOptions(visualOptions);
    saveVisualOptions(visualOptions);
  });
}

function frame(now) {
  const delta = Math.min((now - lastTime) / 1000, GAME.maxDelta);
  lastTime = now;
  updateFps(now);

  if (runStarted) {
    accumulator += delta;
    simulation.applyInput(simulation.localPlayerId, input.sample());
    while (accumulator >= GAME.fixedStep) {
      simulation.step(GAME.fixedStep);
      accumulator -= GAME.fixedStep;
    }
    awardRunScrapIfNeeded();
  } else if (ppoRunning && !ppoPanel.classList.contains("hidden")) {
    ppoTrainer.trainBatch(2);
    renderPpoPanel();
  }

  const snapshot = runStarted ? simulation.getSnapshot() : menuSnapshot();
  renderer.render(snapshot);
  syncUpgradePanel(snapshot, runStarted);
  updateDebugOverlay(snapshot);
  requestAnimationFrame(frame);
}

function createSimulation() {
  return new GameSimulation({ seed: 1337 + Math.floor(performance.now()), localPlayerId: "captain", metaProgress });
}

function awardRunScrapIfNeeded() {
  if (runRewardAwarded || simulation.state !== "gameover") return;
  const snapshot = simulation.getSnapshot();
  const scrap = calculateRunScrap(snapshot);
  metaProgress.scrap += scrap;
  metaProgress.best.seconds = Math.max(metaProgress.best.seconds, Math.floor(snapshot.elapsed));
  metaProgress.best.wave = Math.max(metaProgress.best.wave, snapshot.wave);
  runRewardAwarded = true;
  saveMetaProgress();
}

function resetDebugMeters() {
  damageMeter.seenEffectIds.clear();
  damageMeter.samples = [];
  damageMeter.total = 0;
}

function updateFps(now) {
  fpsMeter.frames += 1;
  const elapsed = now - fpsMeter.lastSample;
  if (elapsed < 500) return;
  fpsMeter.value = Math.round((fpsMeter.frames * 1000) / elapsed);
  fpsMeter.frames = 0;
  fpsMeter.lastSample = now;
}

function updateDamageMeter(snapshot) {
  for (const effect of snapshot.effects ?? []) {
    const damage = Number(effect.damage);
    if (!effect.id || damage <= 0 || damageMeter.seenEffectIds.has(effect.id)) continue;
    damageMeter.seenEffectIds.add(effect.id);
    damageMeter.samples.push({ time: snapshot.elapsed, damage });
    damageMeter.total += damage;
  }

  const oldest = snapshot.elapsed - damageMeter.windowSeconds;
  damageMeter.samples = damageMeter.samples.filter((sample) => sample.time >= oldest);
  if (damageMeter.seenEffectIds.size > 500) {
    const liveEffectIds = new Set((snapshot.effects ?? []).map((effect) => effect.id));
    damageMeter.seenEffectIds = new Set([...damageMeter.seenEffectIds].filter((id) => liveEffectIds.has(id)));
  }
}

function updateDebugOverlay(snapshot) {
  updateDamageMeter(snapshot);
  if (!debugVisible) return;
  const player = snapshot.players.find((item) => item.id === snapshot.localPlayerId) ?? snapshot.players[0];
  const damageWindowTotal = damageMeter.samples.reduce((total, sample) => total + sample.damage, 0);
  const dps = damageWindowTotal / damageMeter.windowSeconds;
  const rows = [
    ["FPS", fpsMeter.value],
    ["Tick", snapshot.tick],
    ["Elapsed", formatDebugTime(snapshot.elapsed)],
    ["State", snapshot.state],
    ["Wave", snapshot.wave],
    ["Enemies", snapshot.enemies.length],
    ["Projectiles", snapshot.projectiles.length],
    ["Pickups", snapshot.pickups.length],
    ["Player HP", player ? `${Math.ceil(player.hp)}/${Math.ceil(player.stats.maxHp)}` : "-"],
    ["Level", player?.level ?? "-"],
    ["Kills", player?.kills ?? "-"],
    ["DPS", dps.toFixed(1)],
    ["Damage", Math.round(damageMeter.total)],
  ];

  debugOverlay.replaceChildren(
    ...rows.map(([label, value]) => {
      const row = document.createElement("div");
      row.className = "debug-row";
      row.append(createDebugCell(label, "debug-label"), createDebugCell(value, "debug-value"));
      return row;
    }),
  );
}

function createDebugCell(value, className) {
  const cell = document.createElement("span");
  cell.className = className;
  cell.textContent = String(value);
  return cell;
}

function formatDebugTime(seconds) {
  const safeSeconds = Math.max(0, seconds);
  const minutes = Math.floor(safeSeconds / 60);
  const remainder = Math.floor(safeSeconds % 60);
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function openPanel(panel, focusTarget) {
  renderArmory();
  renderPpoPanel();
  panel.classList.remove("hidden");
  focusTarget.focus();
}

function closePanel(panel, focusTarget) {
  panel.classList.add("hidden");
  focusTarget.focus();
}

function closeOptionsPanel() {
  optionsPanel.classList.add("hidden");
  openOptions.focus();
}

function loadVisualOptions() {
  const defaults = {
    screenShake: GAME.screenShake,
    lighting: GAME.lighting,
    particles: GAME.particles,
  };
  try {
    const stored = JSON.parse(localStorage.getItem("space-survivors-options") ?? "{}");
    return {
      ...defaults,
      ...Object.fromEntries(Object.entries(stored).filter(([, value]) => typeof value === "boolean")),
    };
  } catch {
    return defaults;
  }
}

function loadMetaProgress() {
  try {
    return normalizeMetaProgress(JSON.parse(localStorage.getItem(META_STORAGE_KEY) ?? "{}"));
  } catch {
    return normalizeMetaProgress();
  }
}

function saveMetaProgress() {
  localStorage.setItem(META_STORAGE_KEY, JSON.stringify(metaProgress));
  ppoTrainer.metaProgress = metaProgress;
}

function renderArmory() {
  document.querySelector("#scrap-count").textContent = String(metaProgress.scrap);
  const permanentRoot = document.querySelector("#permanent-upgrades");
  permanentRoot.replaceChildren(
    ...PERMANENT_UPGRADES.map((upgrade) => {
      const level = metaProgress.upgrades[upgrade.id] ?? 0;
      const cost = upgradeCost(upgrade, level);
      const row = document.createElement("div");
      row.className = "system-row";
      row.innerHTML = `
        <strong>${upgrade.name} ${level}/${upgrade.maxLevel}</strong>
        <p>${upgrade.description}</p>
        <button type="button" ${level >= upgrade.maxLevel || metaProgress.scrap < cost ? "disabled" : ""}>
          ${level >= upgrade.maxLevel ? "Maxed" : `Upgrade ${cost}`}
        </button>
      `;
      row.querySelector("button").addEventListener("click", () => {
        if (metaProgress.scrap < cost || level >= upgrade.maxLevel) return;
        metaProgress.scrap -= cost;
        metaProgress.upgrades[upgrade.id] = level + 1;
        saveMetaProgress();
        renderArmory();
      });
      return row;
    }),
  );

  const equipmentRoot = document.querySelector("#equipment-list");
  equipmentRoot.replaceChildren(
    ...Object.entries(EQUIPMENT).map(([slot, items]) => {
      const currentItem = items.find((item) => item.id === metaProgress.equipment[slot]) ?? items[0];
      const group = document.createElement("section");
      group.className = "equipment-slot";
      group.innerHTML = `
        <div class="equipment-slot-header">
          <span>${EQUIPMENT_SLOTS[slot] ?? slot}</span>
          <strong>${currentItem.name}</strong>
        </div>
      `;
      const choices = document.createElement("div");
      choices.className = "equipment-slot-choices";
      choices.replaceChildren(
        ...items.map((item) => {
          const selected = metaProgress.equipment[slot] === item.id;
          const row = document.createElement("div");
          row.className = `system-row equipment-row${selected ? " equipped" : ""}`;
          row.innerHTML = `
            <div class="equipment-row-title">
              <strong>${item.name}</strong>
              <span>${selected ? "Current" : EQUIPMENT_SLOTS[slot] ?? slot}</span>
            </div>
            <p>${item.description}</p>
            <ul>${item.effects.map((effect) => `<li>${effect}</li>`).join("")}</ul>
            <button type="button" ${selected ? "disabled" : ""}>${selected ? "Equipped" : "Equip"}</button>
          `;
          row.querySelector("button").addEventListener("click", () => {
            metaProgress.equipment[slot] = item.id;
            saveMetaProgress();
            renderArmory();
          });
          return row;
        }),
      );
      group.append(choices);
      return group;
    }),
  );
}

function renderPpoPanel() {
  const last = ppoTrainer.history.at(-1) ?? {
    iteration: 0,
    score: 0,
    seconds: 0,
    kills: 0,
    damage: 0,
    deathRate: 0,
  };
  document.querySelector("#ppo-iteration").textContent = String(last.iteration);
  document.querySelector("#ppo-score").textContent = String(last.score);
  document.querySelector("#ppo-survival").textContent = `${last.seconds}s`;
  document.querySelector("#ppo-kills").textContent = String(last.kills);
  document.querySelector("#ppo-damage").textContent = String(last.damage);
  document.querySelector("#ppo-death").textContent = `${last.deathRate}%`;
  drawPpoGraph(ppoTrainer.history);
}

function drawPpoGraph(history) {
  const charts = [
    { key: "score", label: "Score", color: "#64d9ff", suffix: "" },
    { key: "damage", label: "Damage", color: "#ff5b79", suffix: "" },
    { key: "kills", label: "Kills", color: "#ffc857", suffix: "" },
    { key: "deathRate", label: "Death", color: "#b86cff", suffix: "%", invert: true },
  ];
  for (const chart of charts) {
    const canvas = ppoGraphs.find((item) => item.dataset.ppoChart === chart.key);
    if (canvas) drawSinglePpoGraph(canvas, history, chart);
  }
}

function drawSinglePpoGraph(canvas, history, chart) {
  const ctx = canvas.getContext("2d");
  const { width, height } = canvas;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "rgba(3, 8, 18, 0.88)";
  ctx.fillRect(0, 0, width, height);
  const values = history.map((point) => point[chart.key] ?? 0);
  const averageWindow = Math.max(1, ppoGraphAverageWindow);
  const smoothedValues = rollingAverage(values, averageWindow);
  const graphValues = smoothedValues.length ? smoothedValues : values;
  const average = values.length ? mean(values.slice(-averageWindow)) : 0;
  const min = values.length ? Math.min(...values) : 0;
  const max = values.length ? Math.max(...values) : 1;
  const graphMin = graphValues.length ? Math.min(...graphValues, average) : 0;
  const graphMax = graphValues.length ? Math.max(...graphValues, average) : 1;
  ctx.font = "800 12px Inter, system-ui, sans-serif";
  ctx.fillStyle = chart.color;
  ctx.fillText(`${chart.label} avg ${averageWindow}`, 14, 18);
  ctx.fillStyle = "#91a8bd";
  ctx.textAlign = "right";
  ctx.fillText(`${formatGraphValue(average, chart.suffix)} avg`, width - 14, 18);
  ctx.fillText(`${formatGraphValue(max, chart.suffix)} max / ${formatGraphValue(min, chart.suffix)} min`, width - 14, height - 12);
  ctx.textAlign = "left";
  ctx.strokeStyle = "rgba(100, 217, 255, 0.14)";
  for (let i = 0; i < 6; i += 1) {
    const y = 30 + (height - 56) * (i / 5);
    ctx.beginPath();
    ctx.moveTo(14, y);
    ctx.lineTo(width - 14, y);
    ctx.stroke();
  }
  drawAverageReferenceLine(ctx, average, chart, width, height, graphMin, graphMax);
  drawLine(ctx, graphValues, chart.color, width, height, chart.invert, graphMin, graphMax);
}

function drawLine(ctx, values, color, width, height, invert = false, min = 0, max = null) {
  if (values.length < 2) return;
  const range = Math.max(1, (max ?? Math.max(...values, 1)) - min);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  values.forEach((value, index) => {
    const x = 14 + ((width - 28) * index) / Math.max(1, values.length - 1);
    const normalized = (value - min) / range;
    const y = invert ? 30 + (height - 56) * normalized : height - 26 - (height - 56) * normalized;
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

function drawAverageReferenceLine(ctx, average, chart, width, height, min, max) {
  const range = Math.max(1, max - min);
  const normalized = (average - min) / range;
  const y = chart.invert ? 30 + (height - 56) * normalized : height - 26 - (height - 56) * normalized;
  ctx.save();
  ctx.strokeStyle = "rgba(237, 247, 255, 0.42)";
  ctx.setLineDash([6, 5]);
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(14, y);
  ctx.lineTo(width - 14, y);
  ctx.stroke();
  ctx.fillStyle = "rgba(237, 247, 255, 0.72)";
  ctx.font = "700 10px Inter, system-ui, sans-serif";
  ctx.textAlign = "left";
  ctx.fillText("avg", 16, Math.max(34, y - 5));
  ctx.restore();
}

function rollingAverage(values, windowSize) {
  return values.map((_, index) => {
    const start = Math.max(0, index - windowSize + 1);
    return mean(values.slice(start, index + 1));
  });
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

function clampInteger(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function formatGraphValue(value, suffix) {
  return `${Math.round(value)}${suffix}`;
}

function saveVisualOptions(options) {
  localStorage.setItem("space-survivors-options", JSON.stringify(options));
}

function menuSnapshot() {
  return {
    ...simulation.getSnapshot(),
    localPlayerId: null,
    players: [],
    enemies: [],
    projectiles: [],
    pickups: [],
    effects: [],
  };
}

function syncUpgradePanel(snapshot, active) {
  const visible = active && snapshot.state === "upgrade";
  upgradePanel.classList.toggle("hidden", !visible);
  if (!visible) return;

  const existing = new Set([...upgradeOptions.children].map((child) => child.dataset.id));
  const incoming = new Set(snapshot.pendingUpgradeChoices.map((upgrade) => upgrade.id));
  const alreadyRendered =
    existing.size === incoming.size && [...incoming].every((upgradeId) => existing.has(upgradeId));
  if (alreadyRendered) return;

  upgradeOptions.replaceChildren(
    ...snapshot.pendingUpgradeChoices.map((upgrade) => {
      const button = document.createElement("button");
      button.className = "upgrade-card";
      button.type = "button";
      button.dataset.id = upgrade.id;
      button.dataset.rarity = upgrade.rarity;
      button.innerHTML = `
        <span class="upgrade-icon" aria-hidden="true"></span>
        <span class="rarity">${upgrade.rarity}</span>
        <h2>${upgrade.name}</h2>
        <p>${upgrade.description}</p>
      `;
      button.addEventListener("click", () => simulation.chooseUpgrade(upgrade.id));
      return button;
    }),
  );
  upgradeOptions.querySelector("button")?.focus();
}

requestAnimationFrame(frame);
