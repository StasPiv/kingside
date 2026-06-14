"""Train the board-recog CNN classifier (KS-2361, ADR-040 Stage 2).

Usage (typically on a Colab GPU instance — see README.md):

    python -m training.train \\
        --data-dir /content/board-recog-v1 \\
        --output   /content/runs/v1.0.0 \\
        --epochs 20 --batch-size 256 --lr 1e-3

The script writes the following artefacts into ``--output``:

    best.pt              — checkpoint with the lowest validation loss
    last.pt              — checkpoint of the final epoch
    train_log.jsonl      — one JSON line per epoch (loss / acc / lr)
    training_meta.json   — CLI args + final epoch metrics
    model.onnx           — only if ``--export-onnx`` is passed

Pass ``--export-onnx`` to immediately export the best checkpoint to ONNX after
training; the actual export logic lives in ``training.export_onnx``.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
import time
from pathlib import Path
from typing import Any, Dict


def _detect_dataset_version(data_dir):
    """KS-3091: автоопределение v1 vs v2 по содержимому data_dir.

    v2 — есть `manifest_v2.json` + `cells_train.h5`/`cells_val.h5` рядом.
    v1 — есть `splits/{train,val}.jsonl`.
    """
    from pathlib import Path
    p = Path(data_dir)
    if (p / "manifest_v2.json").is_file() and (p / "cells_train.h5").is_file():
        return "v2"
    return "v1"


def _h5_worker_init(worker_id):
    """KS-3091 follow-up. DataLoader workers must re-open their h5py.File
    AFTER fork/spawn — иначе кэш HDF5 шарится между процессами и
    наступает deadlock (видели в GPU прогоне 18.05). Сбрасываем `_h5 = None`
    на каждом worker'е, lazy-open в __getitem__ откроет файл заново.
    """
    import torch
    info = torch.utils.data.get_worker_info()
    ds = info.dataset
    if hasattr(ds, "_h5"):
        ds._h5 = None


def _build_dataloaders(args, train_tf, eval_tf):
    """Lazy import torch + project Dataset so `--help` works without torch."""
    import multiprocessing
    import torch
    from torch.utils.data import DataLoader

    version = _detect_dataset_version(args.data_dir)
    if version == "v2":
        from .dataset import CellDatasetV2 as DS
    else:
        from .dataset import CellDataset as DS

    train_ds = DS(args.data_dir, "train", transform=train_tf)
    val_ds = DS(args.data_dir, "val", transform=eval_tf)

    # KS-3091 follow-up. `spawn` вместо `fork` — h5py НЕ fork-safe, при
    # обычном multiprocessing fork+h5py worker'ы зависают на первой
    # итерации (видели в GPU pilot 18.05). `spawn` создаёт чистый процесс,
    # каждый worker открывает свой собственный h5py.File через _h5_worker_init.
    if args.num_workers > 0:
        mp_ctx = multiprocessing.get_context("spawn")
        worker_init = _h5_worker_init
    else:
        mp_ctx = None
        worker_init = None

    common = dict(
        batch_size=args.batch_size,
        num_workers=args.num_workers,
        pin_memory=torch.cuda.is_available(),
        persistent_workers=args.num_workers > 0,
        multiprocessing_context=mp_ctx,
        worker_init_fn=worker_init,
    )
    train_dl = DataLoader(train_ds, shuffle=True, drop_last=True, **common)
    val_dl = DataLoader(val_ds, shuffle=False, drop_last=False, **common)
    return train_ds, val_ds, train_dl, val_dl


def _run_epoch(model, loader, criterion, optimizer, device, train: bool, max_batches: int = 0):
    """One epoch of train or eval. Returns (mean_loss, top1_accuracy).

    KS-3091: ``max_batches`` > 0 — раннее завершение цикла после N батчей.
    Полезно для smoke-теста CPU-обучения без полного прохода 1.5M клеток.
    """
    import torch

    model.train(train)
    total_loss = 0.0
    total_correct = 0
    total_samples = 0
    ctx = torch.enable_grad() if train else torch.no_grad()
    batches_done = 0

    with ctx:
        for batch in loader:
            if max_batches and batches_done >= max_batches:
                break
            batches_done += 1
            images = batch["image"].to(device, non_blocking=True)
            labels = batch["label"].to(device, non_blocking=True)

            logits = model(images)
            loss = criterion(logits, labels)

            if train:
                optimizer.zero_grad(set_to_none=True)
                loss.backward()
                optimizer.step()

            batch_size = labels.size(0)
            total_loss += loss.item() * batch_size
            total_correct += (logits.argmax(dim=1) == labels).sum().item()
            total_samples += batch_size

    if total_samples == 0:
        return float("nan"), float("nan")
    return total_loss / total_samples, total_correct / total_samples


def parse_args(argv=None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument(
        "--data-dir", required=True, type=Path,
        help="Path that contains cells/, splits/, manifest_v1.json.",
    )
    p.add_argument(
        "--output", required=True, type=Path,
        help="Directory to write checkpoints, logs and (optionally) ONNX.",
    )
    p.add_argument("--epochs", type=int, default=20)
    p.add_argument("--batch-size", type=int, default=256)
    p.add_argument("--lr", type=float, default=1e-3)
    p.add_argument("--weight-decay", type=float, default=1e-4)
    p.add_argument(
        "--num-workers", type=int, default=4,
        help="DataLoader workers. Colab free tier handles 2; A100 likes 8.",
    )
    p.add_argument(
        "--width-mult", type=float, default=1.0,
        help="MobileNetV3-Small channel multiplier. Use 0.5 to fit ONNX ≤ 1 MB.",
    )
    p.add_argument(
        "--cell-size", type=int, default=64,
        help="Input cell resolution (must match manifest_v1.json.cell_size).",
    )
    p.add_argument(
        "--early-stop-patience", type=int, default=3,
        help="Stop training if val_loss does not improve for N epochs in a row.",
    )
    p.add_argument(
        "--min-delta", type=float, default=1e-4,
        help="Minimum val_loss improvement to reset the early-stop counter.",
    )
    p.add_argument(
        "--seed", type=int, default=2361,
        help="Manual seed for torch/numpy/random.",
    )
    p.add_argument(
        "--no-cosine", action="store_true",
        help="Disable cosine LR schedule (constant LR fallback).",
    )
    p.add_argument(
        "--export-onnx", action="store_true",
        help="Export best.pt to model.onnx after training finishes.",
    )
    p.add_argument(
        "--onnx-opset", type=int, default=17,
        help="ONNX opset for export (kept in sync with onnxruntime in prod).",
    )
    p.add_argument(
        "--device", default=None,
        help="Override device. Default: cuda if available else cpu.",
    )
    p.add_argument(
        "--max-train-batches", type=int, default=0,
        help="KS-3091: для smoke-теста ограничить число batch'ей за эпоху. "
             "0 = без лимита (полная эпоха).",
    )
    p.add_argument(
        "--max-val-batches", type=int, default=0,
        help="Аналогично max-train-batches, но для val-цикла.",
    )
    return p.parse_args(argv)


def _seed_everything(seed: int) -> None:
    import random
    import numpy as np
    import torch

    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)


def main(argv=None) -> int:
    args = parse_args(argv)
    args.output.mkdir(parents=True, exist_ok=True)

    # Late imports — keeps argparse / --help usable without torch installed.
    import torch
    from torch import nn
    from torch.optim import AdamW
    from torch.optim.lr_scheduler import CosineAnnealingLR

    from .dataset import build_eval_transform, build_train_transform
    from .model import (
        NUM_CLASSES,
        build_model,
        count_parameters,
        estimate_fp32_size_mb,
    )

    _seed_everything(args.seed)

    device = torch.device(
        args.device or ("cuda" if torch.cuda.is_available() else "cpu")
    )
    print(f"[train] device={device}", file=sys.stderr)

    train_tf = build_train_transform(args.cell_size)
    eval_tf = build_eval_transform(args.cell_size)

    train_ds, val_ds, train_dl, val_dl = _build_dataloaders(args, train_tf, eval_tf)
    print(
        f"[train] dataset: train={len(train_ds):,}  val={len(val_ds):,}  "
        f"batch={args.batch_size}",
        file=sys.stderr,
    )

    model = build_model(
        num_classes=NUM_CLASSES,
        width_mult=args.width_mult,
        dropout=0.2,
        pretrained=False,
    ).to(device)
    n_params = count_parameters(model)
    print(
        f"[train] model: MobileNetV3-Small w={args.width_mult} "
        f"params={n_params:,} fp32_size≈{estimate_fp32_size_mb(model):.2f} MiB",
        file=sys.stderr,
    )

    criterion = nn.CrossEntropyLoss()
    optimizer = AdamW(
        model.parameters(),
        lr=args.lr,
        weight_decay=args.weight_decay,
    )
    scheduler = (
        None
        if args.no_cosine
        else CosineAnnealingLR(optimizer, T_max=args.epochs, eta_min=args.lr * 1e-2)
    )

    log_path = args.output / "train_log.jsonl"
    best_path = args.output / "best.pt"
    last_path = args.output / "last.pt"

    best_val_loss = math.inf
    epochs_since_improve = 0
    epoch_records: list[Dict[str, Any]] = []

    log_fh = log_path.open("w", encoding="utf-8")
    try:
        for epoch in range(1, args.epochs + 1):
            t0 = time.time()
            train_loss, train_acc = _run_epoch(
                model, train_dl, criterion, optimizer, device, train=True,
                max_batches=args.max_train_batches,
            )
            val_loss, val_acc = _run_epoch(
                model, val_dl, criterion, optimizer, device, train=False,
                max_batches=args.max_val_batches,
            )

            current_lr = optimizer.param_groups[0]["lr"]
            if scheduler is not None:
                scheduler.step()

            record = {
                "epoch": epoch,
                "train_loss": train_loss,
                "train_acc": train_acc,
                "val_loss": val_loss,
                "val_acc": val_acc,
                "lr": current_lr,
                "epoch_seconds": round(time.time() - t0, 2),
            }
            epoch_records.append(record)
            log_fh.write(json.dumps(record) + "\n")
            log_fh.flush()
            print(
                f"[epoch {epoch:02d}/{args.epochs}] "
                f"train_loss={train_loss:.4f} acc={train_acc:.4f} | "
                f"val_loss={val_loss:.4f} acc={val_acc:.4f} | "
                f"lr={current_lr:.2e}  ({record['epoch_seconds']:.1f}s)",
                file=sys.stderr,
            )

            # Checkpoint always; replace `best.pt` on improvement.
            torch.save(
                {
                    "epoch": epoch,
                    "model_state": model.state_dict(),
                    "optimizer_state": optimizer.state_dict(),
                    "args": vars(args),
                    "val_loss": val_loss,
                    "val_acc": val_acc,
                },
                last_path,
            )

            improved = val_loss < best_val_loss - args.min_delta
            if improved:
                best_val_loss = val_loss
                epochs_since_improve = 0
                torch.save(
                    {
                        "epoch": epoch,
                        "model_state": model.state_dict(),
                        "args": vars(args),
                        "val_loss": val_loss,
                        "val_acc": val_acc,
                    },
                    best_path,
                )
                print(f"[ckpt] new best val_loss={val_loss:.4f} → {best_path}",
                      file=sys.stderr)
            else:
                epochs_since_improve += 1
                if epochs_since_improve >= args.early_stop_patience:
                    print(
                        f"[early-stop] val_loss did not improve for "
                        f"{epochs_since_improve} epochs (best={best_val_loss:.4f}). "
                        f"Stopping.",
                        file=sys.stderr,
                    )
                    break
    finally:
        log_fh.close()

    # Persist run metadata (used by evaluate.py + as audit trail).
    meta = {
        "args": {
            **{k: (str(v) if isinstance(v, Path) else v) for k, v in vars(args).items()},
        },
        "epochs_run": len(epoch_records),
        "best_val_loss": best_val_loss,
        "best_checkpoint": str(best_path),
        "last_checkpoint": str(last_path),
        "num_classes": NUM_CLASSES,
        "model_params": n_params,
    }
    (args.output / "training_meta.json").write_text(
        json.dumps(meta, indent=2), encoding="utf-8",
    )

    if args.export_onnx:
        from .export_onnx import export_checkpoint

        onnx_path = args.output / "model.onnx"
        export_checkpoint(
            checkpoint=best_path,
            output=onnx_path,
            width_mult=args.width_mult,
            cell_size=args.cell_size,
            opset=args.onnx_opset,
        )
        print(f"[onnx] exported best checkpoint → {onnx_path}", file=sys.stderr)

    return 0


if __name__ == "__main__":
    sys.exit(main())
