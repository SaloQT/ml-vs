// ONNX Runtime CPU wrapper for hidden-64 MLP forward+backward.
//
// Loads two ONNX graphs per (F,H,A): forward and backward. Weights are passed
// in as session inputs each call (so they live in plain JS arrays in the
// trainers and can be updated in-place between batches).
//
// Lazy-init: import is dynamic so the module is harmless if onnxruntime-node
// is missing. ortAvailable() reports whether the runtime + graphs are usable.
//
// Falls back to JS path in trainer if any of: import fails, model file missing,
// session.run throws.
//
// Math (mirrors src/mlp.js conventions, but row-major Float32):
//   Forward:  H = relu(X @ Wh + bh);  Logits = H @ Wo + bo
//   Backward: gWo = H^T @ dLogits; gBo = sum_b dLogits;
//             dH = (dLogits @ Wo^T) * (H>0); gWh = X^T @ dH; gBh = sum_b dH
// Note JS-side weights have layout [H][F] for hidden (rows-per-hidden) and
// [A][H] for output (rows-per-action). We pack to row-major [F,H] / [H,A] for
// ORT by transposing on the way in/out.

// Defer all environment-specific imports until we're actually used.
const IS_NODE = typeof process !== "undefined" && !!process.versions?.node;
const IS_BROWSER = typeof window !== "undefined" || typeof self !== "undefined";

// Allow callers (tests, benchmarks) to force the JS path even where ORT is
// available. Set window.__DISABLE_ORT__ = true before any trainer is created.
function ortDisabled() {
  if (IS_NODE) return process.env.DISABLE_ORT === "1";
  try {
    const g = typeof window !== "undefined" ? window : self;
    return !!g.__DISABLE_ORT__;
  } catch {
    return false;
  }
}

let ortPromise = null;
async function loadOrt() {
  if (ortDisabled()) return null;
  if (ortPromise) return ortPromise;
  if (IS_NODE) {
    ortPromise = import("onnxruntime-node").catch(() => null);
    return ortPromise;
  }
  if (IS_BROWSER) {
    // Use absolute path served by dev-server (no bundler in this project).
    // ort.wasm.bundle.min.mjs is the WASM-only browser build; its glue file
    // and .wasm sibling live in /assets/ort/.
    ortPromise = (async () => {
      try {
        const mod = await import(/* @vite-ignore */ "/assets/ort/ort.mjs");
        const ort = mod.default ?? mod;
        if (!ort?.env?.wasm) return null;
        // Multi-threaded WASM via SharedArrayBuffer. Requires COOP/COEP headers
        // (set in scripts/dev-server.mjs). Cap threads to keep contention with
        // the rollout loop manageable; navigator.hardwareConcurrency is the ceiling.
        const cores = (typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 4;
        ort.env.wasm.numThreads = Math.min(4, Math.max(1, cores - 1));
        ort.env.wasm.proxy = false;
        ort.env.wasm.wasmPaths = "/assets/ort/";
        ort.env.logLevel = "error";
        return ort;
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn("[ortMlp] onnxruntime-web import failed:", err?.message ?? err);
        return null;
      }
    })();
    return ortPromise;
  }
  ortPromise = Promise.resolve(null);
  return ortPromise;
}

let _nodeMods = null;
async function loadNodeMods() {
  if (!IS_NODE) return null;
  if (_nodeMods) return _nodeMods;
  const [{ fileURLToPath }, path, fs] = await Promise.all([
    import("node:url"),
    import("node:path").then((m) => m.default ?? m),
    import("node:fs").then((m) => m.default ?? m),
  ]);
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const GRAPH_DIR = path.join(__dirname, "..", "experiments", "gpu", "ort");
  _nodeMods = { path, fs, GRAPH_DIR };
  return _nodeMods;
}

// Returns a value suitable for InferenceSession.create():
//  - Node: an absolute filesystem path (string), letting ORT mmap the file.
//  - Browser: a Uint8Array fetched from the dev server.
async function loadGraph(kind, F, H, A) {
  if (IS_NODE) {
    const mods = await loadNodeMods();
    if (!mods) return null;
    const p = mods.path.join(mods.GRAPH_DIR, `${kind}_F${F}_H${H}_A${A}.onnx`);
    if (!mods.fs.existsSync(p)) return null;
    return p;
  }
  if (IS_BROWSER) {
    // Resolve relative to the project root via dev-server's static handler.
    const url = `/experiments/gpu/ort/${kind}_F${F}_H${H}_A${A}.onnx`;
    try {
      const resp = await fetch(url);
      if (!resp.ok) return null;
      const buf = await resp.arrayBuffer();
      return new Uint8Array(buf);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[ortMlp] fetch ${url} failed:`, err?.message ?? err);
      return null;
    }
  }
  return null;
}

export async function ortAvailable() {
  const ort = await loadOrt();
  return !!ort;
}

// Test/observability helper: which backend is in use? "node" | "web" | null.
export async function ortBackend() {
  const ort = await loadOrt();
  if (!ort) return null;
  return IS_NODE ? "node" : "web";
}

// Pack JS hidden W (rows[H] of length F) into Float32 row-major [F,H].
function packWh(W, F, H, out) {
  // out[f*H + i] = W[i][f]
  for (let i = 0; i < H; i += 1) {
    const row = W[i];
    for (let f = 0; f < F; f += 1) out[f * H + i] = row[f];
  }
  return out;
}

// Unpack gWh [F,H] into JS hidden gradient layout [H][F] applied as SGD step.
function applyGradWh(W, gWh, F, H, scale) {
  for (let i = 0; i < H; i += 1) {
    const row = W[i];
    for (let f = 0; f < F; f += 1) row[f] += scale * gWh[f * H + i];
  }
}

// Pack JS output W (rows[A] of length H) into Float32 [H,A].
function packWo(W, H, A, out) {
  // out[h*A + a] = W[a][h]
  for (let a = 0; a < A; a += 1) {
    const row = W[a];
    for (let h = 0; h < H; h += 1) out[h * A + a] = row[h];
  }
  return out;
}

function applyGradWo(W, gWo, H, A, scale) {
  for (let a = 0; a < A; a += 1) {
    const row = W[a];
    for (let h = 0; h < H; h += 1) row[h] += scale * gWo[h * A + a];
  }
}

export class OrtMlpSession {
  constructor({ F, H, A }) {
    this.F = F; this.H = H; this.A = A;
    this.fwd = null;
    this.bwd = null;
    this.ort = null;
    // Reusable Float32 packing buffers for weights (small, allocate once).
    this._whBuf = new Float32Array(F * H);
    this._woBuf = new Float32Array(H * A);
  }

  async init() {
    const ort = await loadOrt();
    if (!ort) return false;
    const fwdGraph = await loadGraph("forward", this.F, this.H, this.A);
    const bwdGraph = await loadGraph("backward", this.F, this.H, this.A);
    if (!fwdGraph || !bwdGraph) return false;
    // intraOp/interOp threads = 1 (Node only — these are CPU EP knobs).
    // For browser/WASM the same single-threaded policy is enforced via
    // ort.env.wasm.numThreads = 1 set at import time. Tiny graphs (B<=256,
    // H=64) gain nothing from threading and add scheduler contention.
    const opts = IS_NODE
      ? {
          executionProviders: ["cpu"],
          graphOptimizationLevel: "all",
          logSeverityLevel: 3,
          intraOpNumThreads: 1,
          interOpNumThreads: 1,
        }
      : {
          executionProviders: ["wasm"],
          graphOptimizationLevel: "all",
          logSeverityLevel: 3,
        };
    try {
      this.fwd = await ort.InferenceSession.create(fwdGraph, opts);
      this.bwd = await ort.InferenceSession.create(bwdGraph, opts);
      this.ort = ort;
      return true;
    } catch (e) {
      this.fwd = null; this.bwd = null;
      // eslint-disable-next-line no-console
      if (IS_BROWSER) console.warn("[ortMlp] session create failed:", e?.message ?? e);
      return false;
    }
  }

  // X: Float32Array of length B*F. hidden: { W:[H][F], b:[H] }. out: { W:[A][H], b:[A] }.
  // Returns { H: Float32Array[B*H], Logits: Float32Array[B*A] }.
  async forwardBatch(X, B, hidden, outRows, outBias) {
    const ort = this.ort;
    const { F, H, A } = this;
    packWh(hidden.W, F, H, this._whBuf);
    packWo(outRows, H, A, this._woBuf);
    const bh = Float32Array.from(hidden.b);
    const bo = Float32Array.from(outBias ?? new Array(A).fill(0));
    const feeds = {
      X: new ort.Tensor("float32", X, [B, F]),
      Wh: new ort.Tensor("float32", this._whBuf, [F, H]),
      bh: new ort.Tensor("float32", bh, [H]),
      Wo: new ort.Tensor("float32", this._woBuf, [H, A]),
      bo: new ort.Tensor("float32", bo, [A]),
    };
    const out = await this.fwd.run(feeds);
    return { H: out.H.data, Logits: out.Logits.data };
  }

  // dLogits: Float32Array[B*A]. Returns grad sums (NOT mean).
  async backwardBatch(X, B, Hact, outRows, dLogits) {
    const ort = this.ort;
    const { F, H, A } = this;
    packWo(outRows, H, A, this._woBuf);
    const feeds = {
      X: new ort.Tensor("float32", X, [B, F]),
      H: new ort.Tensor("float32", Hact, [B, H]),
      Wo: new ort.Tensor("float32", this._woBuf, [H, A]),
      dLogits: new ort.Tensor("float32", dLogits, [B, A]),
    };
    const out = await this.bwd.run(feeds);
    return {
      gWo: out.gWo.data,
      gBo: out.gBo.data,
      gWh: out.gWh.data,
      gBh: out.gBh.data,
    };
  }

  // Apply SGD update with grads from backwardBatch. Hidden + output W/b mutated.
  applySgd(hidden, outRows, outBias, grads, lr) {
    const { F, H, A } = this;
    const scale = -lr;
    applyGradWo(outRows, grads.gWo, H, A, scale);
    if (outBias) for (let a = 0; a < A; a += 1) outBias[a] += scale * grads.gBo[a];
    applyGradWh(hidden.W, grads.gWh, F, H, scale);
    for (let i = 0; i < H; i += 1) hidden.b[i] += scale * grads.gBh[i];
  }
}

// Convenience: full minibatch update (forward, JS dLogits callback, backward, SGD).
// dLogitsFn(features[B][F], H[B*H], Logits[B*A]) -> Float32Array[B*A].
export async function ortMinibatchUpdate(session, X, B, hidden, outRows, outBias, dLogitsFn, lr) {
  const fwd = await session.forwardBatch(X, B, hidden, outRows, outBias);
  const dLogits = dLogitsFn(fwd.H, fwd.Logits);
  const grads = await session.backwardBatch(X, B, fwd.H, outRows, dLogits);
  session.applySgd(hidden, outRows, outBias, grads, lr);
  return { H: fwd.H, Logits: fwd.Logits };
}
