export const GAME = {
  width: 1280,
  height: 720,
  fixedStep: 1 / 60,
  maxDelta: 0.08,
  worldRadius: 3600,
  maxEnemies: 280,
  xpMagnetRadius: 92,
  cameraZoom: 0.9,
  screenShake: true,
  lighting: true,
  particles: true,
  ppoMaxEpisodeSeconds: 45,
  playerAimTurnRate: 14,
  autoAimAcquireRadius: 1100,
  autoAimDensityRadius: 220,
  normalRunSeconds: 1800,
  overrunStartsAt: 1800,
};

export const DIFFICULTY = {
  healthPerMinute: 0.045,
  speedPerMinute: 0.006,
  spawnPerMinute: 0.035,
  overrunHealthPerMinute: 0.09,
  overrunSpeedPerMinute: 0.012,
  overrunSpawnPerMinute: 0.07,
  maxHealthMultiplier: 6,
  maxSpeedMultiplier: 1.8,
  maxSpawnMultiplier: 4.5,
};

export const PLAYER_BASE = {
  radius: 18,
  speed: 270,
  maxHp: 120,
  pickupRadius: 34,
  invulnerability: 0.36,
};

export const NETWORK = {
  protocolVersion: 1,
  tickRate: 60,
  snapshotRate: 15,
};

export const TARGETING = {
  primaryWeapon: {
    strategy: "nearest",
    enemyTypes: ["drone", "bruiser", "splitter", "shard", "stalker", "bulwark", "spitter", "charger", "siphon", "warden"],
    maxRange: 1200,
    firingAngleDegrees: 3,
  },
};

export const RUN_EVENTS = {
  firstEventDelay: [18, 24],
  interval: [24, 34],
  alertLeadTime: 3,
  laneSweep: {
    id: "laneSweep",
    label: "Lane Sweep",
    weight: 3,
    telegraphDuration: 2.25,
    activeDuration: 1.05,
    width: 150,
    length: 1700,
    damage: 30,
  },
  rewardCache: {
    id: "rewardCache",
    label: "Reward Cache",
    weight: 2,
    telegraphDuration: 1.6,
    activeDuration: 9,
    distance: [260, 520],
    value: 34,
  },
};
