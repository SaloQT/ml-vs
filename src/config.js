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
    enemyTypes: ["drone", "bruiser"],
    maxRange: 1200,
    firingAngleDegrees: 8,
  },
};
