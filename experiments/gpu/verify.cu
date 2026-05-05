// Numerical equivalence: compute Y = X * W^T on GPU, write X, W, Y to disk;
// CPU side reads them and recomputes Y, reports max abs diff.
#include <cstdio>
#include <vector>
#include <cuda_runtime.h>

#define CK(x) do { cudaError_t e=(x); if(e){fprintf(stderr,"%s\n",cudaGetErrorString(e));return 1;} } while(0)

template<int TILE>
__global__ void matmulXWT(const float* X, const float* W, float* Y, int B, int M, int N) {
  __shared__ float sX[TILE][TILE]; __shared__ float sW[TILE][TILE];
  int row = blockIdx.y*TILE + threadIdx.y;
  int col = blockIdx.x*TILE + threadIdx.x;
  float acc = 0.f;
  int tiles = (M+TILE-1)/TILE;
  for(int t=0;t<tiles;t++){
    int xc = t*TILE+threadIdx.x;
    sX[threadIdx.y][threadIdx.x] = (row<B && xc<M)? X[row*M+xc]:0.f;
    int wRow = blockIdx.x*TILE + threadIdx.x;
    int wCol = t*TILE + threadIdx.y;
    sW[threadIdx.y][threadIdx.x] = (wRow<N && wCol<M)? W[wRow*M+wCol]:0.f;
    __syncthreads();
    #pragma unroll
    for(int k=0;k<TILE;k++) acc += sX[threadIdx.y][k]*sW[k][threadIdx.x];
    __syncthreads();
  }
  if(row<B && col<N) Y[row*N+col] = acc;
}

int main() {
  struct C { int B,M,N; }; C cases[] = {{128,18,9},{32,256,256},{8,512,512}};
  FILE* f = fopen("verify_data.bin", "wb");
  int nc = (int)(sizeof(cases)/sizeof(cases[0]));
  fwrite(&nc, sizeof(int), 1, f);
  for (auto& c : cases) {
    std::vector<float> hX(c.B*c.M), hW(c.N*c.M), hY(c.B*c.N);
    for (size_t i=0;i<hX.size();i++) hX[i] = (float)((i*1664525+1013904223u)%1000)/500.f - 1.f;
    for (size_t i=0;i<hW.size();i++) hW[i] = (float)((i*22695477+1u)%1000)/500.f - 1.f;
    float *dX,*dW,*dY;
    cudaMalloc(&dX,hX.size()*4); cudaMalloc(&dW,hW.size()*4); cudaMalloc(&dY,hY.size()*4);
    cudaMemcpy(dX,hX.data(),hX.size()*4,cudaMemcpyHostToDevice);
    cudaMemcpy(dW,hW.data(),hW.size()*4,cudaMemcpyHostToDevice);
    dim3 block(16,16); dim3 grid((c.N+15)/16,(c.B+15)/16);
    matmulXWT<16><<<grid,block>>>(dX,dW,dY,c.B,c.M,c.N);
    cudaMemcpy(hY.data(),dY,hY.size()*4,cudaMemcpyDeviceToHost);
    fwrite(&c.B,sizeof(int),1,f); fwrite(&c.M,sizeof(int),1,f); fwrite(&c.N,sizeof(int),1,f);
    fwrite(hX.data(),4,hX.size(),f);
    fwrite(hW.data(),4,hW.size(),f);
    fwrite(hY.data(),4,hY.size(),f);
    cudaFree(dX); cudaFree(dW); cudaFree(dY);
  }
  fclose(f);
  printf("wrote verify_data.bin\n");
  return 0;
}
