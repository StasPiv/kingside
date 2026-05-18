"""KS-3091 v3: тренировка corner-detector'а.

Модель: MobileNetV3-Small backbone + Linear head на 8 выходов
(нормализованные координаты 4 углов: TL, TR, BR, BL).

Loss: Smooth L1.

Вход: картинка 256×256 в grayscale (модель преобразует через ToGray
augmentation, чтобы быть инвариантной к цвету фона).

Использование:

    python -m training.train_corner_detector \\
        --data /project/packages/board-image-to-fen/data/v2/corners.h5 \\
        --output /tmp/corner-detector \\
        --epochs 10 --batch-size 64 --num-workers 0
"""
from __future__ import annotations

import argparse
import io
import json
import math
import sys
import time
from pathlib import Path
from typing import Any, Dict

import numpy as np


def _build_transform(img_size: int = 256, train: bool = True):
    import albumentations as A
    from albumentations.pytorch import ToTensorV2
    transforms = [
        A.Resize(img_size, img_size),
        A.ToGray(p=1.0),  # KS-3091 v3: grayscale на детектор тоже
    ]
    if train:
        transforms += [
            A.RandomBrightnessContrast(brightness_limit=0.2, contrast_limit=0.2, p=0.5),
            A.GaussNoise(var_limit=(5.0, 25.0), p=0.2),
            A.ImageCompression(quality_lower=60, quality_upper=100, p=0.3),
        ]
    transforms += [
        A.Normalize(mean=(0.485, 0.456, 0.406), std=(0.229, 0.224, 0.225)),
        ToTensorV2(),
    ]
    return A.Compose(transforms)


class CornerDataset:
    """Dataset для пар (картинка, 8-числовые координаты)."""
    def __init__(self, h5_path: Path, transform=None):
        import h5py
        from torch.utils.data import Dataset
        self.h5_path = Path(h5_path)
        self.transform = transform
        self._h5 = None
        with h5py.File(self.h5_path, "r") as fh:
            self.n = int(fh["images"].shape[0])

    def __len__(self):
        return self.n

    def __getitem__(self, idx):
        if self._h5 is None:
            import h5py
            self._h5 = h5py.File(self.h5_path, "r")
        png_bytes = bytes(self._h5["images"][idx])
        from PIL import Image
        img = Image.open(io.BytesIO(png_bytes)).convert("RGB")
        arr = np.asarray(img, dtype=np.uint8)
        corners = self._h5["corners"][idx].astype(np.float32)
        if self.transform is not None:
            out = self.transform(image=arr)
            return out["image"], corners
        # Fallback CHW float32.
        import torch
        return (torch.from_numpy(arr).permute(2, 0, 1).float() / 255.0, corners)


def _build_model(width_mult: float):
    import torch
    from torch import nn
    from torchvision.models.mobilenetv3 import _mobilenet_v3_conf, MobileNetV3
    inverted, last_ch = _mobilenet_v3_conf("mobilenet_v3_small", width_mult=width_mult)
    backbone = MobileNetV3(inverted, last_ch, num_classes=1, dropout=0.2)
    backbone.classifier = nn.Identity()
    backbone.eval()
    with torch.no_grad():
        dummy = torch.randn(1, 3, 256, 256)
        feat_dim = backbone(dummy).shape[-1]

    class CornerModel(nn.Module):
        def __init__(self, backbone, feat_dim):
            super().__init__()
            self.backbone = backbone
            self.head = nn.Sequential(
                nn.Linear(feat_dim, 128),
                nn.ReLU(),
                nn.Linear(128, 8),
                nn.Sigmoid(),  # координаты в [0, 1]
            )

        def forward(self, x):
            return self.head(self.backbone(x))
    return CornerModel(backbone, feat_dim)


def _run_epoch(model, loader, criterion, optimizer, device, train: bool,
               max_batches: int = 0):
    import torch
    model.train(train)
    total_loss = 0.0; total_dist = 0.0; total = 0
    ctx = torch.enable_grad() if train else torch.no_grad()
    n_batches = 0
    with ctx:
        for images, corners in loader:
            if max_batches and n_batches >= max_batches:
                break
            n_batches += 1
            images = images.to(device); corners = corners.to(device)
            pred = model(images)
            loss = criterion(pred, corners)
            if train:
                optimizer.zero_grad(set_to_none=True)
                loss.backward()
                optimizer.step()
            bs = corners.size(0)
            total_loss += float(loss.item()) * bs
            # средняя пиксельная ошибка на угол (в нормализованных коэф.)
            # 8 чисел = 4 угла × 2 коорд; усредняем по точкам.
            err = (pred - corners).abs().view(bs, 4, 2).norm(dim=2).mean().item()
            total_dist += err * bs
            total += bs
    if total == 0:
        return float("nan"), float("nan")
    return total_loss / total, total_dist / total


def parse_args(argv=None):
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--data", required=True, type=Path)
    p.add_argument("--output", required=True, type=Path)
    p.add_argument("--epochs", type=int, default=10)
    p.add_argument("--batch-size", type=int, default=64)
    p.add_argument("--lr", type=float, default=1e-3)
    p.add_argument("--weight-decay", type=float, default=1e-4)
    p.add_argument("--num-workers", type=int, default=0)
    p.add_argument("--width-mult", type=float, default=0.5)
    p.add_argument("--img-size", type=int, default=256)
    p.add_argument("--val-split", type=float, default=0.1,
                   help="Доля данных в val.")
    p.add_argument("--max-train-batches", type=int, default=0)
    p.add_argument("--seed", type=int, default=3097)
    p.add_argument("--device", default=None)
    return p.parse_args(argv)


def main(argv=None) -> int:
    args = parse_args(argv)
    args.output.mkdir(parents=True, exist_ok=True)

    import torch
    from torch import nn
    from torch.optim import AdamW
    from torch.optim.lr_scheduler import CosineAnnealingLR
    from torch.utils.data import DataLoader, Subset
    import random

    random.seed(args.seed); np.random.seed(args.seed); torch.manual_seed(args.seed)

    device = torch.device(args.device or ("cuda" if torch.cuda.is_available() else "cpu"))
    print(f"[corner] device={device}", file=sys.stderr)

    tf_train = _build_transform(args.img_size, train=True)
    tf_eval = _build_transform(args.img_size, train=False)

    full = CornerDataset(args.data, transform=tf_train)
    n = len(full)
    n_val = max(1, int(n * args.val_split))
    n_train = n - n_val
    rng = np.random.default_rng(args.seed)
    indices = rng.permutation(n)
    train_idx = indices[:n_train]
    val_idx = indices[n_train:]
    val_set = CornerDataset(args.data, transform=tf_eval)
    train_ds = Subset(full, train_idx.tolist())
    val_ds = Subset(val_set, val_idx.tolist())
    print(f"[corner] dataset train={n_train} val={n_val}", file=sys.stderr)

    train_dl = DataLoader(train_ds, batch_size=args.batch_size, shuffle=True,
                          drop_last=True, num_workers=args.num_workers)
    val_dl = DataLoader(val_ds, batch_size=args.batch_size, shuffle=False,
                        num_workers=args.num_workers)

    model = _build_model(args.width_mult).to(device)
    n_params = sum(p.numel() for p in model.parameters())
    print(f"[corner] params={n_params:,}", file=sys.stderr)

    criterion = nn.SmoothL1Loss()
    optimizer = AdamW(model.parameters(), lr=args.lr, weight_decay=args.weight_decay)
    scheduler = CosineAnnealingLR(optimizer, T_max=args.epochs, eta_min=args.lr * 1e-2)

    best_val = math.inf
    log_path = args.output / "train_log.jsonl"
    last_path = args.output / "last.pt"
    best_path = args.output / "best.pt"

    with log_path.open("w") as logfh:
        for epoch in range(1, args.epochs + 1):
            t0 = time.time()
            tr_loss, tr_dist = _run_epoch(model, train_dl, criterion, optimizer,
                                           device, True, args.max_train_batches)
            va_loss, va_dist = _run_epoch(model, val_dl, criterion, optimizer,
                                           device, False, 0)
            scheduler.step()
            rec = {"epoch": epoch, "lr": optimizer.param_groups[0]["lr"],
                   "epoch_seconds": round(time.time() - t0, 2),
                   "train_loss": tr_loss, "train_corner_err": tr_dist,
                   "val_loss": va_loss, "val_corner_err": va_dist}
            logfh.write(json.dumps(rec) + "\n"); logfh.flush()
            # tr/va_dist это нормализованная "пиксельная ошибка" 0..1.
            # При 256x256 это значит px ≈ tr_dist * 256.
            print(f"[ep {epoch:02d}/{args.epochs}] "
                  f"train: loss={tr_loss:.5f} corner_err={tr_dist:.5f} "
                  f"(~{tr_dist*256:.1f}px) | "
                  f"val: loss={va_loss:.5f} corner_err={va_dist:.5f} "
                  f"(~{va_dist*256:.1f}px) ({rec['epoch_seconds']:.0f}s)",
                  file=sys.stderr)
            torch.save({"model": model.state_dict(), "epoch": epoch,
                        "args": vars(args), "val_corner_err": va_dist}, last_path)
            if va_loss < best_val:
                best_val = va_loss
                torch.save({"model": model.state_dict(), "epoch": epoch,
                            "args": vars(args), "val_corner_err": va_dist}, best_path)
                print(f"  [ckpt] new best val_loss={best_val:.5f}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
