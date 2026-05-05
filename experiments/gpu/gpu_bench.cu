// GPU benchmark: matmul (cuBLAS), MLP forward (cuBLAS + ReLU kernel), softmax kernel.
// Reports median latency in ms over many iterations after warmup.
// Uses CUDA events for device-side timing AND wallclock for end-to-end (incl. host->device).
//
// Build: nvcc -O3 gpu_bench.cu -o gpu_bench
//
// Note: cuBLAS init returned NOT_INITIALIZED on this WSL/driver combo
// (libcublas12 12.0.2 + driver from CUDA 13.1), so we use a hand-written
// tiled matmul kernel instead. For the trainer's tiny shapes this is fine.

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <vector>
#include <algorithm>
#include <chrono>
#include <cuda_runtime.h>

#define CK(x) do { cudaError_t e = (x); if (e != cudaSuccess) { \
  fprintf(stderr, "CUDA error %s at %s:%d\n", cudaGetErrorString(e), __FILE__, __LINE__); exit(1); } } while(0)

static double median(std::vector<double>& v) {
  std::sort(v.begin(), v.end());
  return v[v.size() / 2];
}

__global__ void reluKernel(float* x, int n) {
  int i = blockIdx.x * blockDim.x + threadIdx.x;
  if (i < n) x[i] = x[i] > 0.0f ? x[i] : 0.0f;
}

__global__ void biasReluKernel(float* x, const float* bias, int B, int H) {
  int i = blockIdx.x * blockDim.x + threadIdx.x;
  if (i < B * H) {
    float v = x[i] + bias[i % H];
    x[i] = v > 0.0f ? v : 0.0f;
  }
}

__global__ void biasKernel(float* x, const float* bias, int B, int N) {
  int i = blockIdx.x * blockDim.x + threadIdx.x;
  if (i < B * N) x[i] += bias[i % N];
}

// One block per row, parallel reduction in shared memory
__global__ void softmaxRowKernel(const float* __restrict__ in, float* __restrict__ out, int N) {
  extern __shared__ float sdata[];
  int row = blockIdx.x;
  int tid = threadIdx.x;
  const float* rowIn = in + row * N;
  float* rowOut = out + row * N;

  // max
  float mx = -INFINITY;
  for (int i = tid; i < N; i += blockDim.x) {
    float v = rowIn[i];
    if (v > mx) mx = v;
  }
  sdata[tid] = mx;
  __syncthreads();
  for (int s = blockDim.x / 2; s > 0; s >>= 1) {
    if (tid < s) sdata[tid] = fmaxf(sdata[tid], sdata[tid + s]);
    __syncthreads();
  }
  float rowMax = sdata[0];

  // exp + sum
  float sum = 0.0f;
  for (int i = tid; i < N; i += blockDim.x) {
    float e = __expf(rowIn[i] - rowMax);
    rowOut[i] = e;
    sum += e;
  }
  sdata[tid] = sum;
  __syncthreads();
  for (int s = blockDim.x / 2; s > 0; s >>= 1) {
    if (tid < s) sdata[tid] += sdata[tid + s];
    __syncthreads();
  }
  float rowSum = sdata[0];
  float inv = 1.0f / rowSum;
  for (int i = tid; i < N; i += blockDim.x) rowOut[i] *= inv;
}

struct BenchResult {
  const char* kind;
  const char* name;
  int M, H, N, B;
  double gpu_kernel_ms;   // device-only (events)
  double gpu_e2e_ms;      // host->compute->host wallclock
};

std::vector<BenchResult> RESULTS;

// Tiled matmul kernel: Y[B, N] = X[B, M] * W[N, M]^T
// All row-major. Each thread block computes a TILExTILE block of Y.
template<int TILE>
__global__ void matmulXWT(const float* __restrict__ X, const float* __restrict__ W,
                          float* __restrict__ Y, int B, int M, int N) {
  __shared__ float sX[TILE][TILE];
  __shared__ float sW[TILE][TILE];
  int row = blockIdx.y * TILE + threadIdx.y; // batch row in Y (0..B)
  int col = blockIdx.x * TILE + threadIdx.x; // output col in Y (0..N)
  float acc = 0.f;
  int tiles = (M + TILE - 1) / TILE;
  for (int t = 0; t < tiles; t++) {
    int xCol = t * TILE + threadIdx.x;
    // Load X[row, t*TILE+tx] into sX[ty][tx]
    sX[threadIdx.y][threadIdx.x] = (row < B && xCol < M) ? X[row * M + xCol] : 0.f;
    // For W [N,M], we need W[col_for_tx, wCol_for_k] at reduction step k.
    // Load sW[ty][tx] = W[blockIdx.x*TILE+tx, t*TILE+ty]; then sW[k][tx] = W[col_tx, t*TILE+k].
    int wRow = blockIdx.x * TILE + threadIdx.x;       // row in W (= output col)
    int wCol = t * TILE + threadIdx.y;                 // col in W (reduction dim)
    sW[threadIdx.y][threadIdx.x] = (wRow < N && wCol < M) ? W[wRow * M + wCol] : 0.f;
    __syncthreads();
    #pragma unroll
    for (int k = 0; k < TILE; k++) acc += sX[threadIdx.y][k] * sW[k][threadIdx.x];
    __syncthreads();
  }
  if (row < B && col < N) Y[row * N + col] = acc;
}

static void launchMatmul(const float* dX, const float* dW, float* dY, int B, int M, int N) {
  constexpr int TILE = 16;
  dim3 block(TILE, TILE);
  dim3 grid((N + TILE - 1) / TILE, (B + TILE - 1) / TILE);
  matmulXWT<TILE><<<grid, block>>>(dX, dW, dY, B, M, N);
}

void benchMatmul(const char* name, int M, int N, int B, int iters, int warmup) {
  size_t xN = (size_t)B * M;
  size_t wN = (size_t)N * M;
  size_t yN = (size_t)B * N;

  std::vector<float> hX(xN), hW(wN), hY(yN);
  for (size_t i = 0; i < xN; i++) hX[i] = (float)((i * 2654435761u) % 1000) / 500.f - 1.f;
  for (size_t i = 0; i < wN; i++) hW[i] = (float)((i * 40503u) % 1000) / 500.f - 1.f;

  float *dX, *dW, *dY;
  CK(cudaMalloc(&dX, xN * sizeof(float)));
  CK(cudaMalloc(&dW, wN * sizeof(float)));
  CK(cudaMalloc(&dY, yN * sizeof(float)));
  CK(cudaMemcpy(dW, hW.data(), wN * sizeof(float), cudaMemcpyHostToDevice));
  CK(cudaMemcpy(dX, hX.data(), xN * sizeof(float), cudaMemcpyHostToDevice));

  cudaEvent_t e0, e1;
  cudaEventCreate(&e0); cudaEventCreate(&e1);

  // Warmup
  for (int i = 0; i < warmup; i++) {
    launchMatmul(dX, dW, dY, B, M, N);
  }
  CK(cudaDeviceSynchronize());

  // Kernel-only timing
  std::vector<double> ks;
  for (int i = 0; i < iters; i++) {
    cudaEventRecord(e0);
    launchMatmul(dX, dW, dY, B, M, N);
    cudaEventRecord(e1);
    cudaEventSynchronize(e1);
    float ms; cudaEventElapsedTime(&ms, e0, e1);
    ks.push_back((double)ms);
  }

  // End-to-end timing (includes H->D for X, kernel, D->H for Y)
  std::vector<double> es;
  for (int i = 0; i < iters; i++) {
    auto t0 = std::chrono::high_resolution_clock::now();
    CK(cudaMemcpy(dX, hX.data(), xN * sizeof(float), cudaMemcpyHostToDevice));
    launchMatmul(dX, dW, dY, B, M, N);
    CK(cudaMemcpy(hY.data(), dY, yN * sizeof(float), cudaMemcpyDeviceToHost));
    auto t1 = std::chrono::high_resolution_clock::now();
    es.push_back(std::chrono::duration<double, std::milli>(t1 - t0).count());
  }

  BenchResult r{"matmul", name, M, 0, N, B, median(ks), median(es)};
  RESULTS.push_back(r);

  cudaFree(dX); cudaFree(dW); cudaFree(dY);
  cudaEventDestroy(e0); cudaEventDestroy(e1);
}

void benchMlp(const char* name, int M, int H, int N, int B, int iters, int warmup) {
  size_t xN = (size_t)B * M, w1N = (size_t)H * M, b1N = H;
  size_t hN = (size_t)B * H, w2N = (size_t)N * H, b2N = N, yN = (size_t)B * N;
  std::vector<float> hX(xN), hW1(w1N), hb1(b1N), hW2(w2N), hb2(b2N), hY(yN);
  for (size_t i = 0; i < xN; i++)  hX[i]  = (float)((i*1.3) - 0.5);
  for (size_t i = 0; i < w1N; i++) hW1[i] = (float)((i % 23) - 11) / 11.f;
  for (size_t i = 0; i < b1N; i++) hb1[i] = 0.01f * i;
  for (size_t i = 0; i < w2N; i++) hW2[i] = (float)((i % 17) - 8) / 8.f;
  for (size_t i = 0; i < b2N; i++) hb2[i] = -0.01f * i;

  float *dX, *dW1, *db1, *dH, *dW2, *db2, *dY;
  CK(cudaMalloc(&dX, xN*4)); CK(cudaMalloc(&dW1, w1N*4)); CK(cudaMalloc(&db1, b1N*4));
  CK(cudaMalloc(&dH, hN*4)); CK(cudaMalloc(&dW2, w2N*4)); CK(cudaMalloc(&db2, b2N*4));
  CK(cudaMalloc(&dY, yN*4));
  CK(cudaMemcpy(dX,  hX.data(),  xN*4,  cudaMemcpyHostToDevice));
  CK(cudaMemcpy(dW1, hW1.data(), w1N*4, cudaMemcpyHostToDevice));
  CK(cudaMemcpy(db1, hb1.data(), b1N*4, cudaMemcpyHostToDevice));
  CK(cudaMemcpy(dW2, hW2.data(), w2N*4, cudaMemcpyHostToDevice));
  CK(cudaMemcpy(db2, hb2.data(), b2N*4, cudaMemcpyHostToDevice));

  cudaEvent_t e0,e1; cudaEventCreate(&e0); cudaEventCreate(&e1);

  auto runForward = [&]() {
    launchMatmul(dX, dW1, dH, B, M, H);
    int blocks = ((B * H) + 255) / 256;
    biasReluKernel<<<blocks, 256>>>(dH, db1, B, H);
    launchMatmul(dH, dW2, dY, B, H, N);
    int blocks2 = ((B * N) + 255) / 256;
    biasKernel<<<blocks2, 256>>>(dY, db2, B, N);
  };

  for (int i = 0; i < warmup; i++) runForward();
  CK(cudaDeviceSynchronize());

  std::vector<double> ks;
  for (int i = 0; i < iters; i++) {
    cudaEventRecord(e0);
    runForward();
    cudaEventRecord(e1);
    cudaEventSynchronize(e1);
    float ms; cudaEventElapsedTime(&ms, e0, e1);
    ks.push_back(ms);
  }

  std::vector<double> es;
  for (int i = 0; i < iters; i++) {
    auto t0 = std::chrono::high_resolution_clock::now();
    CK(cudaMemcpy(dX, hX.data(), xN*4, cudaMemcpyHostToDevice));
    runForward();
    CK(cudaMemcpy(hY.data(), dY, yN*4, cudaMemcpyDeviceToHost));
    auto t1 = std::chrono::high_resolution_clock::now();
    es.push_back(std::chrono::duration<double, std::milli>(t1 - t0).count());
  }

  BenchResult r{"mlp", name, M, H, N, B, median(ks), median(es)};
  RESULTS.push_back(r);

  cudaFree(dX); cudaFree(dW1); cudaFree(db1); cudaFree(dH);
  cudaFree(dW2); cudaFree(db2); cudaFree(dY);
  cudaEventDestroy(e0); cudaEventDestroy(e1);
}

void benchSoftmax(int N, int B, int iters, int warmup) {
  size_t total = (size_t)B * N;
  std::vector<float> hX(total), hY(total);
  for (size_t i = 0; i < total; i++) hX[i] = (float)((i % 100) / 50.0 - 1.0);

  float *dX, *dY;
  CK(cudaMalloc(&dX, total*4)); CK(cudaMalloc(&dY, total*4));
  CK(cudaMemcpy(dX, hX.data(), total*4, cudaMemcpyHostToDevice));

  int threads = std::min(1024, 1 << (32 - __builtin_clz(N - 1)));
  if (threads < 32) threads = 32;
  size_t shmem = threads * sizeof(float);

  cudaEvent_t e0,e1; cudaEventCreate(&e0); cudaEventCreate(&e1);

  for (int i = 0; i < warmup; i++) softmaxRowKernel<<<B, threads, shmem>>>(dX, dY, N);
  CK(cudaDeviceSynchronize());

  std::vector<double> ks;
  for (int i = 0; i < iters; i++) {
    cudaEventRecord(e0);
    softmaxRowKernel<<<B, threads, shmem>>>(dX, dY, N);
    cudaEventRecord(e1);
    cudaEventSynchronize(e1);
    float ms; cudaEventElapsedTime(&ms, e0, e1);
    ks.push_back(ms);
  }
  std::vector<double> es;
  for (int i = 0; i < iters; i++) {
    auto t0 = std::chrono::high_resolution_clock::now();
    CK(cudaMemcpy(dX, hX.data(), total*4, cudaMemcpyHostToDevice));
    softmaxRowKernel<<<B, threads, shmem>>>(dX, dY, N);
    CK(cudaMemcpy(hY.data(), dY, total*4, cudaMemcpyDeviceToHost));
    auto t1 = std::chrono::high_resolution_clock::now();
    es.push_back(std::chrono::duration<double, std::milli>(t1 - t0).count());
  }

  BenchResult r{"softmax", "softmax", 0, 0, N, B, median(ks), median(es)};
  RESULTS.push_back(r);

  cudaFree(dX); cudaFree(dY);
  cudaEventDestroy(e0); cudaEventDestroy(e1);
}

int main() {

  int devId; CK(cudaGetDevice(&devId));
  cudaDeviceProp p; CK(cudaGetDeviceProperties(&p, devId));
  fprintf(stderr, "GPU: %s, SMs=%d, mem=%.1f GB\n",
          p.name, p.multiProcessorCount, p.totalGlobalMem / 1e9);

  const int Bs[] = {1, 8, 32, 128, 512, 2048};

  struct MMC { const char* name; int M; int N; };
  MMC cases[] = {
    {"linear_18x9", 18, 9},
    {"matmul_64", 64, 64},
    {"matmul_256", 256, 256},
    {"matmul_1024", 1024, 1024},
    {"matmul_4096", 4096, 4096},
  };
  for (auto& c : cases) for (int B : Bs) benchMatmul(c.name, c.M, c.N, B, 100, 20);

  struct MLPC { const char* name; int M, H, N; };
  MLPC mlps[] = {
    {"mlp_18_64_9", 18, 64, 9},
    {"mlp_18_256_9", 18, 256, 9},
    {"mlp_512_512_512", 512, 512, 512},
  };
  for (auto& c : mlps) for (int B : Bs) benchMlp(c.name, c.M, c.H, c.N, B, 100, 20);

  for (int N : {9, 64, 256, 1024}) for (int B : Bs) benchSoftmax(N, B, 100, 20);

  // Output JSON
  printf("[\n");
  for (size_t i = 0; i < RESULTS.size(); i++) {
    auto& r = RESULTS[i];
    printf("  {\"kind\":\"%s\",\"case\":\"%s\",\"M\":%d,\"H\":%d,\"N\":%d,\"B\":%d,"
           "\"gpu_kernel_ms\":%.6f,\"gpu_e2e_ms\":%.6f}%s\n",
           r.kind, r.name, r.M, r.H, r.N, r.B, r.gpu_kernel_ms, r.gpu_e2e_ms,
           i + 1 == RESULTS.size() ? "" : ",");
  }
  printf("]\n");

  return 0;
}
