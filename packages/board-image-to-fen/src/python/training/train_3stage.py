"""KS-3091 v3: трёх-этапная модель для board-recog.

3 задачи на одной модели (multi-task head):
1. occupancy (бинарка): пустая клетка vs не-пустая.
2. color (бинарка): белая фигура vs чёрная (только для не-пустых).
3. piece_type (6 классов): K/Q/R/B/N/P (только для не-пустых).

Архитектура: MobileNetV3-Small backbone + 3 параллельных FC-head:
  - head_occ: 2 logits.
  - head_color: 2 logits.
  - head_piece: 6 logits.

Inference: forward → если occ=empty, клетка пустая. Иначе color + piece_type
складываются в wK..bP.

Loss: суммарный CE(occ) + CE(color)*mask_occupied + CE(piece)*mask_occupied.
mask_occupied — маска по batch'у, где True если фактически не-empty.

Использование:
    python -m training.train_3stage \
      --data-dir /project/packages/board-image-to-fen/data/v2 \
      --output /tmp/v0.9.3 \
      --epochs 10 --batch-size 256 --width-mult 0.5
"""
from __future__ import annotations

import argparse
import json
import math
import sys
import time
from pathlib import Path
from typing import Any, Dict


# Маппинг: индекс LABELS (0..12) → (occ, color, piece)
# 0 empty → (0, ignore, ignore)
# 1..6 (wK..wP) → (1, 0, 0..5)
# 7..12 (bK..bP) → (1, 1, 0..5)
def decode_label_index(label_idx: int):
    if label_idx == 0:
        return 0, -1, -1   # empty, color/piece ignored
    color = 0 if 1 <= label_idx <= 6 else 1
    piece = (label_idx - 1) % 6      # 0=K, 1=Q, 2=R, 3=B, 4=N, 5=P
    return 1, color, piece


def encode_class(occ: int, color: int, piece: int) -> int:
    """(occ, color, piece) → label_idx 0..12."""
    if occ == 0:
        return 0
    return 1 + color * 6 + piece


def _build_model(width_mult: float):
    import torch
    from torch import nn
    from torchvision.models.mobilenetv3 import _mobilenet_v3_conf, MobileNetV3
    inverted, last_ch = _mobilenet_v3_conf("mobilenet_v3_small", width_mult=width_mult)
    backbone = MobileNetV3(inverted, last_ch, num_classes=1, dropout=0.2)
    backbone.classifier = nn.Identity()

    # Определяем feat_dim фактическим прогоном (in_features ссылается на
    # уже удалённый classifier, нужно замерить выход backbone).
    backbone.eval()
    with torch.no_grad():
        dummy = torch.randn(1, 3, 64, 64)
        feat_dim = backbone(dummy).shape[-1]

    class ThreeHeadModel(nn.Module):
        def __init__(self, backbone, feat_dim):
            super().__init__()
            self.backbone = backbone
            self.head_occ = nn.Linear(feat_dim, 2)
            self.head_color = nn.Linear(feat_dim, 2)
            self.head_piece = nn.Linear(feat_dim, 6)

        def forward(self, x):
            f = self.backbone(x)
            return self.head_occ(f), self.head_color(f), self.head_piece(f)

    return ThreeHeadModel(backbone, feat_dim)


def parse_args(argv=None):
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--data-dir", required=True, type=Path)
    p.add_argument("--output", required=True, type=Path)
    p.add_argument("--epochs", type=int, default=10)
    p.add_argument("--batch-size", type=int, default=256)
    p.add_argument("--lr", type=float, default=1e-3)
    p.add_argument("--weight-decay", type=float, default=1e-4)
    p.add_argument("--num-workers", type=int, default=0)
    p.add_argument("--width-mult", type=float, default=0.5)
    p.add_argument("--cell-size", type=int, default=64)
    p.add_argument("--max-train-batches", type=int, default=0)
    p.add_argument("--max-val-batches", type=int, default=0)
    p.add_argument("--seed", type=int, default=3093)
    p.add_argument("--device", default=None)
    return p.parse_args(argv)


def _run_epoch(model, loader, criterion, optimizer, device, train: bool, max_batches: int = 0):
    import torch
    model.train(train)
    sum_loss = sum_occ_correct = sum_color_correct = sum_piece_correct = 0.0
    n_total = n_occupied = 0
    ctx = torch.enable_grad() if train else torch.no_grad()
    batches_done = 0
    with ctx:
        for batch in loader:
            if max_batches and batches_done >= max_batches:
                break
            batches_done += 1
            images = batch["image"].to(device)
            labels = batch["label"].to(device)

            # decode labels → occ, color, piece
            occ = (labels > 0).long()                          # 0/1
            piece_color_idx = (labels - 1).clamp(min=0)         # for non-empty: 0..11
            color = (piece_color_idx // 6).clamp(min=0)         # 0=white, 1=black
            piece = (piece_color_idx % 6)                       # 0..5

            logits_occ, logits_color, logits_piece = model(images)

            loss_occ = criterion(logits_occ, occ)
            mask = occ.bool()
            # для color/piece считаем loss только на не-пустых
            if mask.any():
                loss_color = criterion(logits_color[mask], color[mask])
                loss_piece = criterion(logits_piece[mask], piece[mask])
            else:
                loss_color = torch.tensor(0.0, device=device)
                loss_piece = torch.tensor(0.0, device=device)

            loss = loss_occ + loss_color + loss_piece

            if train:
                optimizer.zero_grad(set_to_none=True)
                loss.backward()
                optimizer.step()

            bs = labels.size(0)
            n_total += bs
            n_occupied += int(mask.sum().item())
            sum_loss += float(loss.item()) * bs
            sum_occ_correct += int((logits_occ.argmax(1) == occ).sum().item())
            if mask.any():
                sum_color_correct += int((logits_color[mask].argmax(1) == color[mask]).sum().item())
                sum_piece_correct += int((logits_piece[mask].argmax(1) == piece[mask]).sum().item())

    if n_total == 0:
        return {"loss": float("nan"), "occ_acc": float("nan"),
                "color_acc": float("nan"), "piece_acc": float("nan"),
                "combined_acc": float("nan")}
    color_acc = sum_color_correct / n_occupied if n_occupied else 0.0
    piece_acc = sum_piece_correct / n_occupied if n_occupied else 0.0
    occ_acc = sum_occ_correct / n_total
    # Комбинированная accuracy: клетка правильна, если правильны все 3 предсказания.
    # (Для пустой — только occ. Для не-пустой — occ+color+piece.)
    # Приближённо: occ_acc * (color_acc * piece_acc когда occ верный для non-empty).
    combined_acc = occ_acc * (color_acc * piece_acc if n_occupied else 1.0)
    return {"loss": sum_loss / n_total, "occ_acc": occ_acc,
            "color_acc": color_acc, "piece_acc": piece_acc,
            "combined_acc": combined_acc}


def main(argv=None) -> int:
    args = parse_args(argv)
    args.output.mkdir(parents=True, exist_ok=True)

    import torch
    from torch import nn
    from torch.optim import AdamW
    from torch.optim.lr_scheduler import CosineAnnealingLR
    from torch.utils.data import DataLoader
    import random
    import numpy as np

    random.seed(args.seed); np.random.seed(args.seed); torch.manual_seed(args.seed)

    device = torch.device(args.device or ("cuda" if torch.cuda.is_available() else "cpu"))
    print(f"[train3] device={device}", file=sys.stderr)

    from .transforms import build_train_transform, build_eval_transform
    from .dataset import CellDatasetV2

    train_ds = CellDatasetV2(args.data_dir, "train", transform=build_train_transform(args.cell_size))
    val_ds = CellDatasetV2(args.data_dir, "val", transform=build_eval_transform(args.cell_size))
    print(f"[train3] dataset train={len(train_ds):,} val={len(val_ds):,}", file=sys.stderr)

    train_dl = DataLoader(train_ds, batch_size=args.batch_size, shuffle=True,
                          drop_last=True, num_workers=args.num_workers)
    val_dl = DataLoader(val_ds, batch_size=args.batch_size, shuffle=False,
                        drop_last=False, num_workers=args.num_workers)

    model = _build_model(args.width_mult).to(device)
    n_params = sum(p.numel() for p in model.parameters() if p.requires_grad)
    print(f"[train3] params={n_params:,}", file=sys.stderr)

    criterion = nn.CrossEntropyLoss()
    optimizer = AdamW(model.parameters(), lr=args.lr, weight_decay=args.weight_decay)
    scheduler = CosineAnnealingLR(optimizer, T_max=args.epochs, eta_min=args.lr * 1e-2)

    best_val = math.inf
    log_path = args.output / "train_log.jsonl"
    last_path = args.output / "last.pt"
    best_path = args.output / "best.pt"
    epoch_path_fmt = str(args.output / "epoch_{:02d}.pt")

    with log_path.open("w") as logfh:
        for epoch in range(1, args.epochs + 1):
            t0 = time.time()
            tr = _run_epoch(model, train_dl, criterion, optimizer, device, True,
                            args.max_train_batches)
            va = _run_epoch(model, val_dl, criterion, optimizer, device, False,
                            args.max_val_batches)
            scheduler.step()

            rec = {"epoch": epoch, "lr": optimizer.param_groups[0]["lr"],
                   "epoch_seconds": round(time.time() - t0, 2),
                   "train": tr, "val": va}
            logfh.write(json.dumps(rec) + "\n"); logfh.flush()
            print(f"[ep {epoch:02d}/{args.epochs}] "
                  f"train: loss={tr['loss']:.4f} occ={tr['occ_acc']:.4f} "
                  f"color={tr['color_acc']:.4f} piece={tr['piece_acc']:.4f} "
                  f"combo={tr['combined_acc']:.4f} | "
                  f"val: loss={va['loss']:.4f} occ={va['occ_acc']:.4f} "
                  f"color={va['color_acc']:.4f} piece={va['piece_acc']:.4f} "
                  f"combo={va['combined_acc']:.4f} ({rec['epoch_seconds']:.0f}s)",
                  file=sys.stderr)
            torch.save({"model": model.state_dict(),
                        "epoch": epoch, "args": vars(args),
                        "val": va}, last_path)
            # KS-3091 v3: сохраняем чекпоинт КАЖДОЙ эпохи отдельно (не теряем
            # промежуточные веса как в v0.9.2).
            torch.save({"model": model.state_dict(),
                        "epoch": epoch, "args": vars(args),
                        "val": va}, epoch_path_fmt.format(epoch))
            if va["loss"] < best_val:
                best_val = va["loss"]
                torch.save({"model": model.state_dict(),
                            "epoch": epoch, "args": vars(args),
                            "val": va}, best_path)
                print(f"  [ckpt] new best val_loss={best_val:.4f}", file=sys.stderr)

    return 0


if __name__ == "__main__":
    sys.exit(main())
