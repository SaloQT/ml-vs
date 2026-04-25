export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function distanceSq(ax, ay, bx, by) {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}

export function normalize(x, y) {
  const length = Math.hypot(x, y);
  if (!length) return { x: 0, y: 0 };
  return { x: x / length, y: y / length };
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

export class Rng {
  constructor(seed = 1) {
    this.state = seed >>> 0;
  }

  next() {
    this.state = (1664525 * this.state + 1013904223) >>> 0;
    return this.state / 0x100000000;
  }

  range(min, max) {
    return lerp(min, max, this.next());
  }

  int(min, max) {
    return Math.floor(this.range(min, max + 1));
  }

  pick(items) {
    return items[Math.floor(this.next() * items.length)];
  }
}
