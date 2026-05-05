// CUDA helper for batched MLP forward + SGD backward pass.
// Long-running stdio bridge: reads minibatches from stdin, writes updated
// weights and loss to stdout. Network shape: F -> H (ReLU) -> A (linear).
//
// Build: nvcc -O3 mlp_train.cu -o mlp_train
//
// Wire format (little-endian):
//   In:  [u32 magic=0x4d4c3130][u32 op][u32 B][u32 F][u32 H][u32 A]
//        f32 W1[H*F], b1[H], W2[A*H], b2[A], X[B*F], dLogits[B*A], lr
//   Out: [u32 magic=0x4d4c3131][u32 B][u32 F][u32 H][u32 A]
//        f32 W1[H*F], b1[H], W2[A*H], b2[A], lossSum

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cstdint>
#include <cuda_runtime.h>
#include <unistd.h>

#define CK(x) do { cudaError_t e = (x); if (e != cudaSuccess) { \
  fprintf(stderr, "CUDA %s at %d\n", cudaGetErrorString(e), __LINE__); exit(1); } } while(0)

// Y[B,H] = ReLU(X[B,F] @ W1[H,F]^T + b1[H])
__global__ void fwdHidden(const float* X, const float* W1, const float* b1,
                          float* H_out, int B, int F, int H) {
  int s = blockIdx.x;             // batch index
  int i = blockIdx.y * blockDim.x + threadIdx.x; // hidden unit
  if (i >= H || s >= B) return;
  const float* xrow = X + s * F;
  const float* wrow = W1 + i * F;
  float acc = b1[i];
  for (int j = 0; j < F; j++) acc += xrow[j] * wrow[j];
  H_out[s * H + i] = acc > 0.0f ? acc : 0.0f;
}

// L[B,A] = Hh[B,H] @ W2[A,H]^T + b2[A]
__global__ void fwdOutput(const float* Hh, const float* W2, const float* b2,
                          float* L, int B, int H, int A) {
  int s = blockIdx.x;
  int a = blockIdx.y * blockDim.x + threadIdx.x;
  if (a >= A || s >= B) return;
  const float* hrow = Hh + s * H;
  const float* wrow = W2 + a * H;
  float acc = b2[a];
  for (int i = 0; i < H; i++) acc += hrow[i] * wrow[i];
  L[s * A + a] = acc;
}

// dHidden[B,H] = dLogits[B,A] @ W2[A,H], gated by ReLU mask (Hh > 0)
__global__ void backHidden(const float* dLogits, const float* W2,
                           const float* Hh, float* dHidden,
                           int B, int H, int A) {
  int s = blockIdx.x;
  int i = blockIdx.y * blockDim.x + threadIdx.x;
  if (i >= H || s >= B) return;
  if (Hh[s * H + i] <= 0.0f) { dHidden[s * H + i] = 0.0f; return; }
  const float* drow = dLogits + s * A;
  float acc = 0.0f;
  for (int a = 0; a < A; a++) acc += drow[a] * W2[a * H + i];
  dHidden[s * H + i] = acc;
}

// Atomic accumulators for weight gradients (B is small enough this is fine).
__global__ void accumW2(const float* dLogits, const float* Hh,
                        float* gW2, float* gB2,
                        int B, int H, int A) {
  int a = blockIdx.x * blockDim.x + threadIdx.x;
  if (a >= A) return;
  float gb = 0.0f;
  for (int s = 0; s < B; s++) {
    float dl = dLogits[s * A + a];
    gb += dl;
    for (int i = 0; i < H; i++) {
      atomicAdd(&gW2[a * H + i], dl * Hh[s * H + i]);
    }
  }
  gB2[a] = gb;
}

__global__ void accumW1(const float* dHidden, const float* X,
                        float* gW1, float* gB1,
                        int B, int F, int H) {
  int i = blockIdx.x * blockDim.x + threadIdx.x;
  if (i >= H) return;
  float gb = 0.0f;
  for (int s = 0; s < B; s++) {
    float dh = dHidden[s * H + i];
    gb += dh;
    for (int j = 0; j < F; j++) {
      atomicAdd(&gW1[i * F + j], dh * X[s * F + j]);
    }
  }
  gB1[i] = gb;
}

__global__ void sgdStep(float* W, const float* g, float lr, int N) {
  int i = blockIdx.x * blockDim.x + threadIdx.x;
  if (i < N) W[i] -= lr * g[i];
}

__global__ void mseLoss(const float* dLogits, float* lossOut, int B, int A) {
  // For DQN the dLogit has only one nonzero per row; for PPO it's policy
  // gradient (no MSE meaning). Just sum |dLogits|^2 as a proxy.
  int s = blockIdx.x * blockDim.x + threadIdx.x;
  if (s >= B) return;
  float acc = 0.0f;
  for (int a = 0; a < A; a++) { float d = dLogits[s * A + a]; acc += d * d; }
  atomicAdd(lossOut, acc);
}

static bool readExact(int fd, void* buf, size_t n) {
  size_t got = 0;
  while (got < n) {
    ssize_t r = read(fd, (char*)buf + got, n - got);
    if (r <= 0) return false;
    got += (size_t)r;
  }
  return true;
}

static bool writeExact(int fd, const void* buf, size_t n) {
  size_t put = 0;
  while (put < n) {
    ssize_t r = write(fd, (const char*)buf + put, n - put);
    if (r <= 0) return false;
    put += (size_t)r;
  }
  return true;
}

int main() {
  setvbuf(stdout, NULL, _IONBF, 0);

  // Allocate generous device scratch.
  size_t scratchBytes = 64 * 1024 * 1024;
  float *dW1=nullptr, *dB1=nullptr, *dW2=nullptr, *dB2=nullptr;
  float *dX=nullptr, *dDL=nullptr, *dHh=nullptr, *dL=nullptr;
  float *dDH=nullptr, *dGW1=nullptr, *dGB1=nullptr, *dGW2=nullptr, *dGB2=nullptr;
  float *dLoss=nullptr;
  CK(cudaMalloc(&dW1, scratchBytes));
  CK(cudaMalloc(&dB1, 1<<20));
  CK(cudaMalloc(&dW2, scratchBytes));
  CK(cudaMalloc(&dB2, 1<<20));
  CK(cudaMalloc(&dX, scratchBytes));
  CK(cudaMalloc(&dDL, scratchBytes));
  CK(cudaMalloc(&dHh, scratchBytes));
  CK(cudaMalloc(&dL, scratchBytes));
  CK(cudaMalloc(&dDH, scratchBytes));
  CK(cudaMalloc(&dGW1, scratchBytes));
  CK(cudaMalloc(&dGB1, 1<<20));
  CK(cudaMalloc(&dGW2, scratchBytes));
  CK(cudaMalloc(&dGB2, 1<<20));
  CK(cudaMalloc(&dLoss, sizeof(float)));

  uint32_t header[6];
  while (true) {
    if (!readExact(0, header, sizeof(header))) break;
    if (header[0] != 0x4d4c3130u) { fprintf(stderr, "bad magic\n"); return 1; }
    uint32_t B = header[2], F = header[3], H = header[4], A = header[5];

    size_t W1n = (size_t)H * F, B1n = H;
    size_t W2n = (size_t)A * H, B2n = A;
    size_t Xn = (size_t)B * F, DLn = (size_t)B * A;

    static float buf[1 << 22];
    auto readF = [&](size_t n, float* dst) {
      if (n * 4 > sizeof(buf)) { fprintf(stderr, "too big\n"); exit(1); }
      if (!readExact(0, buf, n * 4)) exit(1);
      CK(cudaMemcpy(dst, buf, n * 4, cudaMemcpyHostToDevice));
    };
    readF(W1n, dW1);
    readF(B1n, dB1);
    readF(W2n, dW2);
    readF(B2n, dB2);
    readF(Xn,  dX);
    readF(DLn, dDL);
    float lr;
    if (!readExact(0, &lr, 4)) exit(1);

    // forward hidden
    {
      dim3 grid(B, (H + 31) / 32);
      fwdHidden<<<grid, 32>>>(dX, dW1, dB1, dHh, B, F, H);
    }
    // forward output (not strictly needed; dLogits already provided by caller)
    {
      dim3 grid(B, (A + 31) / 32);
      fwdOutput<<<grid, 32>>>(dHh, dW2, dB2, dL, B, H, A);
    }
    // dHidden
    {
      dim3 grid(B, (H + 31) / 32);
      backHidden<<<grid, 32>>>(dDL, dW2, dHh, dDH, B, H, A);
    }
    // grad accumulators
    CK(cudaMemset(dGW1, 0, W1n * 4));
    CK(cudaMemset(dGW2, 0, W2n * 4));
    accumW2<<<(A + 31)/32, 32>>>(dDL, dHh, dGW2, dGB2, B, H, A);
    accumW1<<<(H + 31)/32, 32>>>(dDH, dX, dGW1, dGB1, B, F, H);
    // SGD step
    sgdStep<<<((int)W1n + 255)/256, 256>>>(dW1, dGW1, lr, (int)W1n);
    sgdStep<<<((int)B1n + 255)/256, 256>>>(dB1, dGB1, lr, (int)B1n);
    sgdStep<<<((int)W2n + 255)/256, 256>>>(dW2, dGW2, lr, (int)W2n);
    sgdStep<<<((int)B2n + 255)/256, 256>>>(dB2, dGB2, lr, (int)B2n);
    // loss
    CK(cudaMemset(dLoss, 0, 4));
    mseLoss<<<(B + 63)/64, 64>>>(dDL, dLoss, B, A);
    CK(cudaDeviceSynchronize());

    // Send back
    uint32_t outHdr[5] = { 0x4d4c3131u, B, F, H, A };
    if (!writeExact(1, outHdr, sizeof(outHdr))) return 1;
    auto writeF = [&](size_t n, float* src) {
      CK(cudaMemcpy(buf, src, n * 4, cudaMemcpyDeviceToHost));
      if (!writeExact(1, buf, n * 4)) exit(1);
    };
    writeF(W1n, dW1);
    writeF(B1n, dB1);
    writeF(W2n, dW2);
    writeF(B2n, dB2);
    float loss;
    CK(cudaMemcpy(&loss, dLoss, 4, cudaMemcpyDeviceToHost));
    if (!writeExact(1, &loss, 4)) return 1;
  }
  return 0;
}
