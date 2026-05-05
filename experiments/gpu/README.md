# GPU experiment: porting hot RL/sim functions to CUDA

Exploratory only. Nothing in `src/` is touched.

## What was tried

1. **`gpu.js`** — install fails: requires `gl` (headless OpenGL) which needs Python and X
   build deps not present in this WSL2 image. Skipped.
2. **WebGPU via Node** — Node 20.19 (this repo's version) has no `navigator.gpu`. Would
   need Node 22+ with `--experimental-webgpu` and a working Vulkan/Dawn stack on WSL.
   Skipped.
3. **`@tensorflow/tfjs-node-gpu`** — installs, but its prebuilt addon links against
   `libcudart.so.11.0` / `libcudnn.so.8`. Only CUDA 12 + no cuDNN are present, so it
   silently falls back to the CPU TensorFlow backend. Not useful here.
4. **Direct CUDA via `nvcc`** — works. CUDA 12.0 toolkit + RTX 2080 SUPER (sm_75) on
   WSL2. cuBLAS 12.0.2 returns `CUBLAS_STATUS_NOT_INITIALIZED` on this driver/WSL combo
   (filed bug class), so cuBLAS is avoided and a hand-written tiled matmul kernel is
   used instead. Custom kernels for ReLU+bias and softmax.

## Files

- `cpu_bench.mjs` — Node/JS Float32Array baselines (matmul, MLP forward, softmax)
- `gpu_bench.cu` — CUDA kernels and benchmark harness (cudaEvents + wallclock)
- `verify.cu` + `verify.mjs` — numerical equivalence check
- `gpu_results.json`, `cpu_results.json` — raw timings
- `report.mjs` — merges into `RESULTS.md`
- `RESULTS.md` — full table

## Method

- Float32 throughout.
- Median of 100 iters, 20-iter GPU warmup, adaptive CPU iters by 1.5 s budget.
- Two GPU numbers reported:
  - **kernel-only** via `cudaEvent` (post-warmup) — what you'd pay if X already lives on
    the device and you only need to read Y back lazily.
  - **end-to-end** wallclock — host->device copy of X + kernel + device->host copy of Y.
    This is the realistic per-tick cost.
- Numerical equivalence: max abs diff = 2.9e-5 (B=8, M=N=512), well below the 1e-3
  threshold.

## Verdict

The trainer's actual hot path is `dot(weights, features)` with **M=18, N=9, B=1**
(per-tick inference). At that shape:

| measure  | CPU JS  | GPU kernel-only | GPU end-to-end |
|----------|--------:|----------------:|---------------:|
| latency  | ~8 µs   | ~4 µs           | **~65 µs**     |

The GPU **kernel itself** beats CPU even at B=1, but PCIe round-trip and kernel-launch
overhead make the end-to-end **8x slower** than CPU. The crossover for the actual
trainer shape is around B≈256–512: only at that batch size does end-to-end GPU beat CPU
(2.4x at B=512, 6.1x at B=2048).

Per the synthetic results:

- **Tiny linear (18->9)**: GPU end-to-end pays off only at B≥512. Kernel speedup ramps
  from ~2x at B=1 to ~127x at B=2048.
- **Larger matmul** (256, 1024, 4096): GPU is faster end-to-end **at every batch
  size**, including B=1, because the CPU is already 0.1–30 ms per call. End-to-end
  speedup of 100–700x at modest batches.
- **MLP 18->64->9** (a plausible larger DQN): even with a hidden layer, end-to-end GPU
  ties CPU at B=1, beats it from B=32 onward (~5x at B=128, ~50x at B=2048).
- **MLP 512->512->512** (clearly bigger than anything in the trainers): GPU wins
  end-to-end at every batch, 7–290x.
- **Softmax**: only worth porting if N≥256 and B is moderate; at the actual N=9
  policy/Q outputs, CPU is faster end-to-end up to about B=512.

### Should we port the trainers?

**Per-tick inference (rollout): no.** Single-state inference is dominated by the
~60 µs PCIe round-trip; CPU JS does the whole 18×9 dot in ~8 µs. The simulation tick
is also branchy/serial — a non-starter on GPU.

**Batched off-policy update (DQN replay minibatch, PPO minibatches): maybe, if the
network grows.** With the current linear policy the math is so cheap that even at
B=2048 the CPU runs in <1 ms and a GPU port saves only fractions of a millisecond
amortized — not worth the porting cost. The picture changes if you add a hidden
layer of width ≥64 *and* batch ≥128 minibatches: at that point end-to-end GPU is
5–20x faster, which would matter if the wallclock for training is dominated by
forward/backward passes instead of simulation rollouts.

**Parallel rollouts on GPU: theoretically yes, but blocked by simulation.** The simple
matmul/softmax wins disappear once you remember that the bottleneck in a Vampire-
Survivors-like loop is the simulation step (`src/simulation.js`), which is intrinsically
serial-per-environment, not the policy forward pass. To benefit you'd have to vectorize
the simulation across many envs simultaneously on GPU — a 1–2 month project, not 2
hours.

### Practical recommendation

Keep the trainers on CPU. If/when DQN's Q-network is widened to 1+ hidden layers ≥64
units **and** minibatches ≥128 are an inner-loop bottleneck, revisit with one of:

- `onnxruntime-node` with the CUDA EP (cleanest API, lets you keep weights on device).
- Native CUDA addon via N-API (lowest overhead, most work).
- `tfjs-node-gpu` once a CUDA-11 / cuDNN-8 environment is available, or a build is
  released against CUDA 12.

The crossover batch size to keep in mind: end-to-end GPU starts winning the trainer's
actual 18->9 shape only at B≈256–512.

## To reproduce

```
nvcc -O3 -arch=sm_75 gpu_bench.cu -o gpu_bench
nvcc -O3 -arch=sm_75 verify.cu  -o verify
./gpu_bench > gpu_results.json
node cpu_bench.mjs > cpu_results.json
./verify && node verify.mjs           # numerical equivalence
node report.mjs                       # writes RESULTS.md
```
