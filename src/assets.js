const SHEET_WIDTH = 1254;
const SHEET_HEIGHT = 1254;
const SHEET_COLUMNS = 4;
const SHEET_ROWS = 2;

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
