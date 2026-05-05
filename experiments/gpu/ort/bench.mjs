// Benchmark onnxruntime-node forward pass vs CPU JS forward.
// Forward-only on GPU (approach a): the per-call cost is matmul+relu+matmul+add.
// We compare CPU-only JS, ORT-CPU EP, ORT-CUDA EP across batch sizes.
// We also do a correctness check vs JS forward using identical weights loaded
// from the .weights.bin file produced by build_model.py.

import * as ort from "onnxruntime-node";
import { performance } from "node:perf_hooks";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODEL_PATH = path.join(__dirname, "mlp_forward.onnx");
const WEIGHTS_PATH = MODEL_PATH + ".weights.bin";

const F = 18;
const HIDDEN = 64;
const A = 9;

function loadWeights() {
  const buf = fs.readFileSync(WEIGHTS_PATH);
  const f32 = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  let p = 0;
  const Wh = f32.slice(p, p + F * HIDDEN); p += F * HIDDEN;        // [F, HIDDEN]
  const bh = f32.slice(p, p + HIDDEN); p += HIDDEN;
  const Wout = f32.slice(p, p + HIDDEN * A); p += HIDDEN * A;      // [HIDDEN, A]
  const bout = f32.slice(p, p + A); p += A;
  return { Wh, bh, Wout, bout };
}

function jsForward(X, B, weights) {
  const { Wh, bh, Wout, bout } = weights;
  const out = new Float32Array(B * A);
  const h = new Float32Array(HIDDEN);
  for (let s = 0; s < B; s += 1) {
    // hidden
    for (let i = 0; i < HIDDEN; i += 1) {
      let v = bh[i];
      const xOff = s * F;
      for (let j = 0; j < F; j += 1) v += X[xOff + j] * Wh[j * HIDDEN + i];
      h[i] = v > 0 ? v : 0;
    }
    // output
    for (let a = 0; a < A; a += 1) {
      let v = bout[a];
      for (let i = 0; i < HIDDEN; i += 1) v += h[i] * Wout[i * A + a];
      out[s * A + a] = v;
    }
  }
  return out;
}

function makeInput(B, seed = 1) {
  const rng = (() => { let s = seed >>> 0 || 1; return () => { s = (1664525 * s + 1013904223) >>> 0; return s / 0x100000000; }; })();
  const X = new Float32Array(B * F);
  for (let i = 0; i < X.length; i += 1) X[i] = rng() * 2 - 1;
  return X;
}

async function makeSession(eps) {
  const opts = { executionProviders: eps, graphOptimizationLevel: "all", logSeverityLevel: 3 };
  return await ort.InferenceSession.create(MODEL_PATH, opts);
}

async function bench(session, B, iters) {
  const X = makeInput(B);
  const tensor = new ort.Tensor("float32", X, [B, F]);
  const feeds = { X: tensor };
  // warmup
  for (let i = 0; i < 10; i += 1) await session.run(feeds);
  const samples = [];
  for (let i = 0; i < iters; i += 1) {
    const t0 = performance.now();
    await session.run(feeds);
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  return { medianMs: samples[Math.floor(samples.length / 2)], minMs: samples[0] };
}

async function benchJs(B, iters, weights) {
  const X = makeInput(B);
  for (let i = 0; i < 10; i += 1) jsForward(X, B, weights);
  const samples = [];
  for (let i = 0; i < iters; i += 1) {
    const t0 = performance.now();
    jsForward(X, B, weights);
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  return { medianMs: samples[Math.floor(samples.length / 2)], minMs: samples[0] };
}

async function correctness(session, weights) {
  const B = 64;
  const X = makeInput(B, 7);
  const feeds = { X: new ort.Tensor("float32", X, [B, F]) };
  const out = await session.run(feeds);
  const ortOut = out.Logits.data;
  const jsOut = jsForward(X, B, weights);
  let maxDiff = 0;
  for (let i = 0; i < ortOut.length; i += 1) {
    const d = Math.abs(ortOut[i] - jsOut[i]);
    if (d > maxDiff) maxDiff = d;
  }
  return maxDiff;
}

async function tryProvider(name, providerSpec) {
  try {
    const sess = await makeSession([providerSpec]);
    return { ok: true, sess };
  } catch (e) {
    return { ok: false, err: e.message };
  }
}

(async () => {
  const weights = loadWeights();
  const sizes = [16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192];
  const ITERS = 100;

  console.log("# ONNXRuntime forward-only benchmark (forward MLP, F=18 -> H=64 ReLU -> A=9)");
  console.log("");
  console.log(`ort version: ${ort.env.versions.node}`);
  console.log(`backends: ${JSON.stringify(ort.listSupportedBackends())}`);
  console.log("");

  console.log("## Provider initialization");
  const cpuProbe = await tryProvider("cpu", "cpu");
  console.log(`cpu EP: ${cpuProbe.ok ? "ok" : "FAIL: " + cpuProbe.err}`);
  let cudaProbe;
  try {
    const sess = await makeSession([{ name: "cuda", deviceId: 0 }]);
    cudaProbe = { ok: true, sess };
    console.log("cuda EP: ok");
  } catch (e) {
    cudaProbe = { ok: false, err: e.message };
    console.log("cuda EP: FAIL:", e.message);
  }
  let webgpuProbe;
  try {
    const sess = await makeSession(["webgpu"]);
    webgpuProbe = { ok: true, sess };
    console.log("webgpu EP: ok");
  } catch (e) {
    webgpuProbe = { ok: false, err: e.message };
    console.log("webgpu EP: FAIL:", e.message);
  }
  console.log("");

  // Correctness check (against ORT-CPU since that's authoritative)
  if (cpuProbe.ok) {
    const diff = await correctness(cpuProbe.sess, weights);
    console.log(`# Correctness: max abs diff JS forward vs ORT-CPU = ${diff.toExponential(3)}`);
  }
  if (cudaProbe.ok) {
    const diff = await correctness(cudaProbe.sess, weights);
    console.log(`# Correctness: max abs diff JS forward vs ORT-CUDA = ${diff.toExponential(3)}`);
  }
  console.log("");

  if (webgpuProbe.ok) {
    const diff = await correctness(webgpuProbe.sess, weights);
    console.log(`# Correctness: max abs diff JS forward vs ORT-WebGPU = ${diff.toExponential(3)}`);
  }
  console.log("");

  console.log("## Forward-only latency (ms median of 100, post-warmup)");
  console.log("| B | JS-CPU ms | JS-CPU samp/s | ORT-CPU ms | ORT-CPU samp/s | ORT-CUDA ms | ORT-CUDA samp/s | ORT-WGPU ms | ORT-WGPU samp/s |");
  console.log("|---|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const B of sizes) {
    const js = await benchJs(B, ITERS, weights);
    const cpu = cpuProbe.ok ? await bench(cpuProbe.sess, B, ITERS) : null;
    const cuda = cudaProbe.ok ? await bench(cudaProbe.sess, B, ITERS) : null;
    const wgpu = webgpuProbe.ok ? await bench(webgpuProbe.sess, B, ITERS) : null;
    const fmt = (r) => r ? `${r.medianMs.toFixed(3)} | ${(B / r.medianMs * 1000).toFixed(0)}` : "n/a | n/a";
    console.log(`| ${B} | ${fmt(js)} | ${fmt(cpu)} | ${fmt(cuda)} | ${fmt(wgpu)} |`);
  }

  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
