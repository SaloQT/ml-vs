// Optional GPU bridge for batched MLP forward+backward.
// Looks for a precompiled CUDA helper at experiments/gpu/mlp_train and
// pipes minibatches over stdin/stdout. If anything goes wrong, callers
// must fall back to the CPU path. Opt-in via USE_GPU=1 env var.
//
// Wire format (little-endian float32 unless noted):
//   stdin per minibatch:
//     [u32 magic=0xML10][u32 op][u32 B][u32 F][u32 H][u32 A]
//     hidden.W (H*F), hidden.b (H), outW (A*H), outB (A), X (B*F), dLogits (B*A), lr (1)
//   stdout per minibatch:
//     [u32 magic=0xML11][u32 B][u32 F][u32 H][u32 A]
//     hidden.W, hidden.b, outW, outB, lossSum (1)

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN_PATH = resolve(__dirname, "..", "experiments", "gpu", "mlp_train");

let _proc = null;
let _enabled = null;

// Weight-section cache: avoids re-packing the (hidden + output) weights every
// minibatch. Keyed by the `hidden` object so multiple heads (move/aim/upgrade)
// don't clobber each other. Cache entry stores the packed weight prefix
// (everything between the header and the X tensor) and the version it was
// captured at. We bump _gpuWeightVersion each time the GPU writes back new
// weights via unpackResponse.
const _weightCache = new WeakMap();

export function gpuEnabled(force = null) {
  if (force === true) _enabled = true;
  if (force === false) _enabled = false;
  if (_enabled !== null) return _enabled;
  if (process.env.USE_GPU !== "1") {
    _enabled = false;
    return false;
  }
  if (!existsSync(BIN_PATH)) {
    _enabled = false;
    return false;
  }
  try {
    _proc = spawn(BIN_PATH, [], { stdio: ["pipe", "pipe", "inherit"] });
    _proc.on("error", () => {
      _enabled = false;
      _proc = null;
    });
    _proc.on("exit", () => { _proc = null; });
    _enabled = true;
    return true;
  } catch (_e) {
    _enabled = false;
    return false;
  }
}

// Synchronous-style minibatch update via blocking stdio. Node doesn't expose
// sync stdio on a long-lived child, so we keep a request queue and use
// promises; callers should `await`.
export async function gpuMinibatchUpdate(hidden, outRows, outBias, X, dLogits, lr) {
  if (!_enabled || !_proc) return null;
  const F = hidden.featureCount;
  const H = hidden.hidden;
  const A = outRows.length;
  const B = X.length;
  const buf = packRequestCached(hidden, outRows, outBias, X, dLogits, lr, B, F, H, A);
  // Expected response size: 5 u32 header + (H*F + H + A*H + A + 1) f32
  const expected = 5 * 4 + (H * F + H + A * H + A + 1) * 4;
  return new Promise((resolveCb, rejectCb) => {
    let acc = Buffer.alloc(0);
    const onData = (chunk) => {
      acc = Buffer.concat([acc, chunk]);
      if (acc.length < expected) return;
      _proc.stdout.off("data", onData);
      const result = unpackResponse(acc, F, H, A);
      if (!result) return rejectCb(new Error("gpu protocol error"));
      // Write back
      for (let i = 0; i < H; i += 1) {
        for (let j = 0; j < F; j += 1) hidden.W[i][j] = result.W[i * F + j];
        hidden.b[i] = result.b[i];
      }
      for (let a = 0; a < A; a += 1) {
        for (let i = 0; i < H; i += 1) outRows[a][i] = result.outW[a * H + i];
        if (outBias) outBias[a] = result.outB[a];
      }
      // Weights have changed — bump the version so the next pack rebuilds
      // the cached weight section instead of reusing stale bytes.
      hidden._gpuWeightVersion = (hidden._gpuWeightVersion | 0) + 1;
      resolveCb({ loss: result.loss });
    };
    _proc.stdout.on("data", onData);
    _proc.stdin.write(buf);
  });
}

// Pack with a cached weight section. The header (24 bytes) + weights are
// recomputed only when `hidden._gpuWeightVersion` changes; X / dLogits / lr
// are written fresh every call since they are inherently per-minibatch.
function packRequestCached(hidden, outRows, outBias, X, dLogits, lr, B, F, H, A) {
  const headerBytes = 6 * 4;
  const weightFloats = H * F + H + A * H + A;
  const weightBytes = weightFloats * 4;
  const payloadFloats = B * F + B * A + 1;
  const totalBytes = headerBytes + weightBytes + payloadFloats * 4;
  const buf = Buffer.alloc(totalBytes);
  // Header (B can change between calls so always rewrite).
  let off = 0;
  buf.writeUInt32LE(0x4d4c3130, off); off += 4;
  buf.writeUInt32LE(1, off); off += 4;
  buf.writeUInt32LE(B, off); off += 4;
  buf.writeUInt32LE(F, off); off += 4;
  buf.writeUInt32LE(H, off); off += 4;
  buf.writeUInt32LE(A, off); off += 4;
  // Weight section: reuse cached bytes if version matches.
  const version = hidden._gpuWeightVersion | 0;
  let cached = _weightCache.get(hidden);
  if (!cached || cached.version !== version || cached.F !== F || cached.H !== H || cached.A !== A
      || cached.outRows !== outRows || cached.outBias !== outBias) {
    const weightBuf = Buffer.alloc(weightBytes);
    let woff = 0;
    for (let i = 0; i < H; i += 1) {
      const row = hidden.W[i];
      for (let j = 0; j < F; j += 1) { weightBuf.writeFloatLE(row[j], woff); woff += 4; }
    }
    for (let i = 0; i < H; i += 1) { weightBuf.writeFloatLE(hidden.b[i], woff); woff += 4; }
    for (let a = 0; a < A; a += 1) {
      const row = outRows[a];
      for (let i = 0; i < H; i += 1) { weightBuf.writeFloatLE(row[i] ?? 0, woff); woff += 4; }
    }
    for (let a = 0; a < A; a += 1) { weightBuf.writeFloatLE(outBias ? outBias[a] : 0, woff); woff += 4; }
    cached = { version, F, H, A, outRows, outBias, buf: weightBuf };
    _weightCache.set(hidden, cached);
  }
  cached.buf.copy(buf, off);
  off += weightBytes;
  // Per-minibatch payload.
  for (let s = 0; s < B; s += 1) {
    const x = X[s];
    for (let j = 0; j < F; j += 1) { buf.writeFloatLE(x[j] ?? 0, off); off += 4; }
  }
  for (let s = 0; s < B; s += 1) {
    const d = dLogits[s];
    for (let a = 0; a < A; a += 1) { buf.writeFloatLE(d[a] ?? 0, off); off += 4; }
  }
  buf.writeFloatLE(lr, off); off += 4;
  return buf;
}

function packRequest(hidden, outRows, outBias, X, dLogits, lr, B, F, H, A) {
  const headerBytes = 6 * 4;
  const floats = H * F + H + A * H + A + B * F + B * A + 1;
  const buf = Buffer.alloc(headerBytes + floats * 4);
  let off = 0;
  buf.writeUInt32LE(0x4d4c3130, off); off += 4;
  buf.writeUInt32LE(1, off); off += 4;
  buf.writeUInt32LE(B, off); off += 4;
  buf.writeUInt32LE(F, off); off += 4;
  buf.writeUInt32LE(H, off); off += 4;
  buf.writeUInt32LE(A, off); off += 4;
  for (let i = 0; i < H; i += 1) {
    const row = hidden.W[i];
    for (let j = 0; j < F; j += 1) { buf.writeFloatLE(row[j], off); off += 4; }
  }
  for (let i = 0; i < H; i += 1) { buf.writeFloatLE(hidden.b[i], off); off += 4; }
  for (let a = 0; a < A; a += 1) {
    const row = outRows[a];
    for (let i = 0; i < H; i += 1) { buf.writeFloatLE(row[i] ?? 0, off); off += 4; }
  }
  for (let a = 0; a < A; a += 1) { buf.writeFloatLE(outBias ? outBias[a] : 0, off); off += 4; }
  for (let s = 0; s < B; s += 1) {
    const x = X[s];
    for (let j = 0; j < F; j += 1) { buf.writeFloatLE(x[j] ?? 0, off); off += 4; }
  }
  for (let s = 0; s < B; s += 1) {
    const d = dLogits[s];
    for (let a = 0; a < A; a += 1) { buf.writeFloatLE(d[a] ?? 0, off); off += 4; }
  }
  buf.writeFloatLE(lr, off); off += 4;
  return buf;
}

function unpackResponse(chunk, F, H, A) {
  if (chunk.length < 5 * 4) return null;
  if (chunk.readUInt32LE(0) !== 0x4d4c3131) return null;
  let off = 5 * 4;
  const W = new Float32Array(H * F);
  for (let i = 0; i < H * F; i += 1) { W[i] = chunk.readFloatLE(off); off += 4; }
  const b = new Float32Array(H);
  for (let i = 0; i < H; i += 1) { b[i] = chunk.readFloatLE(off); off += 4; }
  const outW = new Float32Array(A * H);
  for (let i = 0; i < A * H; i += 1) { outW[i] = chunk.readFloatLE(off); off += 4; }
  const outB = new Float32Array(A);
  for (let i = 0; i < A; i += 1) { outB[i] = chunk.readFloatLE(off); off += 4; }
  const loss = chunk.readFloatLE(off);
  return { W, b, outW, outB, loss };
}

export function gpuShutdown() {
  if (_proc) { try { _proc.kill(); } catch { /* noop */ } _proc = null; }
  _enabled = false;
}
