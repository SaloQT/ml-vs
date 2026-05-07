import { GAME } from "./config.js";
import { normalize } from "./math.js";

const keyMap = new Map([
  ["KeyW", [0, -1]],
  ["ArrowUp", [0, -1]],
  ["KeyS", [0, 1]],
  ["ArrowDown", [0, 1]],
  ["KeyA", [-1, 0]],
  ["ArrowLeft", [-1, 0]],
  ["KeyD", [1, 0]],
  ["ArrowRight", [1, 0]],
]);

const JOYSTICK_RADIUS = 70;

export class InputController {
  constructor(touchTarget = null) {
    this.keys = new Set();
    this.touch = null;
    this.touchVector = { x: 0, y: 0 };
    this.pointer = null;
    this.autoAim = false;
    this.aimX = 1;
    this.aimY = 0;
    this.targetMode = "nearest";
    this._windowListeners = [];
    this._touchTarget = null;
    this._touchListeners = [];
    this._onKeyDown = (event) => this.keys.add(event.code);
    this._onKeyUp = (event) => this.keys.delete(event.code);
    window.addEventListener("keydown", this._onKeyDown);
    window.addEventListener("keyup", this._onKeyUp);
    this._windowListeners.push(["keydown", this._onKeyDown], ["keyup", this._onKeyUp]);
    if (touchTarget) this.attachTouch(touchTarget);
  }

  reset() {
    this.keys.clear();
    this.touch = null;
    this.touchVector = { x: 0, y: 0 };
    this.pointer = null;
    this.aimX = 1;
    this.aimY = 0;
  }

  destroy() {
    for (const [type, handler] of this._windowListeners) {
      window.removeEventListener(type, handler);
    }
    this._windowListeners = [];
    if (this._touchTarget) {
      for (const [type, handler, options] of this._touchListeners) {
        this._touchTarget.removeEventListener(type, handler, options);
      }
      this._touchListeners = [];
      this._touchTarget = null;
    }
    if (this.joystickBase) {
      this.joystickBase.remove();
      this.joystickBase = null;
    }
    if (this.joystickThumb) {
      this.joystickThumb.remove();
      this.joystickThumb = null;
    }
    this.keys.clear();
    this.touch = null;
    this.touchVector = { x: 0, y: 0 };
    this.pointer = null;
    this.aimX = 0;
    this.aimY = 0;
  }

  attachTouch(target) {
    this.joystickBase = null;
    this.joystickThumb = null;

    target.style.touchAction = "none";

    const start = (event) => {
      if (this.touch !== null) return;
      const touch = event.changedTouches?.[0] ?? event;
      const point = pointFromEvent(touch);
      if (!point) return;
      this.touch = { id: touch.identifier ?? "mouse", originX: point.x, originY: point.y };
      this.touchVector = { x: 0, y: 0 };
      this.showJoystick(point.x, point.y, point.x, point.y);
      event.preventDefault();
    };

    const move = (event) => {
      if (this.touch === null) return;
      const touch = findTouch(event, this.touch.id);
      if (!touch) return;
      const point = pointFromEvent(touch);
      if (!point) return;
      const dx = point.x - this.touch.originX;
      const dy = point.y - this.touch.originY;
      const len = Math.hypot(dx, dy);
      const clampedLen = Math.min(len, JOYSTICK_RADIUS);
      const scale = clampedLen / JOYSTICK_RADIUS;
      this.touchVector = len > 0 ? { x: (dx / len) * scale, y: (dy / len) * scale } : { x: 0, y: 0 };
      const thumbX = len > 0 ? this.touch.originX + (dx / len) * clampedLen : this.touch.originX;
      const thumbY = len > 0 ? this.touch.originY + (dy / len) * clampedLen : this.touch.originY;
      this.showJoystick(this.touch.originX, this.touch.originY, thumbX, thumbY);
      event.preventDefault();
    };

    const end = (event) => {
      if (this.touch === null) return;
      if (event.changedTouches && !findTouch(event, this.touch.id)) return;
      this.touch = null;
      this.touchVector = { x: 0, y: 0 };
      this.hideJoystick();
    };

    const onPointerMove = (event) => {
      if (event.pointerType === "touch") return;
      this.pointer = { clientX: event.clientX, clientY: event.clientY };
    };
    const onPointerLeave = () => {
      this.pointer = null;
    };
    const passiveOpts = { passive: false };
    target.addEventListener("touchstart", start, passiveOpts);
    target.addEventListener("touchmove", move, passiveOpts);
    target.addEventListener("touchend", end);
    target.addEventListener("touchcancel", end);
    target.addEventListener("pointermove", onPointerMove);
    target.addEventListener("pointerleave", onPointerLeave);
    this._touchTarget = target;
    this._touchListeners.push(
      ["touchstart", start, passiveOpts],
      ["touchmove", move, passiveOpts],
      ["touchend", end, undefined],
      ["touchcancel", end, undefined],
      ["pointermove", onPointerMove, undefined],
      ["pointerleave", onPointerLeave, undefined],
    );
  }

  showJoystick(baseX, baseY, thumbX, thumbY) {
    if (!this.joystickBase) {
      this.joystickBase = document.createElement("div");
      this.joystickBase.className = "virtual-joystick-base";
      document.body.appendChild(this.joystickBase);
      this.joystickThumb = document.createElement("div");
      this.joystickThumb.className = "virtual-joystick-thumb";
      document.body.appendChild(this.joystickThumb);
    }
    this.joystickBase.style.display = "block";
    this.joystickThumb.style.display = "block";
    this.joystickBase.style.left = `${baseX}px`;
    this.joystickBase.style.top = `${baseY}px`;
    this.joystickThumb.style.left = `${thumbX}px`;
    this.joystickThumb.style.top = `${thumbY}px`;
  }

  hideJoystick() {
    if (this.joystickBase) this.joystickBase.style.display = "none";
    if (this.joystickThumb) this.joystickThumb.style.display = "none";
  }

  toggleAutoAim() {
    this.autoAim = !this.autoAim;
    return this.autoAim;
  }

  cycleTargetMode() {
    const modes = TARGET_MODES;
    const next = (modes.indexOf(this.targetMode) + 1) % modes.length;
    this.targetMode = modes[next];
    return this.targetMode;
  }

  sample({ player = null, renderer = null, simulation = null, dt = 0 } = {}) {
    if (player) {
      this.aimX = player.aimX ?? player.facingX ?? this.aimX;
      this.aimY = player.aimY ?? player.facingY ?? this.aimY;
    }

    if (this.touch !== null) {
      const aim = this.autoAim
        ? this.computeAutoAim(player, simulation, dt)
        : { x: player?.facingX ?? this.aimX, y: player?.facingY ?? this.aimY };
      this.aimX = aim.x;
      this.aimY = aim.y;
      return {
        moveX: this.touchVector.x,
        moveY: this.touchVector.y,
        aimX: aim.x,
        aimY: aim.y,
      };
    }

    let moveX = 0;
    let moveY = 0;
    for (const key of this.keys) {
      const vector = keyMap.get(key);
      if (!vector) continue;
      moveX += vector[0];
      moveY += vector[1];
    }

    const move = normalize(moveX, moveY);
    let aim;
    if (this.autoAim) {
      aim = this.computeAutoAim(player, simulation, dt);
    } else {
      const pointerAim =
        this.pointer && player && renderer?.screenToWorld ? aimFromPointer(this.pointer, player, renderer) : null;
      aim = pointerAim ?? { x: player?.facingX ?? this.aimX, y: player?.facingY ?? this.aimY };
    }
    this.aimX = aim.x;
    this.aimY = aim.y;
    return { moveX: move.x, moveY: move.y, aimX: aim.x, aimY: aim.y };
  }

  computeAutoAim(player, simulation, dt) {
    const current = normalize(this.aimX, this.aimY);
    if (!player) return current;
    const target = pickTargetDirection(player, simulation, this.targetMode, current);
    const maxStep = Math.max(0, GAME.playerAimTurnRate ?? 14) * Math.max(0, dt);
    return rotateToward(current, target, maxStep);
  }
}

export const TARGET_MODES = ["nearest", "densest", "rarest", "tankiest"];

export const TARGET_MODE_LABELS = {
  nearest: "NEAREST",
  densest: "DENSEST",
  rarest: "HIGH RARITY",
  tankiest: "TANKIEST",
};

const RARITY_RANK = { boss: 4, rare: 3, elite: 2, normal: 1 };

function pickTargetDirection(player, simulation, mode, fallback) {
  const enemies = simulation?.enemies;
  if (!enemies) return fallback;
  const acquireRadius = GAME.autoAimAcquireRadius ?? 1100;
  const maxDistSq = acquireRadius * acquireRadius;
  const candidates = [];
  for (const enemy of enemies.values()) {
    const dx = enemy.x - player.x;
    const dy = enemy.y - player.y;
    const distSq = dx * dx + dy * dy;
    if (distSq <= maxDistSq) candidates.push({ enemy, distSq });
  }
  if (!candidates.length) return fallback;

  let best = candidates[0];
  if (mode === "densest") {
    const r = GAME.autoAimDensityRadius ?? 220;
    const r2 = r * r;
    let bestScore = -Infinity;
    for (const c of candidates) {
      let count = 0;
      for (const other of candidates) {
        const dx = other.enemy.x - c.enemy.x;
        const dy = other.enemy.y - c.enemy.y;
        if (dx * dx + dy * dy <= r2) count += 1;
      }
      const score = count - c.distSq * 1e-6;
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }
  } else if (mode === "rarest") {
    let bestScore = -Infinity;
    for (const c of candidates) {
      const rank = RARITY_RANK[c.enemy.rarity] ?? 1;
      const score = rank * 1e9 - c.distSq;
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }
  } else if (mode === "tankiest") {
    let bestScore = -Infinity;
    for (const c of candidates) {
      const score = (c.enemy.hp ?? 0) * 1e3 - c.distSq * 1e-3;
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }
  } else {
    let bestDist = Infinity;
    for (const c of candidates) {
      if (c.distSq < bestDist) {
        bestDist = c.distSq;
        best = c;
      }
    }
  }

  return normalize(best.enemy.x - player.x, best.enemy.y - player.y);
}

function rotateToward(current, target, maxStep) {
  const currentAngle = Math.atan2(current.y, current.x);
  const targetAngle = Math.atan2(target.y, target.x);
  let diff = targetAngle - currentAngle;
  while (diff > Math.PI) diff -= 2 * Math.PI;
  while (diff < -Math.PI) diff += 2 * Math.PI;
  if (maxStep <= 0) return current;
  const stepped = Math.abs(diff) <= maxStep ? targetAngle : currentAngle + Math.sign(diff) * maxStep;
  return { x: Math.cos(stepped), y: Math.sin(stepped) };
}

function aimFromPointer(pointer, player, renderer) {
  const world = renderer.screenToWorld(pointer.clientX, pointer.clientY);
  return normalize(world.x - player.x, world.y - player.y);
}

function pointFromEvent(touch) {
  if (!touch) return null;
  if (touch.clientX === undefined || touch.clientY === undefined) return null;
  return { x: touch.clientX, y: touch.clientY };
}

function findTouch(event, id) {
  if (!event.changedTouches) return event;
  for (const touch of event.changedTouches) {
    if (touch.identifier === id) return touch;
  }
  return null;
}
