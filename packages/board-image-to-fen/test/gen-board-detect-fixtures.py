#!/usr/bin/env python3
"""KS-2359 / ADR-040. Генератор синтетических fixtures для тестов
Stage 1 board detection.

Использует Lichess `fen.gif` public-API: рендерит позицию в PNG
произвольного стиля доски и фигур. Покрывает MVP-сценарий
«скриншот доски с экрана» (≈95% реальных кейсов по ADR-040 §1).

Стили (Lichess):
  - 8 board colors: brown, blue, green, purple, grey, ic, leather, marble
  - 7 piece sets: cburnett, merida, alpha, pirouetti, chessnut, fantasy, spatial

Используется 5 контрольных позиций (от стандартной до сложного
эндшпиля) × подвыборка стилей = ~50 fixtures.

Запуск:
    cd packages/board-image-to-fen
    python3 test/gen-board-detect-fixtures.py [--out test/fixtures/board-detect/]

После — fixtures доступны для tests/board-detect.spec.ts. В git не
коммитятся (см. .gitignore рядом). На CI генерируются заново.
"""

from __future__ import annotations

import argparse
import os
import sys
import time
from typing import List, Tuple
from urllib.parse import urlencode
from urllib.request import urlopen, Request


# 5 контрольных позиций: стартовая, миттельшпиль, эндшпиль с малым
# числом фигур, позиция с длинными диагоналями, шахматный этюд.
POSITIONS: List[Tuple[str, str]] = [
    ('start', 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -'),
    ('middlegame', 'r1bq1rk1/pppp1ppp/2n2n2/2b1p3/2B1P3/2N2N2/PPPP1PPP/R1BQ1RK1 w - -'),
    ('endgame', '8/8/8/4k3/8/4K3/4P3/8 w - -'),
    ('diagonals', '6k1/5ppp/8/8/8/8/PPP5/1K6 w - -'),
    ('study', '8/p7/1p6/2k5/8/4K3/PP6/8 w - -'),
]

# 8 цветовых схем доски × 7 наборов фигур = 56 комбинаций; берём
# подвыборку чтобы получить ~50 fixtures с 5 позициями.
BOARD_COLORS = ['brown', 'blue', 'green', 'purple', 'grey', 'ic', 'leather', 'marble']
PIECE_SETS = ['cburnett', 'merida', 'alpha', 'pirouetti', 'chessnut', 'fantasy', 'spatial']

LICHESS_BASE = 'https://lichess1.org/export/fen.gif'


def _fetch_one(fen: str, color: str, piece_set: str, dst: str) -> bool:
    """Скачивает один GIF от Lichess. Возвращает True при успехе.

    Lichess `fen.gif` принимает параметры:
      - fen
      - color (white|black) — кто внизу (ориентация)
      - theme (board color)
      - piece (piece set)
    """
    params = {
        'fen': fen,
        'color': 'white',
        'theme': color,
        'piece': piece_set,
    }
    url = f'{LICHESS_BASE}?{urlencode(params)}'
    req = Request(url, headers={'User-Agent': 'kingside-board-detect-fixtures/1.0'})
    try:
        with urlopen(req, timeout=15) as resp:
            data = resp.read()
        if len(data) < 1000:
            print(f'[gen] {dst}: response too small ({len(data)} bytes)', file=sys.stderr)
            return False
        with open(dst, 'wb') as f:
            f.write(data)
        return True
    except Exception as exc:  # noqa: BLE001
        print(f'[gen] {dst}: {exc}', file=sys.stderr)
        return False


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        '--out',
        default=os.path.join(
            os.path.dirname(os.path.abspath(__file__)),
            'fixtures',
            'board-detect',
        ),
        help='Output directory.',
    )
    parser.add_argument(
        '--sleep-ms',
        type=int,
        default=200,
        help='Sleep между запросами для уважения к lichess (default 200ms).',
    )
    args = parser.parse_args()

    os.makedirs(args.out, exist_ok=True)

    total = 0
    ok = 0
    for pos_name, fen in POSITIONS:
        # Для каждой позиции — 10 комбинаций (округлым подбором: 8 boards × 2 pieces).
        # Это даёт 5 × 10 = 50 fixtures. Используем разные piece-sets циклически.
        for i, color in enumerate(BOARD_COLORS):
            for piece_set in [PIECE_SETS[i % len(PIECE_SETS)], PIECE_SETS[(i + 3) % len(PIECE_SETS)]]:
                total += 1
                fname = f'{pos_name}__{color}__{piece_set}.gif'
                dst = os.path.join(args.out, fname)
                if os.path.exists(dst):
                    ok += 1
                    continue
                if _fetch_one(fen, color, piece_set, dst):
                    ok += 1
                time.sleep(args.sleep_ms / 1000.0)

    print(f'[gen] downloaded {ok}/{total} fixtures into {args.out}')
    return 0 if ok >= total * 0.8 else 1


if __name__ == '__main__':
    sys.exit(main())
