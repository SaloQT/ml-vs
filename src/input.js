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

export class InputController {
  constructor() {
    this.keys = new Set();
    window.addEventListener("keydown", (event) => this.keys.add(event.code));
    window.addEventListener("keyup", (event) => this.keys.delete(event.code));
  }

  sample() {
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
