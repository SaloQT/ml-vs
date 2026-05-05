// Allocation-free forward for the rollout hot path.
//
// Operates directly on the existing Array<Array<number>> storage used by
// trainers (no F32 packing, no synchronization step). The win comes from
// reusing pre-allocated output buffers and avoiding the intermediate Array
// allocations that the original `hiddenForward` / `outputForward` produce
// per tick.
//
// Caller passes a preallocated `hOut` (length H) and `logitsOut` (length A).

export function forwardFastJs(hidden, outRows, outBias, features, hOut, logitsOut) {
  const W = hidden.W;
  const b = hidden.b;
  const H = W.length;
  const F = features.length;
  for (let i = 0; i < H; i += 1) {
    const row = W[i];
    let s = b[i];
    for (let j = 0; j < F; j += 1) s += row[j] * features[j];
    hOut[i] = s > 0 ? s : 0;
  }
  const A = outRows.length;
  for (let a = 0; a < A; a += 1) {
    const row = outRows[a];
    let s = outBias ? outBias[a] : 0;
    for (let i = 0; i < H; i += 1) s += row[i] * hOut[i];
    logitsOut[a] = s;
  }
}

// Softmax that writes probabilities into a caller-provided output array.
export function softmaxInto(logits, outArr) {
  const n = logits.length;
  let mx = -Infinity;
  for (let i = 0; i < n; i += 1) if (logits[i] > mx) mx = logits[i];
  let total = 0;
  for (let i = 0; i < n; i += 1) {
    const e = Math.exp(logits[i] - mx);
    outArr[i] = e;
    total += e;
  }
  for (let i = 0; i < n; i += 1) outArr[i] /= total;
  return outArr;
}
