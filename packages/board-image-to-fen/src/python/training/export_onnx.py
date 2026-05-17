"""Export a trained board-recog checkpoint to ONNX (KS-2361, ADR-040 Stage 2).

Two usage modes:

1. Standalone CLI:

       python -m training.export_onnx \\
           --checkpoint runs/v1.0.0/best.pt \\
           --output     runs/v1.0.0/model.onnx \\
           --opset 17

2. Library mode (called from train.py when ``--export-onnx`` is set):

       from training.export_onnx import export_checkpoint
       export_checkpoint(checkpoint=Path("best.pt"), output=Path("model.onnx"))

The exported graph has a single input ``input`` (Nx3xHxW float32, normalized
with ImageNet stats) and a single output ``logits`` (Nx13 float32). The batch
dimension is dynamic so the model can be batched per-board (64 cells/board).

Optionally INT8-quantizes the exported model when ``--quantize int8`` is
passed; this halves the file size on disk and is required to fit the ADR-040
≤1 MB budget at ``width_mult=1.0``.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Optional


def export_checkpoint(
    checkpoint: Path,
    output: Path,
    width_mult: Optional[float] = None,
    cell_size: int = 64,
    opset: int = 17,
    dynamic_batch: bool = True,
) -> Path:
    """Load ``checkpoint`` and emit an ONNX file at ``output``.

    Parameters
    ----------
    checkpoint
        Path to a ``.pt`` file saved by ``training.train``.
    output
        Path to the ONNX file to create. Parent dirs are created.
    width_mult
        Overrides the value stored in the checkpoint's ``args.width_mult``.
    cell_size
        Spatial size of the dummy export input.
    opset
        ONNX opset version. 17 is widely supported by onnxruntime ≥ 1.16.
    dynamic_batch
        Mark the batch dimension as dynamic (recommended — board inference
        runs 64 cells at a time).
    """
    import torch

    from .model import build_model, dummy_input

    output.parent.mkdir(parents=True, exist_ok=True)

    ckpt = torch.load(checkpoint, map_location="cpu")
    train_args = ckpt.get("args", {}) or {}
    wm = width_mult if width_mult is not None else train_args.get("width_mult", 1.0)

    model = build_model(width_mult=float(wm), pretrained=False)
    model.load_state_dict(ckpt["model_state"])
    model.eval()

    sample = dummy_input(batch_size=1, cell_size=cell_size)

    dynamic_axes = {"input": {0: "batch"}, "logits": {0: "batch"}} if dynamic_batch else None

    torch.onnx.export(
        model,
        sample,
        str(output),
        input_names=["input"],
        output_names=["logits"],
        opset_version=opset,
        dynamic_axes=dynamic_axes,
        do_constant_folding=True,
    )

    # Lightweight sanity check — make sure the file actually loads.
    try:
        import onnx

        onnx_model = onnx.load(str(output))
        onnx.checker.check_model(onnx_model)
    except ImportError:
        print(
            "[onnx] warning: `onnx` not installed, skipping checker. "
            "Install it to validate the exported graph.",
            file=sys.stderr,
        )

    return output


def quantize_int8(input_onnx: Path, output: Path) -> Path:
    """Apply dynamic-range INT8 quantization to ``input_onnx``.

    Saves the quantized model to ``output``. Quantization is required to hit
    the ≤1 MB ONNX budget when training at ``width_mult=1.0``.
    """
    from onnxruntime.quantization import QuantType, quantize_dynamic

    output.parent.mkdir(parents=True, exist_ok=True)
    quantize_dynamic(
        model_input=str(input_onnx),
        model_output=str(output),
        weight_type=QuantType.QInt8,
    )
    return output


def parse_args(argv=None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--checkpoint", required=True, type=Path)
    p.add_argument("--output", required=True, type=Path)
    p.add_argument(
        "--width-mult", type=float, default=None,
        help="Override the value stored in the checkpoint.",
    )
    p.add_argument("--cell-size", type=int, default=64)
    p.add_argument("--opset", type=int, default=17)
    p.add_argument(
        "--quantize", choices=("none", "int8"), default="none",
        help="Apply post-export quantization. 'int8' ≈ halves model size.",
    )
    p.add_argument(
        "--quantized-output", type=Path, default=None,
        help="Override path for the int8 file. Default: <output>.int8.onnx.",
    )
    return p.parse_args(argv)


def main(argv=None) -> int:
    args = parse_args(argv)
    fp32_path = export_checkpoint(
        checkpoint=args.checkpoint,
        output=args.output,
        width_mult=args.width_mult,
        cell_size=args.cell_size,
        opset=args.opset,
    )

    size_mb = fp32_path.stat().st_size / (1024 * 1024)
    print(f"[onnx] wrote {fp32_path} ({size_mb:.2f} MiB)", file=sys.stderr)

    if args.quantize == "int8":
        q_path = args.quantized_output or fp32_path.with_suffix(".int8.onnx")
        quantize_int8(fp32_path, q_path)
        q_size_mb = q_path.stat().st_size / (1024 * 1024)
        print(f"[onnx] int8 quantized → {q_path} ({q_size_mb:.2f} MiB)",
              file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
