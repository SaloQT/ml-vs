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
    window.addEventListener("keydown", (event) => this.keys.add(event.code));
    window.addEventListener("keyup", (event) => this.keys.delete(event.code));
    if (touchTarget) this.attachTouch(touchTarget);
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

    target.addEventListener("touchstart", start, { passive: false });
    target.addEventListener("touchmove", move, { passive: false });
    target.addEventListener("touchend", end);
    target.addEventListener("touchcancel", end);
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

  sample() {
    if (this.touch !== null) {
      return { moveX: this.touchVector.x, moveY: this.touchVector.y };
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
    return {
      moveX: move.x,
      moveY: move.y,
    };
  }
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
