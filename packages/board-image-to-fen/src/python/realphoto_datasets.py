"""KS-3091 / ADR-040-v2 §1.1 follow-up. Stub-интеграция чужих real-photo
датасетов: ChessReD (CC-BY-4.0) и Chess Cog (MIT).

Реальное скачивание (~гигабайты) и конверсия в (cell_png, label) поручены
devops в момент полного CPU-прогона. Этот модуль публикует только:

  * URL'ы и SHA256-пины архивов (когда devops зальёт);
  * планируемый формат конверсии (cell PNG 64×64 + numeric label,
    совпадающий с `dataset_gen.LABEL_TO_IDX`);
  * бюджет real-photo в train ≤ 15% от общего числа клеток (ADR §1.1);
  * лицензии и attribution-текст для manifest_v2.json и UI Credits.

Когда devops зальёт сконвертированные клетки на S3
(`s3://kingside-ml/datasets/board-recog/v2/real_photo/{chessred,chesscog}.h5`),
тренинг-скрипт (этап C, KS-3090-C) подмешает их к синтетике через
`torch.utils.data.ConcatDataset`. Модуль `dataset.py:CellDataset` уже
поддерживает h5-backend — никаких контрактных правок не нужно.

Если эту фазу решат отложить (например, на этапе D окажется, что
синтетики достаточно для pilot-gate) — `pending_integration` в manifest
позволяет это явно зафиксировать.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List

# Бюджет real-photo в train (ADR-040-v2 §1.1) — не больше 15% от общего
# числа train-клеток. При 1.5 M синтетики это ~225 000 real-photo клеток
# максимум.
REAL_PHOTO_BUDGET_PCT: float = 15.0


@dataclass(frozen=True)
class RealPhotoSource:
    name: str
    license: str
    attribution: str
    source_url: str
    paper_url: str
    expected_images: int
    expected_cells: int
    notes: str
    status: str = "pending_integration"


CHESSRED = RealPhotoSource(
    name="ChessReD",
    license="CC-BY-4.0",
    attribution="Wölflein & Arandjelović (2023)",
    source_url="https://github.com/georg-wolflein/chesscog",
    paper_url="https://arxiv.org/abs/2310.04086",
    expected_images=10_800,
    expected_cells=10_800 * 64,
    notes=(
        "100 unique positions × 8 angles × multiple lighting conditions. "
        "Comes with per-image FEN ground truth + corner coordinates → "
        "warp-and-split into 64 cells per image without manual labelling."
    ),
)

CHESS_COG = RealPhotoSource(
    name="Chess Cog",
    license="MIT",
    attribution="Czyzewski et al. (2020)",
    source_url="https://github.com/maciejczyzewski/neural-chessboard",
    paper_url="https://arxiv.org/abs/1708.03898",
    expected_images=2_880,
    expected_cells=2_880 * 64,
    notes=(
        "Real photos + synthetic renders with FEN ground truth. License is "
        "permissive — minimal compliance burden."
    ),
)

REAL_PHOTO_SOURCES: List[RealPhotoSource] = [CHESSRED, CHESS_COG]


def manifest_block() -> Dict[str, Dict[str, str]]:
    """Подготовленный блок для `manifest_v2.external_datasets` — на случай
    обновления манифеста после интеграции (когда devops зальёт реальные
    архивы)."""
    return {
        src.name: {
            "license": src.license,
            "attribution": src.attribution,
            "source_url": src.source_url,
            "paper_url": src.paper_url,
            "expected_images": str(src.expected_images),
            "expected_cells": str(src.expected_cells),
            "status": src.status,
            "notes": src.notes,
        }
        for src in REAL_PHOTO_SOURCES
    }


def attribution_lines() -> List[str]:
    """Готовые строки для THIRD_PARTY_LICENSES.md / UI Credits."""
    return [
        f"{src.name} — {src.attribution}, {src.license}. Source: {src.source_url}"
        for src in REAL_PHOTO_SOURCES
    ]
