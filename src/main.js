import { GAME, PLAYER_BASE } from "./config.js";
import { createPlayer } from "./entities.js";
import { InputController, TARGET_MODE_LABELS } from "./input.js";
import {
  applyMetaProgress,
  calculateRunScrap,
  discountedUpgradeCost,
  EQUIPMENT,
  EQUIPMENT_SLOTS,
  featuredUpgradeIdForDate,
  formatRankLabel,
  isEquipmentUnlocked,
  META_STORAGE_KEY,
  nextRankCost,
  nextRankEffectDelta,
  normalizeMetaProgress,
  PERMANENT_UPGRADES,
  prestigeProgressFraction,
  prestigeTierIndex,
  upgradeCost,
} from "./metaProgression.js";
import { PpoTrainer } from "./ppoTrainer.js";
import { PpoWorkerPool } from "./ppoWorkerPool.js";
import { Renderer } from "./render.js";
import { GameSimulation } from "./simulation.js";

const canvas = document.querySelector("#game");
const mainMenu = document.querySelector("#main-menu");
const launchControls = document.querySelector("#launch-controls");
const openArmory = document.querySelector("#open-armory");
const openOptions = document.querySelector("#open-options");
const openPpo = document.querySelector("#open-ppo");
const armoryPanel = document.querySelector("#armory-panel");
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
const ppoWorkersInput = document.querySelector("#ppo-workers");
const ppoGameLengthInput = document.querySelector("#ppo-game-length");
const ppoWarmupInput = document.querySelector("#ppo-warmup");
const ppoAdvClampInput = document.querySelector("#ppo-adv-clamp");
const ppoFilterDeathsInput = document.querySelector("#ppo-filter-deaths");
const ppoKillRewardInput = document.querySelector("#ppo-kill-reward");
const ppoXpRewardInput = document.querySelector("#ppo-xp-reward");
const ppoPowerupRewardInput = document.querySelector("#ppo-powerup-reward");
const ppoDmgTakenInput = document.querySelector("#ppo-dmg-taken");
const ppoDamageRewardInput = document.querySelector("#ppo-damage-reward");
const ppoSurvivalBonusInput = document.querySelector("#ppo-survival-bonus");
const ppoDeathPenaltyInput = document.querySelector("#ppo-death-penalty");
const ppoKillStreakRewardInput = document.querySelector("#ppo-kill-streak-reward");
const ppoEnemyHpMultInput = document.querySelector("#ppo-enemy-hp-mult");
const ppoEnemySpeedMultInput = document.querySelector("#ppo-enemy-speed-mult");
const ppoEnemySpawnMultInput = document.querySelector("#ppo-enemy-spawn-mult");
const ppoGraphs = [...document.querySelectorAll("[data-ppo-chart]")];
const closeOptions = document.querySelector("#close-options");
const optionsPanel = document.querySelector("#options-panel");
const optionInputs = {
  screenShake: document.querySelector("#option-screen-shake"),
  lighting: document.querySelector("#option-lighting"),
  particles: document.querySelector("#option-particles"),
  alwaysLaunch: document.querySelector("#option-always-launch"),
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
let lastRunReward = null; // { scrap, breakdown }
refreshMenuScrap();
let ppoRunning = false;
let ppoTrainingPromise = null;
let ppoTrainingGeneration = 0;
const ppoWorkerPool = new PpoWorkerPool();
if (ppoWorkersInput) ppoWorkersInput.value = String(ppoWorkerPool.workerCount);

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

function startPlayerRun() {
  simulation = createSimulation();
  accumulator = 0;
  lastTime = performance.now();
  resetDebugMeters();
  runMode = "player";
  runRewardAwarded = false;
  lastRunReward = null;
  mainMenu.classList.add("hidden");
  canvas.focus?.();
}

function findCheapestAffordableUpgrade() {
  let best = null;
  const featuredId = featuredUpgradeIdForDate();
  for (const upgrade of PERMANENT_UPGRADES) {
    const level = metaProgress.upgrades[upgrade.id] ?? 0;
    const cost = discountedUpgradeCost(upgrade, level, upgrade.id === featuredId);
    if (cost > metaProgress.scrap) continue;
    if (best === null || cost < best.cost) {
      best = { upgrade, level, cost };
    }
  }
  return best;
}

function renderLaunchControls() {
  if (!launchControls) return;
  launchControls.replaceChildren();
  const cheapest = visualOptions.alwaysLaunch ? null : findCheapestAffordableUpgrade();

  const launchButton = document.createElement("button");
  launchButton.type = "button";
  launchButton.className = "launch-button";
  launchButton.innerHTML = `<span class="launch-icon" aria-hidden="true"></span><span>Launch Run</span>`;

  if (cheapest) {
    const { upgrade, level, cost } = cheapest;
    const rank = formatRankLabel(upgrade, level + 1);
    const primary = document.createElement("button");
    primary.type = "button";
    primary.className = "launch-button";
    primary.innerHTML = `<span class="launch-icon" aria-hidden="true"></span><span>Launch Run</span>`;
    primary.addEventListener("click", () => {
      const currentLevel = metaProgress.upgrades[upgrade.id] ?? 0;
      const currentCost = discountedUpgradeCost(upgrade, currentLevel, upgrade.id === featuredUpgradeIdForDate());
      if (metaProgress.scrap < currentCost) {
        renderLaunchControls();
        return;
      }
      metaProgress.scrap -= currentCost;
      metaProgress.upgrades[upgrade.id] = currentLevel + 1;
      saveMetaProgress();
      startPlayerRun();
    });

    const secondary = document.createElement("button");
    secondary.type = "button";
    secondary.className = "launch-secondary";
    secondary.textContent = `Spend ${cost} ⬢ on ${upgrade.name} ${rank}, then launch`;
    secondary.addEventListener("click", startPlayerRun);

    launchControls.append(primary, secondary);
  } else {
    launchButton.addEventListener("click", startPlayerRun);
    launchControls.append(launchButton);
  }
}

watchPpo.addEventListener("click", () => ppoWatchFile.click());

ppoWatchFile.addEventListener("change", async () => {
  const [file] = ppoWatchFile.files ?? [];
  if (!file) return;
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    invalidatePpoTraining();
    importPpoFile(parsed);
  } catch (error) {
    window.alert(error instanceof Error ? error.message : "Unable to load PPO model.");
    ppoWatchFile.value = "";
    return;
  }
  ppoWatchFile.value = "";
  simulation = createWatchSimulation();
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

openArmory.addEventListener("click", () => {
  openPanel(armoryPanel, openArmory);
  document.querySelector("#close-armory")?.focus();
});
openOptions.addEventListener("click", () => {
  optionsPanel.classList.remove("hidden");
  closeOptions.focus();
});
openPpo.addEventListener("click", () => openPanel(ppoPanel, startPpo));

closeOptions.addEventListener("click", closeOptionsPanel);
closePpo.addEventListener("click", () => closePanel(ppoPanel, openPpo));
startPpo.addEventListener("click", () => {
  ppoRunning = !ppoRunning;
  if (!ppoRunning) invalidatePpoTraining();
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
ppoWorkersInput?.addEventListener("change", () => {
  invalidatePpoTraining();
  ppoWorkersInput.value = String(ppoWorkerPool.setWorkerCount(clampInteger(ppoWorkersInput.value, 1, 12, ppoWorkerPool.workerCount)));
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
ppoFilterDeathsInput?.addEventListener("change", () => {
  ppoTrainer.filterDeathEpisodes = ppoFilterDeathsInput.checked;
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
ppoDamageRewardInput?.addEventListener("change", () => {
  ppoTrainer.damageReward = clampFloat(ppoDamageRewardInput.value, 0, 2, 0.025);
  ppoDamageRewardInput.value = String(ppoTrainer.damageReward);
});
ppoSurvivalBonusInput?.addEventListener("change", () => {
  ppoTrainer.survivalBonus = clampFloat(ppoSurvivalBonusInput.value, 0, 0.5, 0.025);
  ppoSurvivalBonusInput.value = String(ppoTrainer.survivalBonus);
});
ppoDeathPenaltyInput?.addEventListener("change", () => {
  ppoTrainer.deathPenalty = clampFloat(ppoDeathPenaltyInput.value, 0, 200, 35);
  ppoDeathPenaltyInput.value = String(ppoTrainer.deathPenalty);
});
ppoKillStreakRewardInput?.addEventListener("change", () => {
  ppoTrainer.killStreakReward = clampFloat(ppoKillStreakRewardInput.value, 0, 20, 0);
  ppoKillStreakRewardInput.value = String(ppoTrainer.killStreakReward);
});
ppoEnemyHpMultInput?.addEventListener("change", () => {
  ppoTrainer.enemyHealthMultiplier = clampFloat(ppoEnemyHpMultInput.value, 0.1, 10, 1);
  ppoEnemyHpMultInput.value = String(ppoTrainer.enemyHealthMultiplier);
});
ppoEnemySpeedMultInput?.addEventListener("change", () => {
  ppoTrainer.enemySpeedMultiplier = clampFloat(ppoEnemySpeedMultInput.value, 0.1, 5, 1);
  ppoEnemySpeedMultInput.value = String(ppoTrainer.enemySpeedMultiplier);
});
ppoEnemySpawnMultInput?.addEventListener("change", () => {
  ppoTrainer.enemySpawnMultiplier = clampFloat(ppoEnemySpawnMultInput.value, 0.1, 10, 1);
  ppoEnemySpawnMultInput.value = String(ppoTrainer.enemySpawnMultiplier);
});

optionsPanel.addEventListener("click", (event) => {
  if (event.target === optionsPanel) closeOptionsPanel();
});

window.addEventListener("keydown", (event) => {
  if (event.code === "KeyT" && runMode === "player") {
    input.toggleAutoAim();
    event.preventDefault();
    return;
  }
  if (event.code === "KeyY" && runMode === "player") {
    input.cycleTargetMode();
    event.preventDefault();
    return;
  }
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
  if (!inputElement) continue;
  inputElement.checked = visualOptions[key];
  inputElement.addEventListener("change", () => {
    visualOptions[key] = inputElement.checked;
    renderer.setOptions(visualOptions);
    saveVisualOptions(visualOptions);
    if (key === "alwaysLaunch") renderLaunchControls();
  });
}

function frame(now) {
  const delta = Math.min((now - lastTime) / 1000, GAME.maxDelta);
  lastTime = now;
  updateFps(now);

  if (runMode === "player") {
    accumulator += delta;
    const player = simulation.players.get(simulation.localPlayerId);
    simulation.applyInput(simulation.localPlayerId, input.sample({ player, renderer, simulation, dt: delta }));
    while (accumulator >= GAME.fixedStep) {
      simulation.step(GAME.fixedStep);
      accumulator -= GAME.fixedStep;
    }
    awardRunScrapIfNeeded();
    if (isTerminalRunState(simulation.state)) runMode = null;
  } else if (runMode === "watch") {
    accumulator += delta;
    simulation.applyInput(simulation.localPlayerId, ppoTrainer.act(simulation));
    while (accumulator >= GAME.fixedStep) {
      simulation.step(GAME.fixedStep);
      if (simulation.state === "upgrade") ppoTrainer.act(simulation);
      accumulator -= GAME.fixedStep;
    }
    if (isTerminalRunState(simulation.state)) {
      simulation = createWatchSimulation();
      accumulator = 0;
      resetDebugMeters();
    }
  } else if (ppoRunning && !ppoPanel.classList.contains("hidden")) {
    if (!ppoTrainingPromise) {
      ppoTrainingPromise = trainPpoBatchAsync(ppoTrainingGeneration);
    }
  }

  const snapshot = runMode ? simulation.getSnapshot() : menuSnapshot();
  if (runMode === "player") {
    snapshot.aimAssist = {
      enabled: input.autoAim,
      mode: input.targetMode,
      modeLabel: TARGET_MODE_LABELS[input.targetMode] ?? input.targetMode.toUpperCase(),
    };
  } else if (runMode === "watch") {
    snapshot.aimAssist = { enabled: true, mode: "ppo", modeLabel: "PPO POLICY" };
  }
  if (snapshot.state === "gameover" && lastRunReward) snapshot.runReward = lastRunReward;
  renderer.render(snapshot);
  syncUpgradePanel(snapshot, runMode === "player");
  updateDebugOverlay(snapshot);
  requestAnimationFrame(frame);
}

function createSimulation() {
  return new GameSimulation({ seed: 1337 + Math.floor(performance.now()), localPlayerId: "captain", metaProgress });
}

function createWatchSimulation() {
  return new GameSimulation({
    seed: 1337 + Math.floor(performance.now()),
    localPlayerId: "ppo",
    metaProgress,
    enemyHealthMultiplier: ppoTrainer.enemyHealthMultiplier,
    enemySpeedMultiplier: ppoTrainer.enemySpeedMultiplier,
    enemySpawnMultiplier: ppoTrainer.enemySpawnMultiplier,
  });
}

function awardRunScrapIfNeeded() {
  if (runRewardAwarded || !isTerminalRunState(simulation.state)) return;
  const snapshot = simulation.getSnapshot();
  const scrap = calculateRunScrap(snapshot);
  const player = snapshot.players.find((item) => item.id === snapshot.localPlayerId) ?? snapshot.players[0];
  const seconds = Math.floor(snapshot.elapsed);
  const kills = player?.kills ?? 0;
  const collected = player?.scrap ?? 0;
  const waveBonus = Math.max(0, snapshot.wave - 1);
  const charterBonus = player?.stats?.salvageBonus ?? 0;
  lastRunReward = {
    scrap,
    breakdown: { seconds, kills, waveBonus, collected, charterBonus },
  };
  metaProgress.scrap += scrap;
  metaProgress.best.seconds = Math.max(metaProgress.best.seconds, Math.floor(snapshot.elapsed));
  metaProgress.best.wave = Math.max(metaProgress.best.wave, snapshot.wave);
  runRewardAwarded = true;
  saveMetaProgress();
}

function isTerminalRunState(state) {
  return state === "gameover" || state === "victory";
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
  panel.scrollTop = 0;
  panel.querySelector(".armory-layout")?.scrollTo?.(0, 0);
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
    alwaysLaunch: false,
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
  invalidatePpoTraining();
  refreshMenuScrap();
  renderLaunchControls();
}

function refreshMenuScrap() {
  const countEl = document.querySelector("#menu-scrap-count");
  const armoryScrapEl = document.querySelector("#open-armory-scrap");
  const armoryBtn = document.querySelector("#open-armory");
  if (!countEl || !armoryBtn) return;
  const scrap = metaProgress?.scrap ?? 0;
  const formatted = formatScrap(scrap);
  countEl.textContent = formatted;
  if (armoryScrapEl) armoryScrapEl.textContent = `· ${formatted} ⬢`;
  let cheapest = Infinity;
  const featuredId = featuredUpgradeIdForDate();
  for (const upgrade of PERMANENT_UPGRADES) {
    const level = metaProgress?.upgrades?.[upgrade.id] ?? 0;
    const cost = discountedUpgradeCost(upgrade, level, upgrade.id === featuredId);
    if (cost < cheapest) cheapest = cost;
  }
  armoryBtn.classList.toggle("affordable", Number.isFinite(cheapest) && scrap >= cheapest);
}

function formatScrap(value) {
  return Math.round(value).toLocaleString("en-US");
}

function savePpoModel() {
  const state = ppoTrainer.exportTrainingState();
  const iteration = state.model?.iteration ?? ppoTrainer.iteration;
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `space-survivors-ppo-iter-${iteration}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(link.href);
}

function importPpoFile(parsed) {
  if (parsed && typeof parsed === "object" && parsed.model) {
    ppoTrainer.importTrainingState(parsed);
  } else {
    ppoTrainer.importModel(parsed);
  }
  ppoTrainer.metaProgress = metaProgress;
  syncPpoInputsFromTrainer();
}

async function loadPpoModel() {
  const [file] = ppoModelFile.files ?? [];
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    invalidatePpoTraining();
    importPpoFile(parsed);
    ppoRunning = false;
    startPpo.textContent = "Start";
    renderPpoPanel();
  } catch (error) {
    window.alert(error instanceof Error ? error.message : "Unable to load PPO model.");
  } finally {
    ppoModelFile.value = "";
  }
}

function syncPpoInputsFromTrainer() {
  if (ppoLrInput) ppoLrInput.value = String(ppoTrainer.learningRate);
  if (ppoClipInput) ppoClipInput.value = String(ppoTrainer.clip);
  if (ppoGammaInput) ppoGammaInput.value = String(ppoTrainer.gamma);
  if (ppoBatchInput) ppoBatchInput.value = String(ppoTrainer.batchSize);
  if (ppoGameLengthInput) ppoGameLengthInput.value = String(ppoTrainer.maxEpisodeSeconds);
  if (ppoWarmupInput) ppoWarmupInput.value = String(ppoTrainer.warmupSeconds);
  if (ppoAdvClampInput) ppoAdvClampInput.value = String(ppoTrainer.advantageClamp);
  if (ppoFilterDeathsInput) ppoFilterDeathsInput.checked = Boolean(ppoTrainer.filterDeathEpisodes);
  if (ppoKillRewardInput) ppoKillRewardInput.value = String(ppoTrainer.killReward);
  if (ppoXpRewardInput) ppoXpRewardInput.value = String(ppoTrainer.xpReward);
  if (ppoPowerupRewardInput) ppoPowerupRewardInput.value = String(ppoTrainer.powerupReward);
  if (ppoDmgTakenInput) ppoDmgTakenInput.value = String(ppoTrainer.damageTakenPenalty);
  if (ppoDamageRewardInput) ppoDamageRewardInput.value = String(ppoTrainer.damageReward);
  if (ppoSurvivalBonusInput) ppoSurvivalBonusInput.value = String(ppoTrainer.survivalBonus);
  if (ppoDeathPenaltyInput) ppoDeathPenaltyInput.value = String(ppoTrainer.deathPenalty);
  if (ppoKillStreakRewardInput) ppoKillStreakRewardInput.value = String(ppoTrainer.killStreakReward);
  if (ppoEnemyHpMultInput) ppoEnemyHpMultInput.value = String(ppoTrainer.enemyHealthMultiplier);
  if (ppoEnemySpeedMultInput) ppoEnemySpeedMultInput.value = String(ppoTrainer.enemySpeedMultiplier);
  if (ppoEnemySpawnMultInput) ppoEnemySpawnMultInput.value = String(ppoTrainer.enemySpawnMultiplier);
}

function invalidatePpoTraining() {
  ppoTrainingGeneration += 1;
}

async function trainPpoBatchAsync(generation) {
  try {
    if (!ppoWorkerPool.supported) {
      if (generation !== ppoTrainingGeneration || !ppoRunning) return;
      ppoTrainer.trainBatch();
      renderPpoPanel();
      return;
    }
    const result = await ppoWorkerPool.runEpisodes(ppoTrainer, ppoTrainer.batchSize);
    if (generation !== ppoTrainingGeneration || !ppoRunning) return;
    const point = ppoTrainer.trainBatchFromEpisodes(result.episodes, result.elapsedMs);
    point.workers = result.workers;
    renderPpoPanel();
  } catch (error) {
    console.error(error);
    if (generation === ppoTrainingGeneration) {
      ppoRunning = false;
      startPpo.textContent = "Start";
      window.alert(error instanceof Error ? error.message : "PPO worker training failed.");
    }
  } finally {
    ppoTrainingPromise = null;
  }
}

const UPGRADE_CATEGORIES = {
  "combat-drills": "offense",
  "reactor-tuning": "offense",
  "reinforced-hull": "defense",
  "field-medicine": "defense",
  "scrap-charter": "economy",
  "nav-school": "mobility",
};
const ARMORY_CATEGORIES = [
  { id: "offense", label: "Offense" },
  { id: "defense", label: "Defense" },
  { id: "economy", label: "Economy" },
  { id: "mobility", label: "Mobility" },
];
const ROMAN_NUMERAL = (n) => ["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"][n] ?? `${n}`;

const armoryUiState = {
  category: "offense",
  slot: "weapon",
  hoverItemId: { weapon: null, hull: null, utility: null },
  hoverUpgradeId: null,
};
const STAT_FORMATTERS = {
  maxHp: { label: "HP", format: (v) => Math.round(v) },
  damage: { label: "DMG", format: (v) => v.toFixed(1) },
  fireRate: { label: "RoF", format: (v) => `${v.toFixed(2)}/s` },
  speed: { label: "SPD", format: (v) => `${Math.round(v)} u/s` },
  pickupRadius: { label: "MAG", format: (v) => Math.round(v) },
  critChance: { label: "CRIT", format: (v) => `${(v * 100).toFixed(1)}%` },
};
const HANGAR_STATS = ["maxHp", "damage", "fireRate", "speed", "pickupRadius", "critChance"];

function cloneMeta(meta) {
  return {
    ...meta,
    upgrades: { ...meta.upgrades },
    equipment: { ...meta.equipment },
    best: { ...(meta.best ?? {}) },
  };
}

function simulatePlayerWithMeta(meta) {
  const stub = createPlayer("armory-preview", 0, 0);
  // Reset upgrade-driven mutable state so applyMetaProgress starts clean.
  stub.upgradeStacks = new Map();
  stub.ownedUpgrades = new Set();
  applyMetaProgress(stub, meta);
  return stub;
}

function diffStats(before, after) {
  const out = [];
  for (const key of HANGAR_STATS) {
    const b = before[key];
    const a = after[key];
    if (typeof b !== "number" || typeof a !== "number") continue;
    const delta = a - b;
    if (Math.abs(delta) < 1e-4) continue;
    const fmt = STAT_FORMATTERS[key];
    out.push({
      key,
      label: `${delta >= 0 ? "+" : ""}${(key === "fireRate" || key === "damage") ? delta.toFixed(2) : key === "critChance" ? `${(delta * 100).toFixed(1)}%` : Math.round(delta)} ${fmt.label.toLowerCase()}`,
      delta,
      before: b,
      after: a,
    });
  }
  return out;
}

function recommendedNextPurchase(meta) {
  const candidates = PERMANENT_UPGRADES
    .map((upgrade) => {
      const level = meta.upgrades[upgrade.id] ?? 0;
      const cost = nextRankCost(upgrade, level);
      return { upgrade, level, cost };
    })
    .filter((entry) => entry.cost <= meta.scrap)
    .sort((a, b) => a.cost - b.cost);
  return candidates[0] ?? null;
}

function prestigeChipClass(tier) {
  if (tier >= 4) return "prestige-chip prestige-gold";
  if (tier === 3) return "prestige-chip prestige-orange";
  if (tier === 2) return "prestige-chip prestige-amber";
  return "prestige-chip prestige-cyan";
}

function renderArmory() {
  const root = document.querySelector("#armory-root");
  if (!root) return;
  const featuredId = featuredUpgradeIdForDate(new Date());
  const featuredUpgrade = PERMANENT_UPGRADES.find((u) => u.id === featuredId);

  root.replaceChildren();
  root.append(
    renderArmoryHeader(featuredUpgrade),
    renderArmoryHangar(),
    renderArmoryBody(featuredId),
    renderArmoryEquipmentBay(),
    renderArmoryFooter(),
  );

  if (shouldShowEmptyState()) {
    root.append(renderArmoryEmptyState());
  }
}

function shouldShowEmptyState() {
  if (metaProgress.scrap !== 0) return false;
  const anyUpgrades = Object.values(metaProgress.upgrades).some((level) => level > 0);
  if (anyUpgrades) return false;
  const defaults = { weapon: "pulse-laser", hull: "standard-frame", utility: "magnet-rig" };
  for (const [slot, def] of Object.entries(defaults)) {
    if (metaProgress.equipment[slot] !== def) return false;
  }
  return true;
}

function renderArmoryHeader(featuredUpgrade) {
  const header = document.createElement("header");
  header.className = "armory-zone armory-header";
  const featuredLevel = metaProgress.upgrades[featuredUpgrade.id] ?? 0;
  const featuredCost = discountedUpgradeCost(featuredUpgrade, featuredLevel, true);
  header.innerHTML = `
    <div class="armory-header-titles">
      <span class="armory-eyebrow">Permanent Progression</span>
      <h2 id="armory-title">Armory</h2>
    </div>
    <div class="armory-scrap-pill">
      <strong>${metaProgress.scrap.toLocaleString()}</strong>
      <small>Scrap</small>
    </div>
    <div class="featured-spotlight" aria-label="Featured upgrade">
      <span class="featured-ribbon">Featured · -25%</span>
      <span class="equipment-sprite equipment-sprite-${featuredUpgrade.icon ?? featuredUpgrade.id}" aria-hidden="true"></span>
      <div class="featured-body">
        <span class="featured-label">Daily Featured</span>
        <strong>${featuredUpgrade.name}</strong>
        <small>${featuredCost} scrap · save 25%</small>
      </div>
    </div>
    <button id="armory-launch" class="armory-cta" type="button">Spend &amp; Launch</button>
  `;
  header.querySelector("#armory-launch").addEventListener("click", () => {
    closePanel(armoryPanel, openArmory);
    startRun.click();
  });
  return header;
}

function renderArmoryHangar() {
  const zone = document.createElement("section");
  zone.className = "armory-zone armory-hangar";
  const stub = simulatePlayerWithMeta(metaProgress);

  const cardsRow = document.createElement("div");
  cardsRow.className = "armory-hangar-cards";
  for (const [slot, items] of Object.entries(EQUIPMENT)) {
    const item = items.find((i) => i.id === metaProgress.equipment[slot]) ?? items[0];
    const card = document.createElement("div");
    card.className = "armory-card armory-hangar-card";
    card.innerHTML = `
      <div class="armory-hangar-slot">${EQUIPMENT_SLOTS[slot] ?? slot}</div>
      <span class="equipment-sprite equipment-sprite-${item.icon ?? item.id}" aria-hidden="true"></span>
      <strong>${item.name}</strong>
      <p>${item.description}</p>
    `;
    cardsRow.append(card);
  }

  const stats = document.createElement("div");
  stats.className = "armory-hangar-stats";
  for (const key of HANGAR_STATS) {
    const fmt = STAT_FORMATTERS[key];
    const cell = document.createElement("div");
    cell.className = "armory-stat-cell";
    cell.innerHTML = `<small>${fmt.label}</small><strong>${fmt.format(stub.stats[key])}</strong>`;
    stats.append(cell);
  }

  const heading = document.createElement("div");
  heading.className = "armory-zone-heading";
  heading.innerHTML = `<span>Hangar</span><small>Currently equipped loadout</small>`;
  zone.append(heading, cardsRow, stats);
  return zone;
}

function renderArmoryBody(featuredId) {
  const body = document.createElement("section");
  body.className = "armory-zone armory-body";

  // Permanent systems column
  const left = document.createElement("div");
  left.className = "armory-systems";
  const heading = document.createElement("div");
  heading.className = "armory-zone-heading";
  heading.innerHTML = `<span>Permanent Systems</span><small>Spend scrap on persistent upgrades</small>`;
  left.append(heading);

  // Tabs
  const tabs = document.createElement("div");
  tabs.className = "armory-tabs";
  for (const cat of ARMORY_CATEGORIES) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `armory-tab${armoryUiState.category === cat.id ? " active" : ""}`;
    btn.textContent = cat.label;
    btn.addEventListener("click", () => {
      armoryUiState.category = cat.id;
      armoryUiState.hoverUpgradeId = null;
      renderArmory();
    });
    tabs.append(btn);
  }
  left.append(tabs);

  // Cards grid
  const grid = document.createElement("div");
  grid.className = "armory-grid";
  const upgradesInCategory = PERMANENT_UPGRADES.filter(
    (u) => UPGRADE_CATEGORIES[u.id] === armoryUiState.category,
  );
  if (upgradesInCategory.length === 0) {
    const empty = document.createElement("div");
    empty.className = "armory-grid-empty";
    empty.textContent = "No systems in this category yet.";
    grid.append(empty);
  } else {
    for (const upgrade of upgradesInCategory) {
      grid.append(renderUpgradeCard(upgrade, featuredId));
    }
  }
  left.append(grid);

  // Right rail
  const rail = renderPreviewRail();
  body.append(left, rail);
  return body;
}

function renderUpgradeCard(upgrade, featuredId) {
  const level = metaProgress.upgrades[upgrade.id] ?? 0;
  const isFeatured = upgrade.id === featuredId;
  const baseCost = nextRankCost(upgrade, level);
  const cost = discountedUpgradeCost(upgrade, level, isFeatured);
  const affordable = metaProgress.scrap >= cost;
  const tier = prestigeTierIndex(upgrade, level);
  const progress = Math.round(prestigeProgressFraction(upgrade, level) * 100);
  const pastSoftCap = level >= upgrade.maxLevel;
  const card = document.createElement("article");
  card.className = "armory-card armory-upgrade-card";
  if (affordable) card.classList.add("affordable");
  else card.classList.add("unaffordable");
  if (isFeatured) card.classList.add("featured");
  if (tier > 0) card.classList.add("prestiged");
  card.tabIndex = 0;
  card.dataset.upgradeId = upgrade.id;

  const prestigeChip = tier > 0
    ? `<span class="${prestigeChipClass(tier)}">Prestige ${ROMAN_NUMERAL(tier)}</span>`
    : "";
  const featuredRibbon = isFeatured
    ? `<span class="armory-ribbon">Featured · -25%</span>`
    : "";
  const priceLine = isFeatured
    ? `<span class="armory-price"><s>${baseCost}</s> ${cost} scrap${pastSoftCap ? " ↗" : ""}</span>`
    : `<span class="armory-price">${cost} scrap${pastSoftCap ? " ↗" : ""}</span>`;
  const nextDelta = nextRankEffectDelta(upgrade, level);

  card.innerHTML = `
    ${featuredRibbon}
    <div class="armory-card-head">
      <span class="equipment-sprite equipment-sprite-${upgrade.icon ?? upgrade.id}" aria-hidden="true"></span>
      <div class="armory-card-title">
        <strong>${upgrade.name}</strong>
        <span>${formatRankLabel(upgrade, level)}</span>
      </div>
      ${prestigeChip}
    </div>
    <div class="upgrade-progress" aria-label="${upgrade.name} progress">
      <span style="width: ${Math.min(100, progress)}%"></span>
    </div>
    <p>${upgrade.description}</p>
    <div class="armory-card-meta">
      <small>Next: ${nextDelta}</small>
      ${priceLine}
    </div>
    <button class="armory-card-buy" type="button" ${affordable ? "" : "disabled"}>
      ${affordable ? `Purchase · ${cost}` : `Need ${cost - metaProgress.scrap} more`}
    </button>
  `;
  card.querySelector(".armory-card-buy").addEventListener("click", () => {
    if (metaProgress.scrap < cost) return;
    metaProgress.scrap -= cost;
    metaProgress.upgrades[upgrade.id] = level + 1;
    saveMetaProgress();
    renderArmory();
  });
  card.addEventListener("mouseenter", () => {
    armoryUiState.hoverUpgradeId = upgrade.id;
    refreshPreviewRail();
  });
  card.addEventListener("mouseleave", () => {
    armoryUiState.hoverUpgradeId = null;
    refreshPreviewRail();
  });
  card.addEventListener("focusin", () => {
    armoryUiState.hoverUpgradeId = upgrade.id;
    refreshPreviewRail();
  });
  card.addEventListener("keydown", (event) => handleGridKeyNav(event, card));
  return card;
}

function handleGridKeyNav(event, card) {
  const grid = card.parentElement;
  if (!grid) return;
  const cards = [...grid.querySelectorAll("[tabindex='0']")];
  const idx = cards.indexOf(card);
  if (idx < 0) return;
  let next = idx;
  if (event.key === "ArrowRight") next = Math.min(cards.length - 1, idx + 1);
  else if (event.key === "ArrowLeft") next = Math.max(0, idx - 1);
  else if (event.key === "ArrowDown") next = Math.min(cards.length - 1, idx + 2);
  else if (event.key === "ArrowUp") next = Math.max(0, idx - 2);
  else if (event.key === "Enter") {
    card.querySelector("button:not([disabled])")?.click();
    event.preventDefault();
    return;
  } else return;
  event.preventDefault();
  cards[next]?.focus();
}

function renderPreviewRail() {
  const rail = document.createElement("aside");
  rail.className = "armory-preview-rail";
  rail.id = "armory-preview-rail";
  rail.append(buildPreviewRailContent());
  return rail;
}

function refreshPreviewRail() {
  const rail = document.querySelector("#armory-preview-rail");
  if (!rail) return;
  rail.replaceChildren(buildPreviewRailContent());
}

function buildPreviewRailContent() {
  const wrap = document.createElement("div");
  wrap.className = "armory-preview-inner";
  const hoverId = armoryUiState.hoverUpgradeId;
  if (hoverId) {
    const upgrade = PERMANENT_UPGRADES.find((u) => u.id === hoverId);
    const level = metaProgress.upgrades[upgrade.id] ?? 0;
    const featured = upgrade.id === featuredUpgradeIdForDate(new Date());
    const cost = discountedUpgradeCost(upgrade, level, featured);
    const before = simulatePlayerWithMeta(metaProgress);
    const trial = cloneMeta(metaProgress);
    trial.upgrades[upgrade.id] = level + 1;
    const after = simulatePlayerWithMeta(trial);
    const diffs = diffStats(before.stats, after.stats);
    wrap.innerHTML = `
      <div class="armory-preview-heading">Next Run Preview</div>
      <strong class="armory-preview-name">${upgrade.name}</strong>
      <div class="armory-preview-deltas"></div>
      <div class="armory-preview-cost">
        <small>Cost</small><strong>${cost} scrap</strong>
      </div>
      <div class="armory-preview-cost">
        <small>Reserve after</small><strong>${Math.max(0, metaProgress.scrap - cost)} scrap</strong>
      </div>
    `;
    const list = wrap.querySelector(".armory-preview-deltas");
    for (const d of diffs) {
      const fmt = STAT_FORMATTERS[d.key];
      const row = document.createElement("div");
      row.className = `armory-preview-delta${d.delta >= 0 ? " gain" : " loss"}`;
      row.innerHTML = `<span>${fmt.label}</span><span>${fmt.format(d.before)} → ${fmt.format(d.after)}</span>`;
      list.append(row);
    }
    if (diffs.length === 0) {
      const row = document.createElement("div");
      row.className = "armory-preview-delta";
      row.textContent = "No measurable stat change";
      list.append(row);
    }
  } else {
    const rec = recommendedNextPurchase(metaProgress);
    if (rec) {
      wrap.innerHTML = `
        <div class="armory-preview-heading">Recommended</div>
        <strong class="armory-preview-name">${rec.upgrade.name}</strong>
        <p>Cheapest affordable upgrade. Hover any system card to preview its stat impact.</p>
        <div class="armory-preview-cost"><small>Cost</small><strong>${rec.cost} scrap</strong></div>
      `;
    } else {
      wrap.innerHTML = `
        <div class="armory-preview-heading">Next Run Preview</div>
        <p>Hover a system card to preview the stat impact, cost, and remaining scrap reserve.</p>
      `;
    }
  }
  return wrap;
}

function renderArmoryEquipmentBay() {
  const zone = document.createElement("section");
  zone.className = "armory-zone armory-equipment-bay";
  const heading = document.createElement("div");
  heading.className = "armory-zone-heading";
  heading.innerHTML = `<span>Equipment Bay</span><small>Compare and swap loadout components</small>`;
  zone.append(heading);

  // Slot tabs
  const tabs = document.createElement("div");
  tabs.className = "armory-tabs";
  for (const slot of Object.keys(EQUIPMENT_SLOTS)) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `armory-tab${armoryUiState.slot === slot ? " active" : ""}`;
    btn.textContent = EQUIPMENT_SLOTS[slot];
    btn.addEventListener("click", () => {
      armoryUiState.slot = slot;
      renderArmory();
    });
    tabs.append(btn);
  }
  zone.append(tabs);

  const slot = armoryUiState.slot;
  const items = EQUIPMENT[slot];
  const currentItem = items.find((i) => i.id === metaProgress.equipment[slot]) ?? items[0];
  const hoverId = armoryUiState.hoverItemId[slot];
  const hoverItem = (hoverId && items.find((i) => i.id === hoverId)) ||
    items.find((i) => i.id !== currentItem.id) || currentItem;

  const compare = document.createElement("div");
  compare.className = "armory-equipment-compare";
  compare.append(
    renderEquipmentCompareCard(slot, currentItem, "Currently Equipped", true),
    renderEquipmentDeltaStrip(slot, currentItem, hoverItem),
    renderEquipmentCompareCard(slot, hoverItem, "Hovered", false, hoverItem.id === currentItem.id),
  );
  zone.append(compare);

  // Thumbnail strip
  const strip = document.createElement("div");
  strip.className = "armory-equipment-strip";
  for (const item of items) {
    const unlocked = isEquipmentUnlocked(item, metaProgress);
    const thumb = document.createElement("button");
    thumb.type = "button";
    thumb.className = "armory-equipment-thumb";
    if (item.id === currentItem.id) thumb.classList.add("equipped");
    if (item.id === hoverItem.id) thumb.classList.add("hovered");
    if (!unlocked) thumb.classList.add("locked");
    thumb.innerHTML = `
      <span class="equipment-sprite equipment-sprite-${item.icon ?? item.id}" aria-hidden="true"></span>
      <small>${item.name}</small>
    `;
    thumb.addEventListener("mouseenter", () => {
      armoryUiState.hoverItemId[slot] = item.id;
      renderArmory();
    });
    thumb.addEventListener("click", () => {
      armoryUiState.hoverItemId[slot] = item.id;
      renderArmory();
    });
    strip.append(thumb);
  }
  zone.append(strip);
  return zone;
}

function renderEquipmentCompareCard(slot, item, label, isCurrent, sameAsCurrent = false) {
  const card = document.createElement("div");
  card.className = "armory-card armory-equipment-card";
  const unlocked = isEquipmentUnlocked(item, metaProgress);
  if (!unlocked) card.classList.add("locked");
  if (isCurrent) card.classList.add("equipped");
  card.innerHTML = `
    <div class="armory-equipment-label">${label}</div>
    <div class="armory-card-head">
      <span class="equipment-sprite equipment-sprite-${item.icon ?? item.id}" aria-hidden="true"></span>
      <div class="armory-card-title">
        <strong>${item.name}</strong>
        <span>${EQUIPMENT_SLOTS[slot]}</span>
      </div>
      ${unlocked ? "" : `<span class="prestige-chip prestige-violet">Locked</span>`}
    </div>
    ${unlocked
      ? `<p>${item.description}</p><ul class="armory-equipment-effects">${item.effects.map((e) => `<li>${e}</li>`).join("")}</ul>`
      : `<p>Max 3 systems to unlock ${item.name}.</p>`
    }
    ${isCurrent
      ? `<button class="armory-card-buy" type="button" disabled>Equipped</button>`
      : sameAsCurrent
        ? ""
        : `<button class="armory-card-buy" type="button" ${unlocked ? "" : "disabled"}>${unlocked ? "Equip" : "Locked"}</button>`
    }
  `;
  const equipBtn = card.querySelector(".armory-card-buy:not([disabled])");
  if (equipBtn && !isCurrent && unlocked) {
    equipBtn.addEventListener("click", () => {
      metaProgress.equipment[slot] = item.id;
      saveMetaProgress();
      renderArmory();
    });
  }
  return card;
}

function renderEquipmentDeltaStrip(slot, currentItem, alternativeItem) {
  const strip = document.createElement("div");
  strip.className = "armory-equipment-deltas";
  if (currentItem.id === alternativeItem.id) {
    strip.innerHTML = `<span>Hover an alternative to compare</span>`;
    return strip;
  }
  const baseMeta = cloneMeta(metaProgress);
  const altMeta = cloneMeta(metaProgress);
  altMeta.equipment[slot] = alternativeItem.id;
  const before = simulatePlayerWithMeta(baseMeta);
  const after = simulatePlayerWithMeta(altMeta);
  const diffs = diffStats(before.stats, after.stats);
  if (diffs.length === 0) {
    strip.innerHTML = `<span>No measurable change</span>`;
    return strip;
  }
  for (const d of diffs) {
    const span = document.createElement("span");
    span.className = `armory-delta-chip${d.delta >= 0 ? " gain" : " loss"}`;
    span.textContent = d.label;
    strip.append(span);
  }
  return strip;
}

function renderArmoryFooter() {
  const footer = document.createElement("footer");
  footer.className = "armory-zone armory-footer";
  const rec = recommendedNextPurchase(metaProgress);
  const hint = rec
    ? `Recommended next purchase: <strong>${rec.upgrade.name}</strong> for ${rec.cost} scrap`
    : "Earn more scrap to unlock the next purchase";
  footer.innerHTML = `
    <button id="close-armory" type="button">Back</button>
    <div class="armory-footer-reserve"><small>Scrap Reserve</small><strong>${metaProgress.scrap.toLocaleString()}</strong></div>
    <div class="armory-footer-hint">${hint}</div>
  `;
  footer.querySelector("#close-armory").addEventListener("click", () => {
    closePanel(armoryPanel, openArmory);
  });
  return footer;
}

function renderArmoryEmptyState() {
  const overlay = document.createElement("div");
  overlay.className = "armory-empty-overlay";
  const reinforced = PERMANENT_UPGRADES.find((u) => u.id === "reinforced-hull");
  const cost = nextRankCost(reinforced, 0);
  overlay.innerHTML = `
    <div class="armory-empty-card">
      <h3>Get Started</h3>
      <ol>
        <li>Survive a run → earn Scrap</li>
        <li>Spend Scrap on Permanent Systems (start with Reinforced Hull, ${cost})</li>
        <li>Swap Equipment in the Hangar to change how you fight</li>
      </ol>
      <button id="armory-launch-first" type="button" class="armory-cta">Launch First Run</button>
    </div>
  `;
  overlay.querySelector("#armory-launch-first").addEventListener("click", () => {
    closePanel(armoryPanel, openArmory);
    startRun.click();
  });
  return overlay;
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
renderLaunchControls();
requestAnimationFrame(frame);

function initPpoSpinners() {
  const inputs = document.querySelectorAll(
    ".ppo-param-pill input[type='number'], .ppo-average-control input[type='number'], .ppo-sidebar-row input[type='number']",
  );
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
