// Tiny shared MLP helpers for DQN/PPO. One hidden layer (ReLU) + linear output.
// Pure CPU, batched. Keeps the same number layout as the trainers' Array<Array<number>>.
// Network shape: features -> hidden(H, ReLU) -> outputs(A, linear).

export const HIDDEN = 64;

// He-init scaled with seeded RNG so it's deterministic across runs.
function lcg(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (1664525 * s + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

export function createHidden(featureCount, hidden = HIDDEN, seed = 1234) {
  const rand = lcg(seed);
  const W = Array.from({ length: hidden }, () => {
    const row = new Array(featureCount);
    const scale = Math.sqrt(2 / featureCount);
    for (let i = 0; i < featureCount; i += 1) row[i] = (rand() * 2 - 1) * scale;
    return row;
  });
  const b = new Array(hidden).fill(0);
  return { W, b, hidden, featureCount };
}

// Single-sample forward through hidden layer; returns hidden activations h.
export function hiddenForward(hidden, features) {
  const H = hidden.W.length;
  const F = features.length;
  const h = new Array(H);
  const W = hidden.W;
  const b = hidden.b;
  for (let i = 0; i < H; i += 1) {
    const row = W[i];
    let s = b[i];
    for (let j = 0; j < F; j += 1) s += row[j] * features[j];
    h[i] = s > 0 ? s : 0;
  }
  return h;
}

// Output: dot(outRows[a], h) for each a -> logits.
export function outputForward(outRows, h, outBias = null) {
  const A = outRows.length;
  const out = new Array(A);
  for (let a = 0; a < A; a += 1) {
    const row = outRows[a];
    const H = row.length;
    let s = outBias ? outBias[a] : 0;
    for (let i = 0; i < H; i += 1) s += row[i] * h[i];
    out[a] = s;
  }
  return out;
}

// Combined forward, returns { h, logits }.
export function forward(hidden, outRows, outBias, features) {
  const h = hiddenForward(hidden, features);
  const logits = outputForward(outRows, h, outBias);
  return { h, logits };
}

// Backward step for one sample given d_logits (gradient wrt outputs).
// Updates outRows, outBias, hidden.W, hidden.b in-place by SGD step (-lr * grad).
export function backwardSGD(hidden, outRows, outBias, features, h, dLogits, lr) {
  const A = outRows.length;
  const H = hidden.W.length;
  const F = features.length;
  // dHidden[i] = sum_a outRows[a][i] * dLogits[a] (only where h[i] > 0)
  const dH = new Array(H).fill(0);
  for (let a = 0; a < A; a += 1) {
    const dl = dLogits[a];
    if (dl === 0) continue;
    const row = outRows[a];
    for (let i = 0; i < H; i += 1) dH[i] += row[i] * dl;
    // update output row: row[i] -= lr * dl * h[i]
    const scale = -lr * dl;
    for (let i = 0; i < H; i += 1) row[i] += scale * h[i];
    if (outBias) outBias[a] += scale;
  }
  // ReLU mask, then update hidden
  const W = hidden.W;
  const b = hidden.b;
  for (let i = 0; i < H; i += 1) {
    if (h[i] <= 0) continue;
    const g = dH[i];
    if (g === 0) continue;
    const row = W[i];
    const scale = -lr * g;
    for (let j = 0; j < F; j += 1) row[j] += scale * features[j];
    b[i] += scale;
  }
}

export function cloneHidden(h) {
  return {
    W: h.W.map((r) => [...r]),
    b: [...h.b],
    hidden: h.hidden,
    featureCount: h.featureCount,
  };
}

export function serializeHidden(h) {
  return { W: h.W.map((r) => [...r]), b: [...h.b], hidden: h.hidden, featureCount: h.featureCount };
}

export function deserializeHidden(obj, featureCountFallback) {
  if (!obj || !Array.isArray(obj.W) || !Array.isArray(obj.b)) {
    return createHidden(featureCountFallback);
  }
  return {
    W: obj.W.map((r) => r.map(Number)),
    b: obj.b.map(Number),
    hidden: obj.hidden ?? obj.W.length,
    featureCount: obj.featureCount ?? obj.W[0]?.length ?? featureCountFallback,
  };
}
