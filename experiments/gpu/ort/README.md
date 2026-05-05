# onnxruntime-node experiment

Forward-only MLP (F=18 -> H=64 ReLU -> A=9) via onnxruntime-node, comparing
CPU EP and CUDA EP to the JS forward.

## Files
- `build_model.py` — builds `mlp_forward.onnx` + `.weights.bin` mirror.
- `bench.mjs` — benchmark + correctness check.
- `mlp_forward.onnx` — generated graph with weights as initializers.
- `bench_results.txt` — last run output.

## Reproduce
```
python3 build_model.py mlp_forward.onnx
LD_LIBRARY_PATH=/coding/rust/.libtorch/libtorch/lib node bench.mjs
```

## Result on this WSL2 box (RTX 2080 SUPER, system CUDA 12.0, ORT 1.25.1)

CUDA EP **failed to initialize**. cuDNN 9 had to be added to LD_LIBRARY_PATH
(borrowed from libtorch). After that, ORT reaches `cudaSetDevice` and aborts
with `CUDA failure 100: no CUDA-capable device is detected`, even though a
plain CUDA program (and the existing `mlp_train.cu` stdio bridge) runs fine
in the same shell. The most likely cause is that ORT 1.25.1 was built against
CUDA 12.8/cuDNN 9, but the system `libcudart.so.12` is 12.0.146; substituting
libtorch's cudart-12.x did not help. Bringing this up would require either:
  - upgrading WSL2 to system CUDA 12.8+ (apt nvidia-cuda-toolkit-12-8) and
    matching cuDNN 9.x, or
  - downgrading ORT to a build that targets CUDA 12.0, or
  - using the WebGPU EP (ORT 1.25 ships it bundled) instead of CUDA.

ORT-CPU works fine and is dramatically faster than the JS forward.
