// CPU baselines for the same kernels we benchmark on GPU.
// All uses Float32Array to match GPU precision.

import { performance } from "node:perf_hooks";

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

// -------- 1. Batched matmul: C[B,N,K] = A[B,N,M] * B[B,M,K]
// We use a single shared weight: A is the policy/Q weight matrix [N, M].
// X is the batched input [B, M].
// Output: Y [B, N] = X * A^T.
function matmulCpu(X, W, B, M, N) {
  // X: B x M, W: N x M (row-major), Y: B x N
  const Y = new Float32Array(B * N);
  for (let b = 0; b < B; b++) {
    for (let n = 0; n < N; n++) {
      let s = 0;
      const wRow = n * M;
      const xRow = b * M;
      for (let m = 0; m < M; m++) s += X[xRow + m] * W[wRow + m];
      Y[b * N + n] = s;
    }
  }
  return Y;
}

// -------- 2. Two-layer MLP forward: relu(X @ W1^T + b1) @ W2^T + b2
function mlpCpu(X, W1, b1, W2, b2, B, M, H, N) {
  const hidden = new Float32Array(B * H);
  for (let b = 0; b < B; b++) {
    for (let h = 0; h < H; h++) {
      let s = b1[h];
      const wRow = h * M;
      const xRow = b * M;
      for (let m = 0; m < M; m++) s += X[xRow + m] * W1[wRow + m];
      hidden[b * H + h] = s > 0 ? s : 0;
    }
  }
  const Y = new Float32Array(B * N);
  for (let b = 0; b < B; b++) {
    for (let n = 0; n < N; n++) {
      let s = b2[n];
      const wRow = n * H;
      const hRow = b * H;
      for (let h = 0; h < H; h++) s += hidden[hRow + h] * W2[wRow + h];
      Y[b * N + n] = s;
    }
  }
  return Y;
}

// -------- 3. Row-wise softmax over [B, N]
function softmaxCpu(X, B, N) {
  const Y = new Float32Array(B * N);
  for (let b = 0; b < B; b++) {
    let mx = -Infinity;
    for (let n = 0; n < N; n++) if (X[b * N + n] > mx) mx = X[b * N + n];
    let sum = 0;
    for (let n = 0; n < N; n++) {
      const e = Math.exp(X[b * N + n] - mx);
      Y[b * N + n] = e;
      sum += e;
    }
    const inv = 1 / sum;
    for (let n = 0; n < N; n++) Y[b * N + n] *= inv;
  }
  return Y;
}

function fillRand(n, seed = 1) {
  // deterministic xorshift -> [-1, 1)
  let s = seed | 0 || 1;
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    a[i] = ((s | 0) / 2147483648);
  }
  return a;
}

function bench(label, fn, opts = {}) {
  const maxIters = opts.maxIters ?? 50;
  const warmup = opts.warmup ?? 5;
  const budgetMs = opts.budgetMs ?? 1500; // total time budget per case
  // adaptive warmup: a single call to estimate
  const t0 = performance.now();
  fn();
  const single = performance.now() - t0;
  const iters = Math.max(3, Math.min(maxIters, Math.floor(budgetMs / Math.max(single, 0.01))));
  for (let i = 1; i < warmup; i++) fn();
  const times = [];
  for (let i = 0; i < iters; i++) {
    const a = performance.now();
    fn();
    times.push(performance.now() - a);
  }
  return { label, median_ms: median(times), iters };
}

const SIZES = [1, 8, 32, 128, 512, 2048];

function dumpFloat32(path, arr) {
  const fs = require("node:fs");
  const buf = Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
  fs.writeFileSync(path, buf);
}

// Cases for the trainer's actual sizes
const CASES = [
  // Linear policy: [B, 18] * [9, 18]^T -> [B, 9]   (PPO/REINFORCE/A2C/DQN)
  { name: "linear_18x9",  M: 18,   N: 9 },
  // Synthetic medium
  { name: "matmul_64",    M: 64,   N: 64 },
  { name: "matmul_256",   M: 256,  N: 256 },
  { name: "matmul_1024",  M: 1024, N: 1024 },
  { name: "matmul_4096",  M: 4096, N: 4096 },
];

const MLP_CASES = [
  // Hypothetical DQN with hidden layer (currently linear) - speculative architecture
  { name: "mlp_18_64_9",   M: 18,   H: 64,   N: 9 },
  { name: "mlp_18_256_9",  M: 18,   H: 256,  N: 9 },
  { name: "mlp_512_512_512", M: 512, H: 512, N: 512 },
];

const results = [];

for (const c of CASES) {
  for (const B of SIZES) {
    // Skip cases that would take >5s in plain JS
    const flops = B * c.M * c.N;
    if (flops > 1e9) { results.push({ kind: "matmul", case: c.name, M: c.M, N: c.N, B, cpu_ms: null, skipped: "too_slow" }); continue; }
    const X = fillRand(B * c.M, 11);
    const W = fillRand(c.N * c.M, 22);
    const r = bench(`matmul ${c.name} B=${B}`, () => matmulCpu(X, W, B, c.M, c.N));
    results.push({ kind: "matmul", case: c.name, M: c.M, N: c.N, B, cpu_ms: r.median_ms });
  }
}

for (const c of MLP_CASES) {
  for (const B of SIZES) {
    const flops = B * (c.M * c.H + c.H * c.N);
    if (flops > 1e9) { results.push({ kind: "mlp", case: c.name, M: c.M, H: c.H, N: c.N, B, cpu_ms: null, skipped: "too_slow" }); continue; }
    const X = fillRand(B * c.M, 11);
    const W1 = fillRand(c.H * c.M, 22);
    const b1 = fillRand(c.H, 33);
    const W2 = fillRand(c.N * c.H, 44);
    const b2 = fillRand(c.N, 55);
    const r = bench(`mlp ${c.name} B=${B}`,
      () => mlpCpu(X, W1, b1, W2, b2, B, c.M, c.H, c.N));
    results.push({ kind: "mlp", case: c.name, M: c.M, H: c.H, N: c.N, B, cpu_ms: r.median_ms });
  }
}

// Softmax
for (const N of [9, 64, 256, 1024]) {
  for (const B of SIZES) {
    const X = fillRand(B * N, 7);
    const r = bench(`softmax B=${B} N=${N}`, () => softmaxCpu(X, B, N));
    results.push({ kind: "softmax", N, B, cpu_ms: r.median_ms });
  }
}

console.log(JSON.stringify(results, null, 2));
