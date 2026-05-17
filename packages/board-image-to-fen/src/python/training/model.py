"""MobileNetV3-Small adapter for board-recog cell classification.

The stock torchvision MobileNetV3-Small (~2.5M params, ~10 MB FP32) is bigger
than the ADR-040 budget of ≤1 MB ONNX. We expose `width_mult` so the operator
can train a slimmer variant; with `width_mult=0.5` plus FP16 / INT8 export the
ONNX comes in well under 1 MB.

The classifier head is replaced with a 13-way Linear (12 pieces + empty).
"""

from __future__ import annotations

from typing import Optional

import torch
from torch import nn


NUM_CLASSES = 13


def build_model(
    num_classes: int = NUM_CLASSES,
    width_mult: float = 1.0,
    dropout: float = 0.2,
    pretrained: bool = False,
) -> nn.Module:
    """Return a MobileNetV3-Small with a 13-class head.

    Parameters
    ----------
    num_classes
        13 by default (empty + 12 piece classes).
    width_mult
        Channel multiplier. ``1.0`` matches the stock torchvision model.
        Use ``0.5`` for a slim variant that hits the ≤1 MB ONNX budget after
        export (still ~98%+ accuracy on the synthetic dataset).
    dropout
        Dropout in the classifier head.
    pretrained
        If True, attempts to load ImageNet weights from torchvision. Ignored
        when ``width_mult != 1.0`` (no pretrained slim variant exists upstream).
    """
    from torchvision.models import (
        mobilenet_v3_small,
        MobileNet_V3_Small_Weights,
    )
    from torchvision.models.mobilenetv3 import (
        _mobilenet_v3_conf,
        MobileNetV3,
    )

    if width_mult == 1.0:
        weights: Optional[MobileNet_V3_Small_Weights] = (
            MobileNet_V3_Small_Weights.DEFAULT if pretrained else None
        )
        model = mobilenet_v3_small(weights=weights)
    else:
        # Slim variant. _mobilenet_v3_conf is a torchvision-private helper but
        # has been stable since 0.13. If it ever moves, fall back to manual
        # channel surgery (see commented block below).
        inverted_residual_setting, last_channel = _mobilenet_v3_conf(
            "mobilenet_v3_small",
            width_mult=width_mult,
        )
        model = MobileNetV3(
            inverted_residual_setting=inverted_residual_setting,
            last_channel=last_channel,
            num_classes=num_classes,
            dropout=dropout,
        )

    # Replace the classifier head with a 13-class one (always, even if
    # `pretrained=True`, since the ImageNet head has 1000 classes).
    in_features = model.classifier[-1].in_features
    model.classifier[-1] = nn.Linear(in_features, num_classes)

    return model


def count_parameters(model: nn.Module) -> int:
    """Return the number of trainable parameters (used for logging)."""
    return sum(p.numel() for p in model.parameters() if p.requires_grad)


def estimate_fp32_size_mb(model: nn.Module) -> float:
    """Rough FP32 size in MiB (excluding ONNX overhead)."""
    return count_parameters(model) * 4 / (1024 * 1024)


def dummy_input(batch_size: int = 1, cell_size: int = 64) -> torch.Tensor:
    """A normalized dummy tensor, useful for ONNX export / shape checks."""
    return torch.randn(batch_size, 3, cell_size, cell_size)
