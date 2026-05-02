const SHEET_WIDTH = 1254;
const SHEET_HEIGHT = 1254;
const SHEET_COLUMNS = 4;
const SHEET_ROWS = 2;
const ENEMY_SHEET_CELL_WIDTH = 397;
const ENEMY_SHEET_HEIGHT = 793;

export const SPRITE_SHEET = {
  src: "./assets/space-survivors-sprites.png",
  width: SHEET_WIDTH,
  height: SHEET_HEIGHT,
  columns: SHEET_COLUMNS,
  rows: SHEET_ROWS,
  sprites: {
    player: rect(31, 319, 283, 245),
    enemyDrone: rect(314, 329, 263, 230),
    enemyBruiser: rect(658, 274, 273, 299),
    plasmaBolt: rect(990, 387, 223, 111),
    xpCrystal: rect(77, 706, 172, 173),
    orbitalDrone: rect(374, 691, 202, 214),
    shieldPickup: rect(679, 693, 261, 223),
    gravityWell: rect(940, 647, 281, 295),
  },
};

export const ENEMY_SHEET = {
  src: "./assets/enemy-sprites/missing-enemies.png",
  width: ENEMY_SHEET_CELL_WIDTH * 5,
  height: ENEMY_SHEET_HEIGHT,
  columns: 5,
  rows: 1,
  sprites: {
    enemySplitter: rect(69, 195, 328, 367),
    enemyStalker: rect(397, 208, 397, 359),
    enemySpitter: rect(794, 204, 380, 365),
    enemyBulwark: rect(1250, 207, 338, 360),
    enemyShard: rect(1588, 289, 272, 266),
  },
};

export const ENEMY_IMAGES = {
  enemyCharger: "./assets/enemy-sprites/charger.png",
  enemySiphon: "./assets/enemy-sprites/siphon.png",
  enemyWarden: "./assets/enemy-sprites/warden.png",
  enemySplitter: "./assets/enemy-sprites/splitter.png",
  enemySpitter: "./assets/enemy-sprites/spitter.png",
  enemyBulwark: "./assets/enemy-sprites/bulwark.png",
};

export const BOSS_IMAGES = {
  bossBroodSplitter: "./assets/enemy-sprites/boss-brood-splitter.png",
  bossSiphonPrime: "./assets/enemy-sprites/boss-siphon-prime.png",
  bossBastionBulwark: "./assets/enemy-sprites/boss-bastion-bulwark.png",
  bossNovaSpitter: "./assets/enemy-sprites/boss-nova-spitter.png",
};

export const BOSS_PORTRAIT_IMAGES = {
  portraitBroodSplitter: "./assets/enemy-sprites/portrait-brood-splitter.png",
  portraitSiphonPrime: "./assets/enemy-sprites/portrait-siphon-prime.png",
  portraitBastionBulwark: "./assets/enemy-sprites/portrait-bastion-bulwark.png",
  portraitNovaSpitter: "./assets/enemy-sprites/portrait-nova-spitter.png",
};

export const UI_SHEET = {
  src: "./assets/space-survivors-ui.png",
  width: SHEET_WIDTH,
  height: SHEET_HEIGHT,
  columns: SHEET_COLUMNS,
  rows: SHEET_ROWS,
  sprites: {
    hull: rect(34, 277, 242, 271),
    xp: rect(331, 285, 261, 253),
    wave: rect(646, 273, 276, 272),
    timer: rect(968, 279, 260, 264),
    target: rect(29, 702, 251, 253),
    upgrade: rect(346, 690, 228, 265),
    rare: rect(636, 690, 279, 281),
    warning: rect(956, 713, 276, 233),
  },
};

export function loadSpriteSheet() {
  return loadSheet(SPRITE_SHEET);
}

export function loadEnemySheet() {
  return loadSheet(ENEMY_SHEET);
}

export function loadEnemyImageSet() {
  return loadImageSet(ENEMY_IMAGES);
}

export function loadBossImageSet() {
  return loadImageSet(BOSS_IMAGES);
}

export function loadBossPortraitImageSet() {
  return loadImageSet(BOSS_PORTRAIT_IMAGES);
}

function loadImageSet(images) {
  return Object.fromEntries(
    Object.entries(images).map(([name, src]) => {
      const image = new Image();
      image.src = src;
      return [
        name,
        {
          image,
          get ready() {
            return image.complete && image.naturalWidth > 0;
          },
        },
      ];
    }),
  );
}

export function loadUiSheet() {
  return loadSheet(UI_SHEET);
}

function loadSheet(sheet) {
  const image = new Image();
  image.src = sheet.src;
  return {
    image,
    get ready() {
      return image.complete && image.naturalWidth > 0;
    },
  };
}

function rect(x, y, width, height) {
  return { x, y, width, height };
}
