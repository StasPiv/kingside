"""KS-3091 v3 follow-up: экспорт foundation-checkpoint в 13-классовый ONNX.

train_foundation.py сохраняет 3-головую модель (head_occ + head_color +
head_piece). Inference-пайплайн в `board_recognize.py` ожидает один выход
(N, 13) — `[empty, wK, wQ, wR, wB, wN, wP, bK, bQ, bR, bB, bN, bP]`.

Здесь оборачиваем модель в `CompatWrapper` который:
  1. Считает softmax по каждой голове.
  2. p_empty = p_occ[..., 0].
  3. Для не-пустых: p_piece_color = p_occ[..., 1] * p_color[..., color]
                                  * p_piece[..., piece]
  4. log(p) → выходные "логиты" (downstream softmax возвращает те же p).

Использование:
    python -m training.export_foundation \\
        --checkpoint /tmp/v0.9.6/best.pt \\
        --output     /tmp/v0.9.6/classifier.onnx \\
        --cell-size  64
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path


def _build_compat_wrapper(state_dict):
    import torch
    from torch import nn
    from torchvision.models import resnet18

    backbone = resnet18(weights=None)
    feat_dim = backbone.fc.in_features
    backbone.fc = nn.Identity()

    class FoundationHead(nn.Module):
        def __init__(self):
            super().__init__()
            self.backbone = backbone
            self.dropout = nn.Dropout(0.0)
            self.head_occ = nn.Linear(feat_dim, 2)
            self.head_color = nn.Linear(feat_dim, 2)
            self.head_piece = nn.Linear(feat_dim, 6)

        def forward(self, x):
            f = self.dropout(self.backbone(x))
            return self.head_occ(f), self.head_color(f), self.head_piece(f)

    model = FoundationHead()
    model.load_state_dict(state_dict, strict=True)
    model.eval()

    class CompatWrapper(nn.Module):
        """Возвращает (N, 13) лог-вероятности в порядке LABELS.

        LABELS = [empty, wK, wQ, wR, wB, wN, wP, bK, bQ, bR, bB, bN, bP]
        index = 0                  → empty
        index = 1 + color*6 + piece → не-пустые (color: 0=white, 1=black;
                                       piece: 0=K..5=P)
        """
        def __init__(self, inner: nn.Module):
            super().__init__()
            self.inner = inner

        def forward(self, x):
            logits_occ, logits_color, logits_piece = self.inner(x)
            p_occ = torch.softmax(logits_occ, dim=-1)        # (N, 2)
            p_col = torch.softmax(logits_color, dim=-1)      # (N, 2)
            p_pc = torch.softmax(logits_piece, dim=-1)       # (N, 6)

            # Расширяем до (N, 12) для всех combination'ов color×piece.
            # color=0 (white) даёт индексы 0..5 → wK..wP
            # color=1 (black) даёт индексы 6..11 → bK..bP
            # combined[n, color*6 + piece] = p_col[n, color] * p_pc[n, piece]
            combined = (p_col[:, :, None] * p_pc[:, None, :])  # (N, 2, 6)
            combined = combined.reshape(combined.size(0), 12)   # (N, 12)
            # Шкалируем не-пустые на p_occ[:, 1].
            p_occ_nonempty = p_occ[:, 1:2]                      # (N, 1)
            p_pieces = combined * p_occ_nonempty                # (N, 12)

            # Собираем 13-классовый вектор: [empty, w*6, b*6]
            p_empty = p_occ[:, 0:1]                              # (N, 1)
            p13 = torch.cat([p_empty, p_pieces], dim=1)          # (N, 13)
            # log-вероятности — downstream softmax вернёт ту же p13.
            # Маленький eps на случай нулей.
            return torch.log(p13.clamp(min=1e-12))

    return CompatWrapper(model)


def export_checkpoint(checkpoint: Path, output: Path,
                      cell_size: int = 64, opset: int = 17,
                      dynamic_batch: bool = True) -> Path:
    import torch

    output.parent.mkdir(parents=True, exist_ok=True)
    ckpt = torch.load(checkpoint, map_location="cpu")
    state = ckpt["model"] if "model" in ckpt else ckpt["state_dict"]

    wrapper = _build_compat_wrapper(state)

    sample = torch.randn(1, 3, cell_size, cell_size)
    dynamic_axes = {"input": {0: "batch"}, "logits": {0: "batch"}} \
        if dynamic_batch else None

    torch.onnx.export(
        wrapper, sample, str(output),
        input_names=["input"], output_names=["logits"],
        opset_version=opset, dynamic_axes=dynamic_axes,
        do_constant_folding=True,
    )

    try:
        import onnx
        onnx_model = onnx.load(str(output))
        onnx.checker.check_model(onnx_model)
    except ImportError:
        print("[onnx] warning: `onnx` not installed, skipping checker.",
              file=sys.stderr)
    return output


def parse_args(argv=None):
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--checkpoint", required=True, type=Path)
    p.add_argument("--output", required=True, type=Path)
    p.add_argument("--cell-size", type=int, default=64)
    p.add_argument("--opset", type=int, default=17)
    return p.parse_args(argv)


def main(argv=None) -> int:
    args = parse_args(argv)
    path = export_checkpoint(checkpoint=args.checkpoint, output=args.output,
                             cell_size=args.cell_size, opset=args.opset)
    size_mb = path.stat().st_size / (1024 * 1024)
    print(f"[onnx] wrote {path} ({size_mb:.2f} MiB)", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
