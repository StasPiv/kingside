#!/usr/bin/env python3
"""KS-2045 Этап 1 — экстрактор PDF → JSON AST.

Парсит PDF (через PyMuPDF), извлекает текст и диаграммы Chess-Merida в
порядке чтения. Выдаёт JSON AST со структурой:

  {
    "pageRange": [N, M],
    "blocks": [
      {"kind": "heading", "level": 1|2|3, "text": "...", "page": N, "bbox": [...]},
      {"kind": "prose",   "text": "...",  "page": N, "bbox": [...]},
      {"kind": "diagram", "fen": "...",   "page": N, "diagramIndex": K, "bbox": [...]}
    ]
  }

Reading-order: сортировка блоков по (column, y0). Колонка определяется по
центру bbox: x_center < page_mid → колонка 0 (левая), иначе колонка 1
(правая). Диаграммы переиспользуют логику из
`packages/board-image-to-fen/src/python/pdf_recognizer.py`.

Heuristic-определение заголовков:
  - Шрифт содержит маркер «Demi» (Демиболд) или «Bold».
  - И/или размер шрифта на 1.5pt+ больше медианы prose-spans на странице.
  - И/или текст матчит паттерн `^(?:Глава\\s+\\w+|§\\s*\\d+|\\d+\\.\\s+\\S+)`.

CLI:

    python3 extract_pdf.py <input.pdf> --page-start N --page-end M [--json-out path]

Обязательно: --page-start и --page-end (1-indexed, включительно).
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from typing import Dict, List, Optional, Tuple

# Переиспользуем pdf_recognizer из соседнего пакета.
_BOARD_PKG_DIR = os.path.normpath(
    os.path.join(
        os.path.dirname(os.path.abspath(__file__)),
        '..', '..', '..', 'board-image-to-fen', 'src', 'python',
    )
)
if _BOARD_PKG_DIR not in sys.path:
    sys.path.insert(0, _BOARD_PKG_DIR)
import pdf_recognizer  # noqa: E402  — путь зависит от sys.path выше


# ─── маркеры заголовков ──────────────────────────────────────────────────
#
# Калиниченко 2016: «Глава 1», «§1», «1. Игра», «### 1. Игра» — Stage 1
# использует pure-text эвристики, без анализа структуры stylesheet'а PDF.
HEADING_PATTERNS = [
    re.compile(r'^Часть\s+[IVXLCDM]+'),                      # «Часть I»
    re.compile(r'^Глава\s+\d+'),                              # «Глава 1»
    re.compile(r'^§\s*\d+'),                                  # «§1», «§ 1»
    re.compile(r'^\d+\.\s+\S'),                               # «1. Игра»
]

CHESS_FONT_MARKER = 'Chess-Merida'
DEMI_BOLD_MARKERS = ('Demi', 'Bold', 'Black')


def _first_line_first_span(block: dict) -> Optional[dict]:
    """Первый span первой строки блока (для определения шрифта/размера)."""
    for line in block.get('lines', []):
        for span in line.get('spans', []):
            return span
    return None


def _block_text(block: dict) -> str:
    """Конкатенация всех spans блока, переводы строк между line'ами."""
    out_lines: List[str] = []
    for line in block.get('lines', []):
        text = ''.join(s.get('text', '') for s in line.get('spans', []))
        if text:
            out_lines.append(text)
    return '\n'.join(out_lines)


def _block_dominant_font_size(block: dict) -> float:
    """Самый частый размер шрифта в блоке (round to 0.5)."""
    sizes: Dict[float, int] = {}
    for line in block.get('lines', []):
        for span in line.get('spans', []):
            s = round(float(span.get('size', 0.0)) * 2) / 2
            sizes[s] = sizes.get(s, 0) + 1
    if not sizes:
        return 0.0
    return max(sizes, key=sizes.get)


def _is_chess_font(span_or_block) -> bool:
    """Поддерживает span (`{font: ...}`) и block (с проходом по spans)."""
    if isinstance(span_or_block, dict) and 'font' in span_or_block:
        return CHESS_FONT_MARKER in (span_or_block.get('font') or '')
    if isinstance(span_or_block, dict) and 'lines' in span_or_block:
        for line in span_or_block.get('lines', []):
            for span in line.get('spans', []):
                if CHESS_FONT_MARKER in (span.get('font') or ''):
                    return True
    return False


def _heading_level(block: dict, page_median_size: float) -> Optional[int]:
    """Если блок похож на заголовок — вернуть level (1=главный, 2/3=под).
    Иначе None.

    Эвристики:
      level 1: размер шрифта значительно больше prose И/ИЛИ текст
        начинается с «Часть»/«Глава».
      level 2: размер чуть больше prose, либо bold, либо матчит «§N»/«N.».
      level 3: bold-средний размер, не подходит под выше.
    """
    span = _first_line_first_span(block)
    if span is None:
        return None
    font = span.get('font', '') or ''
    size = float(span.get('size', 0.0))
    text = _block_text(block).strip()
    if not text:
        return None
    is_bold = any(m in font for m in DEMI_BOLD_MARKERS)

    # «Часть I» / «Глава 1» — почти всегда самый верхний level.
    if HEADING_PATTERNS[0].match(text) or HEADING_PATTERNS[1].match(text):
        return 1
    # Параграф «§N» — level 2 (точнее чем bold-эвристика).
    if HEADING_PATTERNS[2].match(text):
        return 2
    # Bold + крупнее prose → подзаголовок.
    if is_bold and page_median_size > 0 and size >= page_median_size + 1.0:
        return 2
    # Крупнее prose (но не bold) — все ещё подзаголовок-кандидат.
    if page_median_size > 0 and size >= page_median_size + 2.0:
        return 2
    # Bold + матчит «N. Слово» — level 3 (раздел).
    if is_bold and HEADING_PATTERNS[3].match(text):
        return 3
    # Bold-инлайн в начале prose — не отдельный заголовок (мы оценили
    # только первый span). Пропускаем.
    return None


def _column_of(bbox: Tuple[float, float, float, float], page_mid_x: float) -> int:
    """Колонка блока: 0 — левая, 1 — правая. По центру bbox по X."""
    cx = (bbox[0] + bbox[2]) / 2.0
    return 0 if cx < page_mid_x else 1


# ─── Извлечение страницы ──────────────────────────────────────────────────


def _extract_page_blocks(
    page,
    page_idx_zero_based: int,
    diagram_counter: List[int],
) -> List[dict]:
    """Вернуть упорядоченный список AST-блоков из одной страницы.

    Reading-order: сначала по колонке (left first), потом по y0.
    Внутри одного блока сохраняется порядок lines.
    """
    data = page.get_text('dict')
    if not data.get('blocks'):
        return []
    page_w = float(data.get('width', 0)) or float(page.rect.width)
    page_mid_x = page_w / 2.0

    # Найти все Chess-Merida диаграммы на странице (PyMuPDF block-level
    # анализ внутри pdf_recognizer).
    diagrams = pdf_recognizer.find_boards_on_page(page)
    diagram_bboxes = [tuple(d['bbox']) for d in diagrams]

    raw_blocks: List[dict] = []
    for block in data.get('blocks', []):
        if block.get('type') != 0:
            continue  # skip image blocks
        bbox = tuple(block.get('bbox', (0, 0, 0, 0)))
        # Если блок целиком — диаграмма Chess-Merida, выведем как «diagram»
        # (а не prose с PUA-глифами).
        if _is_chess_font(block) and any(_bbox_overlaps(bbox, db) for db in diagram_bboxes):
            continue  # обработаем все диаграммы отдельно ниже
        raw_blocks.append(block)

    # Отсортировать по reading-order: (column, y0, x0).
    raw_blocks.sort(key=lambda b: (
        _column_of(b['bbox'], page_mid_x),
        round(b['bbox'][1] / 5),
        b['bbox'][0],
    ))

    # Медиана размера prose на странице.
    sizes = []
    for b in raw_blocks:
        s = _block_dominant_font_size(b)
        if s > 0:
            sizes.append(s)
    page_median_size = sorted(sizes)[len(sizes) // 2] if sizes else 11.0

    out: List[dict] = []
    for block in raw_blocks:
        text = _block_text(block).strip()
        if not text:
            continue
        # Skip Chess-Merida-residue (например, inline-нотация «Лa1-a7» с
        # глифом фигуры в Chess-Merida) — Stage 1 не разбирает inline-нотацию,
        # просто пропускаем. Иначе бы в bodyMarkdown попадали мусорные
        # PUA-символы.
        if _block_is_pure_chess_glyphs(block):
            continue
        level = _heading_level(block, page_median_size)
        if level is not None:
            out.append({
                'kind': 'heading',
                'level': level,
                'text': text,
                'page': page_idx_zero_based + 1,
                'bbox': list(block['bbox']),
            })
        else:
            out.append({
                'kind': 'prose',
                'text': text,
                'page': page_idx_zero_based + 1,
                'bbox': list(block['bbox']),
            })

    # Вставить диаграммы в reading-order (по той же сортировке column/y).
    for d in diagrams:
        diagram_counter[0] += 1
        out.append({
            'kind': 'diagram',
            'fen_board': d['fen_board'],
            'fen': f"{d['fen_board']} w - - 0 1",
            'page': page_idx_zero_based + 1,
            'diagramIndex': diagram_counter[0],  # глобальный (по всему диапазону)
            'bbox': list(d['bbox']),
        })
    out.sort(key=lambda b: (
        _column_of(tuple(b['bbox']), page_mid_x),
        round(b['bbox'][1] / 5),
        b['bbox'][0],
    ))
    return out


def _bbox_overlaps(a: Tuple[float, float, float, float], b: Tuple[float, float, float, float]) -> bool:
    """Быстрая проверка пересечения bbox'ов с эпсилоном."""
    eps = 1.0
    return not (
        a[2] < b[0] - eps
        or a[0] > b[2] + eps
        or a[3] < b[1] - eps
        or a[1] > b[3] + eps
    )


def _block_is_pure_chess_glyphs(block: dict) -> bool:
    """Все spans в блоке принадлежат Chess-Merida-шрифту.

    Используется для отброса inline-нотации (long-algebraic с глифами фигур),
    которая на Этапе 1 не разбирается. На Этапе 2 нужен будет маппинг
    кодпойнтов (см. KS-2045 ADR §1.2).
    """
    has_any_span = False
    for line in block.get('lines', []):
        for span in line.get('spans', []):
            has_any_span = True
            if not _is_chess_font(span):
                return False
    return has_any_span


# ─── Высокоуровневый extract ──────────────────────────────────────────────


def extract_pdf(pdf_path: str, page_start: int, page_end: int) -> dict:
    """Прогнать PyMuPDF по диапазону страниц, собрать AST."""
    doc = pdf_recognizer._open_pdf(pdf_path)
    try:
        if page_start < 1 or page_end < page_start or page_end > doc.page_count:
            raise ValueError(
                f'invalid page-range {page_start}..{page_end} (PDF has {doc.page_count} pages)'
            )
        diagram_counter = [0]
        all_blocks: List[dict] = []
        for pi in range(page_start - 1, page_end):
            page = doc[pi]
            page_blocks = _extract_page_blocks(page, pi, diagram_counter)
            all_blocks.extend(page_blocks)
        return {
            'pageRange': [page_start, page_end],
            'blocks': all_blocks,
        }
    finally:
        doc.close()


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        prog='extract_pdf',
        description='KS-2045 Этап 1 — extractor PDF → JSON AST.',
    )
    parser.add_argument('pdf', help='путь к PDF-файлу')
    parser.add_argument('--page-start', type=int, required=True,
                        help='первая страница диапазона (1-indexed, inclusive)')
    parser.add_argument('--page-end', type=int, required=True,
                        help='последняя страница диапазона (1-indexed, inclusive)')
    parser.add_argument('--json-out', default=None,
                        help='путь для записи JSON; по умолчанию stdout')
    args = parser.parse_args(argv)

    try:
        ast = extract_pdf(args.pdf, args.page_start, args.page_end)
    except (FileNotFoundError, RuntimeError, ValueError) as exc:
        print(f'error: {exc}', file=sys.stderr)
        return 1
    out = json.dumps(ast, ensure_ascii=False, indent=2)
    if args.json_out:
        with open(args.json_out, 'w', encoding='utf-8') as f:
            f.write(out)
    else:
        print(out)
    return 0


if __name__ == '__main__':
    sys.exit(main())
