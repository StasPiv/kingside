"""KS-3091 v3 follow-up: 3-stage head поверх ResNet18, предобученной на ImageNet.

Идея: вместо того чтобы дообучать MobileNetV3 с нуля и добавлять стили
в датасет под каждый новый кейс, берём backbone, который уже умеет
распознавать общие визуальные паттерны (ImageNet) — а сверху ставим
маленькую 3-головую голову (occ + color + piece). Backbone замораживаем
первые `--freeze-epochs` эпох, потом размораживаем с маленьким lr.

Архитектура:
  ResNet18 (без последнего fc) → 512-d feature
    ├── head_occ   (Linear 512→2)
    ├── head_color (Linear 512→2)
    └── head_piece (Linear 512→6)

Входной размер: 96×96 (ресайз из 64×64). ResNet18 ожидает RGB+Normalize
ImageNet — это уже даёт `build_train_transform` / `build_eval_transform`.

Использование:

    python -m training.train_foundation \\
      --data-dir /project/packages/board-image-to-fen/data/v2 \\
      --output /tmp/v0.9.6 \\
      --epochs 8 --batch-size 256 --freeze-epochs 2 \\
      --cell-size 96
"""
from __future__ import annotations

import argparse
import json
import math
import sys
import time
from pathlib import Path


def _build_model(freeze_backbone: bool = True):
    """ResNet18 (ImageNet) → identity fc → 3 параллельных Linear-head'а."""
    import torch
    from torch import nn
    from torchvision.models import resnet18, ResNet18_Weights

    backbone = resnet18(weights=ResNet18_Weights.IMAGENET1K_V1)
    feat_dim = backbone.fc.in_features  # 512
    backbone.fc = nn.Identity()

    if freeze_backbone:
        for p in backbone.parameters():
            p.requires_grad = False

    class FoundationHead(nn.Module):
        def __init__(self, backbone, feat_dim):
            super().__init__()
            self.backbone = backbone
            self.dropout = nn.Dropout(0.2)
            self.head_occ = nn.Linear(feat_dim, 2)
            self.head_color = nn.Linear(feat_dim, 2)
            self.head_piece = nn.Linear(feat_dim, 6)

        def forward(self, x):
            f = self.dropout(self.backbone(x))
            return self.head_occ(f), self.head_color(f), self.head_piece(f)

    return FoundationHead(backbone, feat_dim)


def _set_backbone_trainable(model, trainable: bool):
    for p in model.backbone.parameters():
        p.requires_grad = trainable


def _run_epoch(model, loader, criterion, optimizer, device, train: bool,
               max_batches: int = 0):
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
            images = batch["image"].to(device, non_blocking=True)
            labels = batch["label"].to(device, non_blocking=True)

            occ = (labels > 0).long()
            piece_color_idx = (labels - 1).clamp(min=0)
            color = (piece_color_idx // 6).clamp(min=0)
            piece = (piece_color_idx % 6)

            logits_occ, logits_color, logits_piece = model(images)

            loss_occ = criterion(logits_occ, occ)
            mask = occ.bool()
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
                sum_color_correct += int(
                    (logits_color[mask].argmax(1) == color[mask]).sum().item()
                )
                sum_piece_correct += int(
                    (logits_piece[mask].argmax(1) == piece[mask]).sum().item()
                )

    if n_total == 0:
        return {"loss": float("nan"), "occ_acc": float("nan"),
                "color_acc": float("nan"), "piece_acc": float("nan"),
                "combined_acc": float("nan")}
    color_acc = sum_color_correct / n_occupied if n_occupied else 0.0
    piece_acc = sum_piece_correct / n_occupied if n_occupied else 0.0
    occ_acc = sum_occ_correct / n_total
    combined_acc = occ_acc * (color_acc * piece_acc if n_occupied else 1.0)
    return {"loss": sum_loss / n_total, "occ_acc": occ_acc,
            "color_acc": color_acc, "piece_acc": piece_acc,
            "combined_acc": combined_acc}


def parse_args(argv=None):
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--data-dir", required=True, type=Path)
    p.add_argument("--output", required=True, type=Path)
    p.add_argument("--epochs", type=int, default=8)
    p.add_argument("--batch-size", type=int, default=256)
    p.add_argument("--lr-head", type=float, default=1e-3,
                   help="LR for heads (and backbone когда frozen).")
    p.add_argument("--lr-backbone", type=float, default=1e-4,
                   help="LR для backbone после unfreeze.")
    p.add_argument("--weight-decay", type=float, default=1e-4)
    p.add_argument("--num-workers", type=int, default=0)
    p.add_argument("--cell-size", type=int, default=96,
                   help="Размер ресайза. ResNet18 хочет ≥32×32, 96 — хороший баланс.")
    p.add_argument("--freeze-epochs", type=int, default=2,
                   help="Сколько первых эпох backbone заморожен.")
    p.add_argument("--max-train-batches", type=int, default=0)
    p.add_argument("--max-val-batches", type=int, default=0)
    p.add_argument("--seed", type=int, default=3096)
    p.add_argument("--device", default=None)
    return p.parse_args(argv)


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
    print(f"[foundation] device={device}", file=sys.stderr)

    from .transforms import build_train_transform, build_eval_transform
    from .dataset import CellDatasetV2

    train_ds = CellDatasetV2(args.data_dir, "train",
                             transform=build_train_transform(args.cell_size))
    val_ds = CellDatasetV2(args.data_dir, "val",
                           transform=build_eval_transform(args.cell_size))
    print(f"[foundation] dataset train={len(train_ds):,} val={len(val_ds):,}",
          file=sys.stderr)

    train_dl = DataLoader(train_ds, batch_size=args.batch_size, shuffle=True,
                          drop_last=True, num_workers=args.num_workers,
                          pin_memory=(device.type == "cuda"))
    val_dl = DataLoader(val_ds, batch_size=args.batch_size, shuffle=False,
                        drop_last=False, num_workers=args.num_workers,
                        pin_memory=(device.type == "cuda"))

    model = _build_model(freeze_backbone=(args.freeze_epochs > 0)).to(device)
    n_total = sum(p.numel() for p in model.parameters())
    n_trainable = sum(p.numel() for p in model.parameters() if p.requires_grad)
    print(f"[foundation] params total={n_total:,} trainable={n_trainable:,}",
          file=sys.stderr)

    criterion = nn.CrossEntropyLoss()

    # Optimizer — две группы: backbone (lr_backbone) и heads (lr_head).
    # Когда backbone заморожен, первая группа всё равно собирается,
    # но requires_grad=False → шагов не будет.
    head_params = list(model.head_occ.parameters()) + \
                  list(model.head_color.parameters()) + \
                  list(model.head_piece.parameters())
    backbone_params = list(model.backbone.parameters())
    optimizer = AdamW(
        [
            {"params": backbone_params, "lr": args.lr_backbone},
            {"params": head_params, "lr": args.lr_head},
        ],
        weight_decay=args.weight_decay,
    )
    scheduler = CosineAnnealingLR(optimizer, T_max=args.epochs,
                                  eta_min=args.lr_head * 1e-2)

    best_val = math.inf
    log_path = args.output / "train_log.jsonl"
    last_path = args.output / "last.pt"
    best_path = args.output / "best.pt"
    epoch_path_fmt = str(args.output / "epoch_{:02d}.pt")

    with log_path.open("w") as logfh:
        for epoch in range(1, args.epochs + 1):
            # Размораживаем backbone после freeze_epochs.
            if epoch == args.freeze_epochs + 1 and args.freeze_epochs > 0:
                _set_backbone_trainable(model, True)
                n_tr = sum(p.numel() for p in model.parameters() if p.requires_grad)
                print(f"[foundation] ep{epoch}: unfreeze backbone, trainable={n_tr:,}",
                      file=sys.stderr)

            t0 = time.time()
            tr = _run_epoch(model, train_dl, criterion, optimizer, device, True,
                            args.max_train_batches)
            va = _run_epoch(model, val_dl, criterion, optimizer, device, False,
                            args.max_val_batches)
            scheduler.step()

            rec = {"epoch": epoch,
                   "lr_backbone": optimizer.param_groups[0]["lr"],
                   "lr_head": optimizer.param_groups[1]["lr"],
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
