"""Generate forward-only ONNX MLP: F=18 -> hidden=64 ReLU -> A=9.
Weights are initializers (not inputs) so they live with the session.
We export the model with deterministic-zero initializers; we'll overwrite
initializer values on the JS side at session-construction time, OR we accept
that this graph is a benchmark-only graph (forward correctness uses the
exact same initializer values as the JS-side mirror)."""

import numpy as np
import onnx
from onnx import helper, TensorProto, numpy_helper

F = 18
HIDDEN = 64
A = 9

def make_model(seed=42):
    rng = np.random.default_rng(seed)
    # match createHidden init scheme roughly: small uniform
    Wh = (rng.random((F, HIDDEN), dtype=np.float32) * 2 - 1) * 0.1
    bh = np.zeros((HIDDEN,), dtype=np.float32)
    Wout = np.full((HIDDEN, A), 0.01, dtype=np.float32)
    bout = np.full((A,), 0.01, dtype=np.float32)

    Wh_init = numpy_helper.from_array(Wh, name="Wh")
    bh_init = numpy_helper.from_array(bh, name="bh")
    Wout_init = numpy_helper.from_array(Wout, name="Wout")
    bout_init = numpy_helper.from_array(bout, name="bout")

    X = helper.make_tensor_value_info("X", TensorProto.FLOAT, ["B", F])
    Logits = helper.make_tensor_value_info("Logits", TensorProto.FLOAT, ["B", A])

    n1 = helper.make_node("MatMul", ["X", "Wh"], ["XWh"])
    n2 = helper.make_node("Add", ["XWh", "bh"], ["H_pre"])
    n3 = helper.make_node("Relu", ["H_pre"], ["H"])
    n4 = helper.make_node("MatMul", ["H", "Wout"], ["HWout"])
    n5 = helper.make_node("Add", ["HWout", "bout"], ["Logits"])

    graph = helper.make_graph(
        [n1, n2, n3, n4, n5], "mlp_forward", [X], [Logits],
        initializer=[Wh_init, bh_init, Wout_init, bout_init],
    )
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 17)])
    model.ir_version = 9
    onnx.checker.check_model(model)
    return model, (Wh, bh, Wout, bout)

if __name__ == "__main__":
    import sys
    out_path = sys.argv[1] if len(sys.argv) > 1 else "mlp_forward.onnx"
    model, weights = make_model(42)
    onnx.save(model, out_path)
    Wh, bh, Wout, bout = weights
    # also save a npz mirror so JS can replicate exactly for correctness check
    np.savez(out_path + ".weights.npz", Wh=Wh, bh=bh, Wout=Wout, bout=bout)
    with open(out_path + ".weights.bin", "wb") as f:
        # layout: Wh (F*HIDDEN), bh (HIDDEN), Wout (HIDDEN*A), bout (A)  all float32
        Wh.astype(np.float32).tofile(f)
        bh.astype(np.float32).tofile(f)
        Wout.astype(np.float32).tofile(f)
        bout.astype(np.float32).tofile(f)
    print(f"wrote {out_path}")
