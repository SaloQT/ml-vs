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
const watchPpo = document.querySelector("#watch-ppo");
const ppoWatchFile = document.querySelector("#ppo-watch-file");
const savePpo = document.querySelector("#save-ppo");
const loadPpo = document.querySelector("#load-ppo");
const ppoModelFile = document.querySelector("#ppo-model-file");
const ppoAverageWindowInput = document.querySelector("#ppo-average-window");
const ppoLrInput = document.querySelector("#ppo-lr");
const ppoClipInput = document.querySelector("#ppo-clip");
const ppoGammaInput = document.querySelector("#ppo-gamma");
const ppoBatchInput = document.querySelector("#ppo-batch");
const ppoGameLengthInput = document.querySelector("#ppo-game-length");
const ppoWarmupInput = document.querySelector("#ppo-warmup");
const ppoAdvClampInput = document.querySelector("#ppo-adv-clamp");
const ppoKillRewardInput = document.querySelector("#ppo-kill-reward");
const ppoXpRewardInput = document.querySelector("#ppo-xp-reward");
const ppoPowerupRewardInput = document.querySelector("#ppo-powerup-reward");
const ppoDmgTakenInput = document.querySelector("#ppo-dmg-taken");
const ppoSurvivalBonusInput = document.querySelector("#ppo-survival-bonus");
const ppoDeathPenaltyInput = document.querySelector("#ppo-death-penalty");
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
const input = new InputController(canvas);
let metaProgress = loadMetaProgress();
let ppoTrainer = new PpoTrainer({ metaProgress });
let simulation = createSimulation();
let runMode = null; // "player" | "watch" | null
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
  runMode = "player";
  runRewardAwarded = false;
  mainMenu.classList.add("hidden");
  canvas.focus?.();
});

watchPpo.addEventListener("click", () => ppoWatchFile.click());

ppoWatchFile.addEventListener("change", async () => {
  const [file] = ppoWatchFile.files ?? [];
  if (!file) return;
  try {
    const text = await file.text();
    const model = JSON.parse(text);
    ppoTrainer.importModel(model);
    ppoTrainer.metaProgress = metaProgress;
  } catch (error) {
    window.alert(error instanceof Error ? error.message : "Unable to load PPO model.");
    ppoWatchFile.value = "";
    return;
  }
  ppoWatchFile.value = "";
  simulation = new GameSimulation({ seed: 1337 + Math.floor(performance.now()), localPlayerId: "ppo", metaProgress });
  accumulator = 0;
  lastTime = performance.now();
  resetDebugMeters();
  runMode = "watch";
  runRewardAwarded = false;
  ppoRunning = false;
  closePanel(ppoPanel, openPpo);
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
savePpo.addEventListener("click", savePpoModel);
loadPpo.addEventListener("click", () => ppoModelFile.click());
ppoModelFile.addEventListener("change", loadPpoModel);

ppoAverageWindowInput?.addEventListener("change", () => {
  ppoGraphAverageWindow = clampInteger(ppoAverageWindowInput.value, 1, 1000, 8);
  ppoAverageWindowInput.value = String(ppoGraphAverageWindow);
  renderPpoPanel();
});

ppoLrInput?.addEventListener("change", () => {
  const v = parseFloat(ppoLrInput.value);
  ppoTrainer.learningRate = Number.isFinite(v) && v > 0 ? v : 0.00004;
  ppoLrInput.value = String(ppoTrainer.learningRate);
});
ppoClipInput?.addEventListener("change", () => {
  const v = parseFloat(ppoClipInput.value);
  ppoTrainer.clip = Number.isFinite(v) && v > 0 ? Math.min(v, 0.5) : 0.12;
  ppoClipInput.value = String(ppoTrainer.clip);
});
ppoGammaInput?.addEventListener("change", () => {
  const v = parseFloat(ppoGammaInput.value);
  ppoTrainer.gamma = Number.isFinite(v) ? Math.max(0.9, Math.min(v, 1)) : 0.985;
  ppoGammaInput.value = String(ppoTrainer.gamma);
});
ppoBatchInput?.addEventListener("change", () => {
  ppoTrainer.batchSize = clampInteger(ppoBatchInput.value, 1, 32, 2);
  ppoBatchInput.value = String(ppoTrainer.batchSize);
});
ppoGameLengthInput?.addEventListener("change", () => {
  ppoTrainer.maxEpisodeSeconds = clampInteger(ppoGameLengthInput.value, 10, 300, 45);
  ppoGameLengthInput.value = String(ppoTrainer.maxEpisodeSeconds);
});
ppoWarmupInput?.addEventListener("change", () => {
  ppoTrainer.warmupSeconds = clampInteger(ppoWarmupInput.value, 0, 30, 3);
  ppoWarmupInput.value = String(ppoTrainer.warmupSeconds);
});

function clampFloat(value, min, max, fallback) {
  const v = parseFloat(value);
  return Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : fallback;
}

ppoAdvClampInput?.addEventListener("change", () => {
  ppoTrainer.advantageClamp = clampFloat(ppoAdvClampInput.value, 0.5, 10, 3);
  ppoAdvClampInput.value = String(ppoTrainer.advantageClamp);
});
ppoKillRewardInput?.addEventListener("change", () => {
  ppoTrainer.killReward = clampFloat(ppoKillRewardInput.value, 0, 50, 7.5);
  ppoKillRewardInput.value = String(ppoTrainer.killReward);
});
ppoXpRewardInput?.addEventListener("change", () => {
  ppoTrainer.xpReward = clampFloat(ppoXpRewardInput.value, 0, 5, 0.08);
  ppoXpRewardInput.value = String(ppoTrainer.xpReward);
});
ppoPowerupRewardInput?.addEventListener("change", () => {
  ppoTrainer.powerupReward = clampFloat(ppoPowerupRewardInput.value, 0, 20, 0.7);
  ppoPowerupRewardInput.value = String(ppoTrainer.powerupReward);
});
ppoDmgTakenInput?.addEventListener("change", () => {
  ppoTrainer.damageTakenPenalty = clampFloat(ppoDmgTakenInput.value, 0, 2, 0.16);
  ppoDmgTakenInput.value = String(ppoTrainer.damageTakenPenalty);
});
ppoSurvivalBonusInput?.addEventListener("change", () => {
  ppoTrainer.survivalBonus = clampFloat(ppoSurvivalBonusInput.value, 0, 0.5, 0.025);
  ppoSurvivalBonusInput.value = String(ppoTrainer.survivalBonus);
});
ppoDeathPenaltyInput?.addEventListener("change", () => {
  ppoTrainer.deathPenalty = clampFloat(ppoDeathPenaltyInput.value, 0, 200, 35);
  ppoDeathPenaltyInput.value = String(ppoTrainer.deathPenalty);
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
  } else if (event.key === "Escape" && runMode === "watch") {
    runMode = null;
    mainMenu.classList.remove("hidden");
    openPanel(ppoPanel, startPpo);
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

  if (runMode === "player") {
    accumulator += delta;
    simulation.applyInput(simulation.localPlayerId, input.sample());
    while (accumulator >= GAME.fixedStep) {
      simulation.step(GAME.fixedStep);
      accumulator -= GAME.fixedStep;
    }
    awardRunScrapIfNeeded();
    if (simulation.state === "gameover") runMode = null;
  } else if (runMode === "watch") {
    accumulator += delta;
    simulation.applyInput(simulation.localPlayerId, ppoTrainer.act(simulation));
    while (accumulator >= GAME.fixedStep) {
      simulation.step(GAME.fixedStep);
      if (simulation.state === "upgrade") ppoTrainer.act(simulation);
      accumulator -= GAME.fixedStep;
    }
    if (simulation.state === "gameover") {
      simulation = new GameSimulation({ seed: 1337 + Math.floor(performance.now()), localPlayerId: "ppo", metaProgress });
      accumulator = 0;
      resetDebugMeters();
    }
  } else if (ppoRunning && !ppoPanel.classList.contains("hidden")) {
    ppoTrainer.trainBatch();
    renderPpoPanel();
  }

  const snapshot = runMode ? simulation.getSnapshot() : menuSnapshot();
  renderer.render(snapshot);
  syncUpgradePanel(snapshot, runMode === "player");
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

function savePpoModel() {
  const model = ppoTrainer.exportModel();
  const blob = new Blob([JSON.stringify(model, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `space-survivors-ppo-iter-${model.iteration}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(link.href);
}

async function loadPpoModel() {
  const [file] = ppoModelFile.files ?? [];
  if (!file) return;
  try {
    const model = JSON.parse(await file.text());
    ppoTrainer.importModel(model);
    ppoTrainer.metaProgress = metaProgress;
    ppoRunning = false;
    startPpo.textContent = "Start";
    renderPpoPanel();
  } catch (error) {
    window.alert(error instanceof Error ? error.message : "Unable to load PPO model.");
  } finally {
    ppoModelFile.value = "";
  }
}

function renderArmory() {
  document.querySelector("#scrap-count").textContent = String(metaProgress.scrap);
  const slotTone = {
    weapon: "Ballistic Control",
    hull: "Frame Bay",
    utility: "Support Rig",
  };
  const permanentRoot = document.querySelector("#permanent-upgrades");
  permanentRoot.replaceChildren(
    ...PERMANENT_UPGRADES.map((upgrade) => {
      const level = metaProgress.upgrades[upgrade.id] ?? 0;
      const cost = upgradeCost(upgrade, level);
      const progress = Math.round((level / upgrade.maxLevel) * 100);
      const row = document.createElement("div");
      row.className = `system-row armory-upgrade-row${level >= upgrade.maxLevel ? " maxed" : ""}`;
      row.innerHTML = `
        <div class="system-row-title">
          <span class="equipment-sprite equipment-sprite-${upgrade.icon ?? upgrade.id}" aria-hidden="true"></span>
          <div>
            <strong>${upgrade.name}</strong>
            <span>Permanent</span>
          </div>
        </div>
        <p>${upgrade.description}</p>
        <div class="upgrade-progress" aria-label="${upgrade.name} level ${level} of ${upgrade.maxLevel}">
          <span style="width: ${progress}%"></span>
        </div>
        <div class="armory-meta-line"><span>Level ${level}/${upgrade.maxLevel}</span><span>${level >= upgrade.maxLevel ? "Calibrated" : `${cost} scrap`}</span></div>
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
          <span class="equipment-sprite equipment-sprite-${currentItem.icon ?? currentItem.id}" aria-hidden="true"></span>
          <div>
            <span>${slotTone[slot] ?? "Loadout Slot"}</span>
            <strong>${currentItem.name}</strong>
            <small>${EQUIPMENT_SLOTS[slot] ?? slot} equipped</small>
          </div>
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
            <span class="equipped-badge">${selected ? "Equipped" : "Available"}</span>
            <div class="equipment-row-title">
              <span class="equipment-sprite equipment-sprite-${item.icon ?? item.id}" aria-hidden="true"></span>
              <div>
                <strong>${item.name}</strong>
                <span>${EQUIPMENT_SLOTS[slot] ?? slot}</span>
              </div>
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
    { key: "deathRate", label: "Death", color: "#b86cff", suffix: "%" },
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
  if (values.length < windowSize) return [];
  const out = new Array(values.length - windowSize + 1);
  let sum = 0;
  for (let i = 0; i < windowSize; i += 1) sum += values[i];
  out[0] = sum / windowSize;
  for (let i = windowSize; i < values.length; i += 1) {
    sum += values[i] - values[i - windowSize];
    out[i - windowSize + 1] = sum / windowSize;
  }
  return out;
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

initPpoSpinners();
initPpoTooltips();
requestAnimationFrame(frame);

function initPpoSpinners() {
  const inputs = document.querySelectorAll(".ppo-param-pill input, .ppo-average-control input, .ppo-sidebar-row input");
  for (const input of inputs) {
    const step = parseFloat(input.step) || 1;
    const min = input.min !== "" ? parseFloat(input.min) : -Infinity;
    const max = input.max !== "" ? parseFloat(input.max) : Infinity;

    const wrapper = document.createElement("div");
    wrapper.className = "ppo-spinner";

    const dec = document.createElement("button");
    dec.type = "button";
    dec.className = "ppo-spinner-btn";
    dec.textContent = "−";
    dec.addEventListener("mousedown", (e) => {
      e.preventDefault();
      nudge(input, -step, min, max);
    });

    const inc = document.createElement("button");
    inc.type = "button";
    inc.className = "ppo-spinner-btn";
    inc.textContent = "+";
    inc.addEventListener("mousedown", (e) => {
      e.preventDefault();
      nudge(input, +step, min, max);
    });

    input.parentNode.insertBefore(wrapper, input);
    wrapper.appendChild(dec);
    wrapper.appendChild(input);
    wrapper.appendChild(inc);
  }
}

function nudge(input, delta, min, max) {
  const decimals = (String(input.step).split(".")[1] ?? "").length;
  const current = parseFloat(input.value) || 0;
  const next = Math.max(min, Math.min(max, current + delta));
  input.value = decimals > 0 ? next.toFixed(decimals) : String(next);
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function initPpoTooltips() {
  const rows = document.querySelectorAll(".ppo-sidebar-row[data-tooltip-title]");
  if (!rows.length) return;

  const tooltip = document.createElement("div");
  tooltip.className = "ppo-tooltip";
  tooltip.role = "tooltip";
  tooltip.innerHTML = "<strong></strong><span></span>";
  document.body.append(tooltip);

  for (const row of rows) {
    row.addEventListener("mouseenter", () => showPpoTooltip(row, tooltip));
    row.addEventListener("mousemove", () => positionPpoTooltip(row, tooltip));
    row.addEventListener("mouseleave", () => hidePpoTooltip(tooltip));
    row.addEventListener("focusin", () => showPpoTooltip(row, tooltip));
    row.addEventListener("focusout", () => hidePpoTooltip(tooltip));
  }
}

function showPpoTooltip(row, tooltip) {
  tooltip.querySelector("strong").textContent = row.dataset.tooltipTitle ?? "";
  tooltip.querySelector("span").textContent = row.dataset.tooltipBody ?? "";
  tooltip.classList.add("visible");
  positionPpoTooltip(row, tooltip);
}

function hidePpoTooltip(tooltip) {
  tooltip.classList.remove("visible");
}

function positionPpoTooltip(row, tooltip) {
  const rect = row.getBoundingClientRect();
  const tooltipRect = tooltip.getBoundingClientRect();
  const gap = 10;
  const roomRight = window.innerWidth - rect.right;
  const left =
    roomRight >= tooltipRect.width + gap
      ? rect.right + gap
      : Math.max(14, rect.left - tooltipRect.width - gap);
  const top = Math.max(14, Math.min(window.innerHeight - tooltipRect.height - 14, rect.top - 4));
  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
}
