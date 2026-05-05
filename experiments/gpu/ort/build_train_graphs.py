"""Generate train-graph ONNX files for hidden-64 MLP at given (F, H, A).

Two graphs per shape:
  forward_F{F}_H{H}_A{A}.onnx
    inputs:  X[B,F], Wh[F,H], bh[H], Wo[H,A], bo[A]
    outputs: H[B,H], Logits[B,A]
  backward_F{F}_H{H}_A{A}.onnx
    inputs:  X[B,F], H[B,H], Wo[H,A], dLogits[B,A]
    outputs: gWo[H,A], gBo[A], gWh[F,H], gBh[H]

Weights are NOT initializers (they're inputs) so they can be updated in JS
between calls without rebuilding the session.

Math:
  Forward:
    H = relu(X @ Wh + bh)
    Logits = H @ Wo + bo
  Backward (given dLogits):
    gWo = H^T @ dLogits         [H,A]
    gBo = sum_b dLogits          [A]
    dH  = (dLogits @ Wo^T) * (H>0)   [B,H]
    gWh = X^T @ dH               [F,H]
    gBh = sum_b dH               [H]
  These are SUM gradients (not mean) — caller can divide by B if desired.
"""

import sys
import onnx
from onnx import helper, TensorProto


def vi(name, dims):
    return helper.make_tensor_value_info(name, TensorProto.FLOAT, dims)


def build_forward(F, H, A):
    X = vi("X", ["B", F])
    Wh = vi("Wh", [F, H])
    bh = vi("bh", [H])
    Wo = vi("Wo", [H, A])
    bo = vi("bo", [A])
    Hout = vi("H", ["B", H])
    Logits = vi("Logits", ["B", A])
    nodes = [
        helper.make_node("MatMul", ["X", "Wh"], ["XWh"]),
        helper.make_node("Add", ["XWh", "bh"], ["Hpre"]),
        helper.make_node("Relu", ["Hpre"], ["H"]),
        helper.make_node("MatMul", ["H", "Wo"], ["HWo"]),
        helper.make_node("Add", ["HWo", "bo"], ["Logits"]),
    ]
    g = helper.make_graph(nodes, f"fwd_{F}_{H}_{A}", [X, Wh, bh, Wo, bo], [Hout, Logits])
    m = helper.make_model(g, opset_imports=[helper.make_opsetid("", 17)])
    m.ir_version = 9
    onnx.checker.check_model(m)
    return m


def build_backward(F, H, A):
    X = vi("X", ["B", F])
    Hin = vi("H", ["B", H])
    Wo = vi("Wo", [H, A])
    dLogits = vi("dLogits", ["B", A])
    gWo = vi("gWo", [H, A])
    gBo = vi("gBo", [A])
    gWh = vi("gWh", [F, H])
    gBh = vi("gBh", [H])
    # Constants for ReduceSum axes
    axes0 = helper.make_tensor("axes0", TensorProto.INT64, [1], [0])
    nodes = [
        # gWo = H^T @ dLogits
        helper.make_node("Transpose", ["H"], ["Ht"], perm=[1, 0]),
        helper.make_node("MatMul", ["Ht", "dLogits"], ["gWo"]),
        # gBo = sum over batch axis 0
        helper.make_node("ReduceSum", ["dLogits", "axes0"], ["gBo"], keepdims=0),
        # dH_pre = dLogits @ Wo^T
        helper.make_node("Transpose", ["Wo"], ["Wot"], perm=[1, 0]),
        helper.make_node("MatMul", ["dLogits", "Wot"], ["dHpre"]),
        # mask by H>0
        helper.make_node("Sign", ["H"], ["sgnH"]),                 # 0/1 since relu output >=0
        helper.make_node("Mul", ["dHpre", "sgnH"], ["dH"]),
        # gWh = X^T @ dH
        helper.make_node("Transpose", ["X"], ["Xt"], perm=[1, 0]),
        helper.make_node("MatMul", ["Xt", "dH"], ["gWh"]),
        # gBh = sum over batch axis 0
        helper.make_node("ReduceSum", ["dH", "axes0"], ["gBh"], keepdims=0),
    ]
    g = helper.make_graph(
        nodes, f"bwd_{F}_{H}_{A}",
        [X, Hin, Wo, dLogits],
        [gWo, gBo, gWh, gBh],
        initializer=[axes0],
    )
    m = helper.make_model(g, opset_imports=[helper.make_opsetid("", 17)])
    m.ir_version = 9
    onnx.checker.check_model(m)
    return m


def emit(F, H, A, out_dir):
    fwd = build_forward(F, H, A)
    bwd = build_backward(F, H, A)
    fp = f"{out_dir}/forward_F{F}_H{H}_A{A}.onnx"
    bp = f"{out_dir}/backward_F{F}_H{H}_A{A}.onnx"
    onnx.save(fwd, fp)
    onnx.save(bwd, bp)
    print(f"wrote {fp} and {bp}")


if __name__ == "__main__":
    out_dir = sys.argv[1] if len(sys.argv) > 1 else "."
    # DQN/PPO move and aim heads use FEATURE_COUNT (varies); shapes we need:
    # We don't know F at build time without grepping; emit for the common ones
    # that the trainers actually use. Override via CLI: F H A repeated.
    extra = sys.argv[2:]
    shapes = []
    if extra:
        assert len(extra) % 3 == 0
        for i in range(0, len(extra), 3):
            shapes.append(tuple(int(x) for x in extra[i:i + 3]))
    else:
        # Sensible defaults; trainer wires real F at runtime and we ship matching files.
        shapes = [
            (18, 64, 9),    # placeholder
        ]
    for F, H, A in shapes:
        emit(F, H, A, out_dir)
