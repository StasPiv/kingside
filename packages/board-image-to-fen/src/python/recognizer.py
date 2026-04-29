#!/usr/bin/env python3
"""KS-2028 board-image-to-fen — распознавание шахматной диаграммы (стиль Майзелиса) в FEN.

Алгоритм:
1. Otsu-threshold изображения, поиск 4 «жирных» полос (рамка доски) по проекции
   тёмных пикселей по строкам/столбцам.
2. Внутренняя область рамки делится на 8×8 = 64 клетки (cv2.resize до 50×50 каждая).
3. Шаблоны фигур извлекаются один раз из эталонной картинки начальной позиции
   (Autogen_eBook_id0.jpg), куда известна расстановка из FEN
   `rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR`. Полнота: все 12 типов фигур
   присутствуют, причём каждая на двух фонах (светлый/тёмный) кроме K/Q/k/q —
   эти доступны только на одном фоне, для другого фона используется тот же
   шаблон.
4. Для каждой клетки считается:
   - mass3 (морф-открытие 3×3) — отделяет «есть фигура» от «пусто»;
   - mass5 (морф-открытие 5×5) — отделяет белые (тонкий контур) от чёрных
     (заливной силуэт): тонкие линии исчезают при 5×5, заливные остаются.
5. Внутри своей цветовой группы и фона выбирается шаблон с максимальной NCC.

CLI (одиночный вызов):

    python3 recognizer.py <image-path> [--orientation white|black] [--json]

Выход — FEN-первая часть в stdout. Дополнительная диагностика — в stderr.
exit 0 — успех; exit 1 — ошибка (не нашлась рамка, не открылась картинка и т. п.).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import dataclass, field
from typing import Dict, Iterable, List, Optional, Tuple

import cv2
import numpy as np


CELL_SIZE = 50  # клетка нормализуется до 50×50 при матчинге
START_FEN_BOARD = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR'

# Эмпирические пороги для профиля Майзелиса (см. README §«Калибровка порогов»).
# Сохранены как модульные константы ради обратной совместимости с тестами и
# скриптами; для нового кода используй `Profile` (см. ниже).
# Признаки:
#   sw  — sw3_30: морф-открытие 3×3 + центральная зона 30×30 (макс 900);
#   cm5 — морф-открытие 5×5 + центральная зона 34×34 (макс 1156).
COLOR_MASS5_THRESHOLD = 350      # cm5 ≥ 350 → чёрная фигура
SOLID_WHITE_DARK_PIECE = 150     # sw > 150 на тёмной клетке → белая фигура
SOLID_WHITE_LIGHT_EMPTY = 800    # sw ≥ 800 на светлой клетке → пусто
LOW_CONFIDENCE_THRESHOLD = 0.30  # NCC ниже — выводим предупреждение в stderr


# ─────────────────────────── обнаружение рамки доски ────────────────────────


def _group_consecutive(arr: np.ndarray, gap: int = 4) -> List[List[int]]:
    if len(arr) == 0:
        return []
    groups: List[List[int]] = []
    current = [int(arr[0])]
    for v in arr[1:]:
        v = int(v)
        if v - current[-1] <= gap:
            current.append(v)
        else:
            groups.append(current)
            current = [v]
    groups.append(current)
    return groups


def _find_board_inner_bbox(img_gray: np.ndarray) -> Optional[Tuple[int, int, int, int]]:
    """Возвращает (x0, y0, x1, y1) — внутренний прямоугольник доски, без рамки.

    Алгоритм:
      1. Otsu-threshold картинки.
      2. По вертикальной проекции тёмных пикселей находим столбцы с длиной ≥
         60% высоты — это вертикальные линии рамки доски. Берём первую и
         последнюю группы — это левая и правая рамки.
      3. В горизонтальной полосе между этими столбцами повторно ищем строки,
         в которых тёмных пикселей ≥80% от ширины этой полосы — это
         горизонтальные линии рамки.
      4. Внутренние края рамок задают bbox.

    Подход устойчив к внешним меткам (буквы a–h, цифры 1–8 за пределами
    рамки) и к лишнему whitespace вокруг доски.
    """
    _, thresh = cv2.threshold(img_gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    h, w = thresh.shape

    col_dark = (thresh > 0).sum(axis=0)
    dark_cols = np.where(col_dark > 0.6 * h)[0]
    col_groups = _group_consecutive(dark_cols)
    if len(col_groups) < 2:
        return None
    left_frame_inner = col_groups[0][-1]
    right_frame_inner = col_groups[-1][0]
    board_width = right_frame_inner - left_frame_inner
    if board_width < 200:
        return None

    # Считаем тёмные пиксели в строках только в полосе между рамками
    band = thresh[:, left_frame_inner:right_frame_inner]
    row_dark = (band > 0).sum(axis=1)
    band_w = band.shape[1]
    dark_rows = np.where(row_dark > 0.8 * band_w)[0]
    row_groups = _group_consecutive(dark_rows)
    if len(row_groups) < 2:
        return None

    y0 = row_groups[0][-1] + 1
    y1 = row_groups[-1][0] - 1
    x0 = left_frame_inner + 1
    x1 = right_frame_inner - 1
    if y1 - y0 < 200 or x1 - x0 < 200:
        return None
    return x0, y0, x1, y1


def _slice_cells(img_gray: np.ndarray, bbox: Tuple[int, int, int, int]) -> List[List[np.ndarray]]:
    """Делит inner-box на 8×8 клеток и приводит каждую к CELL_SIZE×CELL_SIZE."""
    x0, y0, x1, y1 = bbox
    cell_w = (x1 - x0) / 8.0
    cell_h = (y1 - y0) / 8.0
    cells: List[List[np.ndarray]] = [[None] * 8 for _ in range(8)]
    for r in range(8):
        for c in range(8):
            cy0 = int(round(y0 + r * cell_h))
            cy1 = int(round(y0 + (r + 1) * cell_h))
            cx0 = int(round(x0 + c * cell_w))
            cx1 = int(round(x0 + (c + 1) * cell_w))
            cell = img_gray[cy0:cy1, cx0:cx1]
            cells[r][c] = cv2.resize(
                cell, (CELL_SIZE, CELL_SIZE), interpolation=cv2.INTER_AREA
            )
    return cells


# ─────────────────────────── фичи и шаблоны ────────────────────────────────


def _open_mask(cell: np.ndarray, ksize: int) -> np.ndarray:
    """Бинаризация (порог 128) + морф-открытие квадратным ядром ksize×ksize.

    После открытия исчезают тонкие линии (диагональная штриховка тёмных клеток
    толщиной ≤ ksize-1 пикселей). Полные силуэты чёрных фигур остаются.
    """
    _, bw = cv2.threshold(cell, 128, 255, cv2.THRESH_BINARY_INV)
    kernel = np.ones((ksize, ksize), np.uint8)
    return cv2.morphologyEx(bw, cv2.MORPH_OPEN, kernel)


def _count_top_peaks(cell: np.ndarray) -> int:
    """Сколько отдельных «зубцов» в верхней 1/6 части силуэта фигуры (mask 3×3).

    Используется для разрешения путаницы между чёрным королём (один пик —
    крест) и чёрной ферзью (несколько прядок короны).

    Эмпирические значения:
      - чёрный король (k): 1 пик стабильно;
      - чёрная ферзь (q): 6–9 пиков;
      - граница 3 пика разделяет уверенно.
    """
    mask = _open_mask(cell, 3)
    ys, xs = np.where(mask > 0)
    if len(ys) == 0:
        return 0
    y0, y1 = int(ys.min()), int(ys.max())
    x0, x1 = int(xs.min()), int(xs.max())
    height = y1 - y0 + 1
    strip_h = max(3, height // 6)
    top_strip = mask[y0:y0 + strip_h, x0:x1 + 1]
    nlabels, _ = cv2.connectedComponents(top_strip, connectivity=8)
    return nlabels - 1


def _solid_white_central(cell: np.ndarray) -> int:
    """Площадь «белых островков» в центральной зоне 30×30 (макс 900).

    Прямой порог 128 (белые пиксели) → морф-открытие 3×3 → подсчёт белых
    пикселей в центральной зоне 30×30 пикселей.

    Эмпирическое распределение по 6 проверенным диаграммам:
      - пустая светлая клетка: 900 (вся зона белая);
      - пустая тёмная клетка: 0–70 (между диагональной штриховкой нет
        сплошных белых блоков 3×3);
      - чёрная фигура (на любом фоне): 32–391 (заливной силуэт прячет
        большую часть белого);
      - белая фигура (на любом фоне): 146–648 (полый внутренний контур
        даёт значимое поле белого).

    Безопасные пороги: ≥ 800 → пусто на светлой; > 150 → белая фигура на
    тёмной (нижняя граница белых 192 vs верхняя граница чёрных 130).
    """
    _, white_bw = cv2.threshold(cell, 128, 255, cv2.THRESH_BINARY)
    solid = cv2.morphologyEx(white_bw, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    return int((solid[10:40, 10:40] > 0).sum())


def _square_is_dark(row: int, col: int, orientation: str = 'white') -> bool:
    """Тёмная клетка: a1 (col=0, ранг=1) → dark. Формула: (file + rank) чётная."""
    if orientation == 'white':
        file_idx = col
        rank_idx = 7 - row
    else:
        file_idx = 7 - col
        rank_idx = row
    return (file_idx + rank_idx) % 2 == 0


def _fen_to_grid(fen_board: str) -> List[List[str]]:
    grid = [['.'] * 8 for _ in range(8)]
    rows = fen_board.split('/')
    if len(rows) != 8:
        raise ValueError(f'invalid FEN board: {fen_board!r}')
    for r, row_str in enumerate(rows):
        c = 0
        for ch in row_str:
            if ch.isdigit():
                c += int(ch)
            else:
                if c >= 8:
                    raise ValueError(f'FEN row overflow: {row_str!r}')
                grid[r][c] = ch
                c += 1
    return grid


def _grid_to_fen(grid: List[List[str]]) -> str:
    out_rows: List[str] = []
    for r in range(8):
        row = ''
        empty = 0
        for c in range(8):
            piece = grid[r][c]
            if piece == '.':
                empty += 1
            else:
                if empty:
                    row += str(empty)
                    empty = 0
                row += piece
        if empty:
            row += str(empty)
        out_rows.append(row)
    return '/'.join(out_rows)


def _extract_templates_from_image(
    image_path: str, fen_board: str
) -> Dict[Tuple[str, str], List[np.ndarray]]:
    """Извлечь все возможные (piece, bg) → list[mask] из одной размеченной картинки."""
    img = cv2.imread(image_path, cv2.IMREAD_GRAYSCALE)
    if img is None:
        raise FileNotFoundError(f'reference image not readable: {image_path}')
    bbox = _find_board_inner_bbox(img)
    if bbox is None:
        raise RuntimeError(f'cannot locate board frame in reference: {image_path}')
    cells = _slice_cells(img, bbox)
    grid = _fen_to_grid(fen_board)
    out: Dict[Tuple[str, str], List[np.ndarray]] = {}
    for r in range(8):
        for c in range(8):
            piece = grid[r][c]
            if piece == '.':
                continue
            bg = 'd' if _square_is_dark(r, c) else 'l'
            out.setdefault((piece, bg), []).append(_open_mask(cells[r][c], 3))
    return out


# Стандартный набор шаблонных диаграмм Майзелиса. Каждая — путь относительно
# каталога templates/, и FEN-доска (без статуса side-to-move).
DEFAULT_TEMPLATE_SOURCES: List[Tuple[str, str]] = [
    # Начальная позиция (id0): покрывает все 6 типов фигур обоих цветов.
    ('maizelis_start.jpg', START_FEN_BOARD),
    # Маты диаграммы 9 (id14, гл. 1): даёт чёрного ферзя на тёмной (f2),
    # белого короля на тёмной (c1) с лучшей выборкой по сравнению с id0.
    ('maizelis_mate_ch1.jpg', 'Q3k3/7R/8/8/1n4p1/1b6/1Pp2q1P/2K5'),
    # Мат ладьёй из главы 2 (id39): чёрный король на тёмной (h8) и белый
    # король на светлой (h1) — другой стиль изображения, нужный для
    # надёжного распознавания диаграмм-окончаний.
    ('maizelis_mate_ch2.jpg', '7k/8/8/8/8/8/8/R6K'),
]


# ─────────────────────────── Профили распознавателя (KS-2132) ──────────────


@dataclass(frozen=True)
class Profile:
    """Конфигурация распознавателя под конкретный шрифт диаграмм.

    KS-2028 ввёл единственный профиль Майзелиса (вшитые константы и список
    шаблонов в `recognizer.py`). KS-2132 добавляет профиль Дворецкого
    (Russian Chess House) — у него своя плотность диагональной штриховки
    тёмных клеток и другой шрифт фигур, поэтому пороги «пусто/фигура» и
    набор шаблонов отличаются.

    Атрибуты:
        name — короткий идентификатор для CLI (`maizelis`, `dvoretsky`).
        templates_subdir — подкаталог в `src/templates/<name>` (по умолчанию
            совпадает с `name`). Для совместимости профиль `maizelis`
            хранит шаблоны прямо в `src/templates/` (subdir = '').
        template_sources — список (basename, fen-board) внутри подкаталога.
        color_mass5_threshold — cm5 ≥ N → чёрная фигура.
        solid_white_dark_piece — sw > N на тёмной клетке → белая фигура.
        solid_white_light_empty — sw ≥ N на светлой клетке → пусто.
        low_confidence_threshold — NCC ниже — клетка попадает в
            `low_confidence_cells` (диагностика).
    """

    name: str
    template_sources: List[Tuple[str, str]] = field(default_factory=list)
    templates_subdir: str = ''
    color_mass5_threshold: int = COLOR_MASS5_THRESHOLD
    solid_white_dark_piece: int = SOLID_WHITE_DARK_PIECE
    solid_white_light_empty: int = SOLID_WHITE_LIGHT_EMPTY
    low_confidence_threshold: float = LOW_CONFIDENCE_THRESHOLD


MAIZELIS_PROFILE = Profile(
    name='maizelis',
    template_sources=list(DEFAULT_TEMPLATE_SOURCES),
    templates_subdir='',
)

# KS-2132. Заглушка профиля Дворецкого. Шаблоны и пороги будут добавлены,
# когда content пришлёт верифицированные FEN с фигурами Q/R/B/N (см.
# `src/templates/dvoretsky/`). Пока пороги — копия Майзелиса; на пешечных
# эндшпилях из главы 1 это даёт ложноположительные пешки на пустых тёмных
# клетках (известное ограничение, см. README §«Профиль Дворецкого»).
DVORETSKY_PROFILE = Profile(
    name='dvoretsky',
    template_sources=[],
    templates_subdir='dvoretsky',
)


PROFILES: Dict[str, Profile] = {
    MAIZELIS_PROFILE.name: MAIZELIS_PROFILE,
    DVORETSKY_PROFILE.name: DVORETSKY_PROFILE,
}


def resolve_profile(name: str) -> Profile:
    """Получить профиль по имени или поднять `ValueError` со списком известных."""
    if name not in PROFILES:
        known = ', '.join(sorted(PROFILES))
        raise ValueError(f'unknown profile {name!r}; known: {known}')
    return PROFILES[name]


def build_templates(
    reference_image_path: Optional[str] = None,
    fen_board: Optional[str] = None,
    *,
    extra_sources: Optional[List[Tuple[str, str]]] = None,
    profile: Optional[Profile] = None,
) -> Dict[Tuple[str, str], List[np.ndarray]]:
    """Собрать словарь шаблонов (piece, bg) → list[mask].

    Без аргументов используется профиль Майзелиса (3 встроенных шаблона).
    Способы переопределить:
      - `profile=DVORETSKY_PROFILE` — взять список шаблонов из профиля;
        сами картинки лежат в `src/templates/<profile.templates_subdir>/`.
      - `reference_image_path` + `fen_board` → одна картинка (legacy-вызов
        с одним источником, перебивает профиль).
      - `extra_sources` → дополнительные пары (path, fen) сверху.

    Для каждой (piece, bg)-пары хранится список масок: при матчинге берём
    максимум по NCC.

    Если в итоговом словаре для какого-то (piece, bg) шаблонов нет, но
    есть на противоположном фоне, копия проставляется автоматически —
    морф-открытие 3×3 практически не зависит от фона, поэтому это
    безопасно.
    """
    sources: List[Tuple[str, str]] = []
    templates_root = os.path.join(
        os.path.dirname(os.path.abspath(__file__)), '..', 'templates'
    )
    if reference_image_path is not None:
        if fen_board is None:
            fen_board = START_FEN_BOARD
        sources.append((reference_image_path, fen_board))
    else:
        prof = profile if profile is not None else MAIZELIS_PROFILE
        templates_dir = os.path.join(templates_root, prof.templates_subdir) \
            if prof.templates_subdir else templates_root
        sources.extend(
            (os.path.join(templates_dir, rel), fen)
            for rel, fen in prof.template_sources
        )
    if extra_sources:
        sources.extend(extra_sources)

    templates: Dict[Tuple[str, str], List[np.ndarray]] = {}
    for path, fen in sources:
        try:
            extracted = _extract_templates_from_image(path, fen)
        except FileNotFoundError:
            # Источник не найден — пропускаем (например, в тестах подменяют пути).
            continue
        for key, masks in extracted.items():
            templates.setdefault(key, []).extend(masks)

    # Если для какого-то (piece, bg) шаблонов всё ещё нет — клонируем с
    # противоположного фона (морф-открытие 3×3 убирает штриховку, маска
    # практически не зависит от фона).
    for piece in 'rnbqkpRNBQKP':
        for bg in ('l', 'd'):
            if (piece, bg) not in templates:
                other = 'd' if bg == 'l' else 'l'
                if (piece, other) in templates:
                    templates[(piece, bg)] = list(templates[(piece, other)])

    return templates


# ─────────────────────────── классификация ─────────────────────────────────


class Recognizer:
    """Классификатор клеток на основе словаря шаблонов и профиля порогов.

    `templates` — отображение (piece_char, bg) → список 50×50 масок (uint8).
    При матчинге для каждой кандидатной фигуры считается max(NCC) по всем
    её шаблонам.

    `profile` — `Profile` с порогами «пусто/фигура» и `low_confidence`.
    По умолчанию — `MAIZELIS_PROFILE` (для обратной совместимости с
    KS-2028, где Recognizer создавался как `Recognizer(templates)`).
    """

    def __init__(
        self,
        templates: Dict[Tuple[str, str], List[np.ndarray]],
        profile: Optional[Profile] = None,
    ):
        self.templates = templates
        self.profile = profile if profile is not None else MAIZELIS_PROFILE

    @classmethod
    def from_profile(cls, profile: Profile) -> 'Recognizer':
        """Удобный конструктор: собрать шаблоны для профиля и завернуть в Recognizer."""
        templates = build_templates(profile=profile)
        return cls(templates, profile=profile)

    def classify_cell(
        self,
        cell: np.ndarray,
        bg: str,
    ) -> Tuple[str, float]:
        """Вернуть (piece_char, confidence). piece_char ∈ {'.', 'p','P', …}.

        Многоступенчатый разбор:
          1. Цвет фона известен (bg ∈ {'l','d'}).
          2. Считаем три признака:
             - sw (solid white central) — отличает пустую тёмную клетку от
               белой фигуры на тёмной клетке и пустую светлую от любой
               фигуры на светлой;
             - cm5 — масса после морф-открытия 5×5 (отделяет чёрные фигуры
               от белых и пустых);
             - cm3 — масса после морф-открытия 3×3 (используется как
               вторичная проверка).
          3. Решаем класс (empty/white/black) по жёстким правилам:
             - bg=l, sw ≥ 380 → пусто;
             - bg=d, sw ≤ 5 и cm5 < 350 → пусто;
             - cm5 ≥ 350 → чёрная фигура;
             - иначе → белая фигура.
          4. Для фигур запускаем NCC против шаблонов нужного цвета и фона.
        """
        m3 = _open_mask(cell, 3)
        m5 = _open_mask(cell, 5)
        cm3 = int((m3[8:42, 8:42] > 0).sum())
        cm5 = int((m5[8:42, 8:42] > 0).sum())
        sw = _solid_white_central(cell)

        prof = self.profile

        # Шаг 1: по sw отделяем пустоту/белую фигуру от чёрной фигуры/смеси.
        if bg == 'l':
            if sw >= prof.solid_white_light_empty:
                return '.', 1.0
            # На светлой клетке пусто = «всё белое». Любое снижение sw —
            # значит, в центре есть тёмные пиксели, т. е. есть фигура.
            is_black = cm5 >= prof.color_mass5_threshold
        else:  # bg == 'd'
            if sw > prof.solid_white_dark_piece:
                # Белая фигура на тёмной клетке — внутренние просветы видны.
                is_black = False
            else:
                # Либо пусто, либо чёрная фигура. Различаем по cm5.
                if cm5 < prof.color_mass5_threshold:
                    return '.', 1.0
                is_black = True

        # NCC внутри (color, bg) — для каждой (piece, bg) пары пробуем ВСЕ
        # её шаблоны и берём максимальный NCC. Это компенсирует расхождения
        # стиля рисунков между главами книги (король главы 1 ≠ король главы 2).
        m3_f = m3.astype(np.float32)
        scores: Dict[str, float] = {}
        for (piece, tpl_bg), masks in self.templates.items():
            if tpl_bg != bg:
                continue
            if (is_black) != piece.islower():
                continue
            best_for_piece = -2.0
            for tpl in masks:
                score = float(
                    cv2.matchTemplate(m3_f, tpl.astype(np.float32), cv2.TM_CCOEFF_NORMED)[0, 0]
                )
                if score > best_for_piece:
                    best_for_piece = score
            scores[piece] = best_for_piece
        if not scores:
            return '?', 0.0
        best_piece = max(scores, key=lambda p: scores[p])
        best_score = scores[best_piece]

        # Тонкая эвристика k↔q (только для чёрных фигур): когда top-1 и top-2
        # NCC отличаются мало (< 0.1), пробуем выбрать по числу «зубцов»
        # верхушки силуэта — у короля 1–2, у ферзя ≥ 3.
        if is_black and best_piece in ('k', 'q'):
            other = 'q' if best_piece == 'k' else 'k'
            if other in scores and abs(scores[best_piece] - scores[other]) < 0.10:
                peaks = _count_top_peaks(cell)
                if best_piece == 'k' and peaks >= 3:
                    best_piece, best_score = 'q', scores['q']
                elif best_piece == 'q' and peaks <= 2:
                    best_piece, best_score = 'k', scores['k']

        return best_piece, best_score

    def recognize(
        self,
        image_path: str,
        orientation: str = 'white',
    ) -> Dict[str, object]:
        """Распознать диаграмму. Возвращает dict с FEN и диагностикой."""
        img = cv2.imread(image_path, cv2.IMREAD_GRAYSCALE)
        if img is None:
            raise FileNotFoundError(f'image not readable: {image_path}')
        bbox = _find_board_inner_bbox(img)
        if bbox is None:
            raise RuntimeError(
                f'cannot locate board frame in {image_path}; '
                'is this a Maizelis-style chess diagram?'
            )
        cells = _slice_cells(img, bbox)
        grid: List[List[str]] = [['.'] * 8 for _ in range(8)]
        cell_diag: List[Dict[str, object]] = []
        low_conf: List[Dict[str, object]] = []
        for r in range(8):
            for c in range(8):
                bg = 'd' if _square_is_dark(r, c, orientation) else 'l'
                piece, score = self.classify_cell(cells[r][c], bg)
                grid[r][c] = piece
                cell_diag.append({
                    'row': r,
                    'col': c,
                    'square': _algebraic_square(r, c, orientation),
                    'bg': bg,
                    'piece': piece,
                    'confidence': round(score, 4),
                })
                if piece != '.' and score < self.profile.low_confidence_threshold:
                    low_conf.append(cell_diag[-1])
        fen_board = _grid_to_fen(grid)
        return {
            'fen': f'{fen_board} w - - 0 1',
            'fen_board': fen_board,
            'orientation': orientation,
            'bbox': list(bbox),
            'profile': self.profile.name,
            'low_confidence_cells': low_conf,
            'cells': cell_diag,
        }


def _algebraic_square(row: int, col: int, orientation: str) -> str:
    if orientation == 'white':
        file_idx = col
        rank_idx = 7 - row
    else:
        file_idx = 7 - col
        rank_idx = row
    return f"{chr(ord('a') + file_idx)}{rank_idx + 1}"


# ─────────────────────────── Мульти-диаграммный pre-step (KS-2132) ─────────


def find_diagrams_on_page(
    image_path: str,
    *,
    min_size: int = 280,
    max_size: int = 600,
    aspect_tol: float = 0.15,
    pad: int = 4,
    dilate_iter: int = 1,
) -> List[Dict[str, object]]:
    """Найти все шахматные доски на странице книги (KS-2132).

    Полные страницы Дворецкого содержат 1–4 диаграммы вперемешку с текстом и
    подписями (`1.7`, `?`, `1-6`). Существующий `_find_board_inner_bbox`
    рассчитан на одну изолированную доску и не справится со страницей
    целиком. Этот pre-step вычленяет квадратные кандидаты по внешним
    контурам после лёгкой дилатации (склеить пунктирные рамки), фильтрует
    их по размеру и aspect-ratio.

    Возвращает список словарей `{ "index", "bbox": [x0, y0, x1, y1] }`,
    отсортированных в порядке чтения (сверху вниз, слева направо). bbox
    включает `pad` пикселей с каждой стороны, чтобы существующий
    `_find_board_inner_bbox` потом успешно находил рамку внутри кропа.

    Замечание про диаграммы без рамки (страница 9, 1.1): такие доски этот
    pre-step может пропустить — внешняя линия рамки слишком тонкая или
    отсутствует. Это известное ограничение профиля Дворецкого; в README
    рекомендуется для них вырезать кроп вручную и подавать прямо в
    `recognize`.
    """
    img = cv2.imread(image_path, cv2.IMREAD_GRAYSCALE)
    if img is None:
        raise FileNotFoundError(f'image not readable: {image_path}')
    h_img, w_img = img.shape
    _, thresh = cv2.threshold(img, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    if dilate_iter > 0:
        thresh = cv2.dilate(thresh, np.ones((3, 3), np.uint8), iterations=dilate_iter)
    contours, _ = cv2.findContours(thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    boxes: List[Tuple[int, int, int, int]] = []
    for c in contours:
        x, y, w, h = cv2.boundingRect(c)
        if not (min_size < w < max_size and min_size < h < max_size):
            continue
        if abs(w - h) / max(w, h) > aspect_tol:
            continue
        boxes.append((x, y, w, h))

    # Дедупликация: контур может содержать вложенные дубли (рамка + первый
    # ряд клеток). Считаем дубликаты по близости центра.
    boxes.sort(key=lambda b: (b[1], b[0]))
    deduped: List[Tuple[int, int, int, int]] = []
    for b in boxes:
        cx, cy = b[0] + b[2] // 2, b[1] + b[3] // 2
        is_dup = False
        for d in deduped:
            dcx, dcy = d[0] + d[2] // 2, d[1] + d[3] // 2
            if abs(dcx - cx) < 50 and abs(dcy - cy) < 50:
                is_dup = True
                break
        if not is_dup:
            deduped.append(b)

    out: List[Dict[str, object]] = []
    for idx, (x, y, w, h) in enumerate(deduped):
        x0 = max(0, x - pad)
        y0 = max(0, y - pad)
        x1 = min(w_img, x + w + pad)
        y1 = min(h_img, y + h + pad)
        out.append({'index': idx, 'bbox': [x0, y0, x1, y1]})
    return out


# ─────────────────────────── CLI ──────────────────────────────────────────


def main(argv: Optional[Iterable[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        prog='board-image-to-fen',
        description='Распознать шахматную диаграмму в FEN '
                    '(профили Майзелиса и Дворецкого).',
    )
    parser.add_argument('image', help='путь к картинке диаграммы (jpg/png)')
    parser.add_argument(
        '--orientation', choices=('white', 'black'), default='white',
        help='ориентация доски: чьи фигуры внизу (по умолчанию white).',
    )
    parser.add_argument(
        '--json', action='store_true',
        help='вывести подробный JSON-результат в stdout, иначе только FEN.',
    )
    parser.add_argument(
        '--templates', default=None,
        help='путь к эталонной картинке начальной позиции для шаблонов; '
             'по умолчанию используется встроенный набор профиля.',
    )
    parser.add_argument(
        '--profile', choices=tuple(sorted(PROFILES)), default='maizelis',
        help='профиль шрифта диаграмм: `maizelis` (KS-2028) или `dvoretsky` '
             '(KS-2132, Russian Chess House). По умолчанию `maizelis`.',
    )
    parser.add_argument(
        '--scan-page', action='store_true',
        help='не распознавать саму доску, а вернуть JSON со списком найденных '
             'на странице досок (bbox-ов). Для книжных страниц с 1–4 диаграммами.',
    )
    args = parser.parse_args(list(argv) if argv is not None else None)

    if args.scan_page:
        try:
            diagrams = find_diagrams_on_page(args.image)
        except (FileNotFoundError, RuntimeError, ValueError) as exc:
            print(f'error: {exc}', file=sys.stderr)
            return 1
        print(json.dumps({'diagrams': diagrams}, ensure_ascii=False, indent=2))
        return 0

    try:
        profile = resolve_profile(args.profile)
        if args.templates:
            templates = build_templates(args.templates, profile=profile)
        else:
            templates = build_templates(profile=profile)
        recognizer = Recognizer(templates, profile=profile)
        result = recognizer.recognize(args.image, orientation=args.orientation)
    except (FileNotFoundError, RuntimeError, ValueError) as exc:
        print(f'error: {exc}', file=sys.stderr)
        return 1

    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(result['fen'])
        if result['low_confidence_cells']:
            print(
                f'warning: {len(result["low_confidence_cells"])} cells with low '
                f'confidence (< {recognizer.profile.low_confidence_threshold}):',
                file=sys.stderr,
            )
            for cell in result['low_confidence_cells']:
                print(
                    f'  {cell["square"]} (row={cell["row"]} col={cell["col"]}) '
                    f'piece={cell["piece"]} conf={cell["confidence"]}',
                    file=sys.stderr,
                )
    return 0


if __name__ == '__main__':
    sys.exit(main())
