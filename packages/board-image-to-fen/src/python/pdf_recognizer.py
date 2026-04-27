#!/usr/bin/env python3
"""KS-2030 board-image-to-fen — PDF-путь для диаграмм на шрифте Chess-Merida-Regular.

Источник: книги Калиниченко (изд. «Шахматы. Классики», 2016 и др.), где диаграммы
набраны не растром, а фигурным шрифтом `Chess-Merida-Regular`. Каждая диаграмма
— текстовый блок 10×10 глифов (0xF021..0xF077, Private Use Area):

  строка 0:    0xF021 0xF022×8 0xF023               — верхняя рамка
  строки 1..8: 0xF024 <8 глифов клеток> 0xF025      — ряды доски, сверху вниз
                                                       (соответствует ранг 8 → ранг 1)
  строка 9:    0xF02F 0xF028×8 0xF029               — нижняя рамка

Кодпойнт→FEN-символ берётся из `PIECE_MAP` ниже. У каждой фигуры два
глифа — для светлой и тёмной клетки соответственно — оба сводятся к
одному FEN-символу (цвет заложен в сам кодпойнт, фон в FEN не нужен).
В отличие от растрового пути (`recognizer.py`), этот путь
детерминированный: ни OpenCV, ни шаблонов не требует.

CLI:

    python3 pdf_recognizer.py <input.pdf> [--page N | --all-pages]
                              [--orientation white|black] [--json]

Без `--json` печатает по строке `page=N: <fen>` (и `page=N diagram=K: <fen>`,
если на странице несколько досок). С `--json` — массив объектов с полями
`page`, `diagram`, `fen`, `fen_board`, `orientation`, `bbox`.
"""

from __future__ import annotations

import argparse
import json
import sys
from typing import Iterable, List, Optional, Tuple

# fitz импортируется в `_open_pdf` — на случай вызова `--help` без установленного
# PyMuPDF мы хотим увидеть нормальный help, а не ImportError.


# ─── маппинг кодпойнтов Chess-Merida-Regular → FEN-символ ──────────────────
#
# Ключ — младший байт кодпойнта (codepoint - 0xF000). У каждой фигуры два
# глифа: светлая и тёмная клетка дают одинаковый FEN-символ. Заглавная
# буква = белая фигура, строчная = чёрная (FEN-конвенция).
PIECE_MAP = {
    # пустые клетки
    0x20: '.', 0x2B: '.',
    # белые
    0x50: 'P', 0x70: 'P',
    0x52: 'R', 0x72: 'R',
    0x4E: 'N', 0x6E: 'N',
    0x42: 'B', 0x62: 'B',
    0x51: 'Q', 0x71: 'Q',
    0x4B: 'K', 0x6B: 'K',
    # чёрные (нестандартные ASCII-буквы O/T/M/V/W/L)
    0x4F: 'p', 0x6F: 'p',
    0x54: 'r', 0x74: 'r',
    0x4D: 'n', 0x6D: 'n',
    0x56: 'b', 0x76: 'b',
    0x57: 'q', 0x77: 'q',
    0x4C: 'k', 0x6C: 'k',
}

CHESS_FONT_MARKER = 'Chess-Merida'  # совпадает с `Chess-Merida-Regular`,
                                    # `Chess-Merida-Bold` и т. п. при наличии вариантов.


# ─── декодирование одной диаграммы ─────────────────────────────────────────


def _line_text(line: dict) -> str:
    """Слепить текст всех спанов одной строки в порядке их появления."""
    return ''.join(s.get('text', '') for s in line.get('spans', []))


def _line_font(line: dict) -> str:
    spans = line.get('spans', [])
    return spans[0].get('font', '') if spans else ''


def _is_top_frame(cps: List[int]) -> bool:
    return (
        len(cps) == 10
        and cps[0] == 0xF021
        and all(cps[i] == 0xF022 for i in range(1, 9))
        and cps[9] == 0xF023
    )


def _is_bottom_frame(cps: List[int]) -> bool:
    return (
        len(cps) == 10
        and cps[0] == 0xF02F
        and all(cps[i] == 0xF028 for i in range(1, 9))
        and cps[9] == 0xF029
    )


def _is_board_row(cps: List[int]) -> bool:
    """Сторонние границы ряда (F024 и F025) опознаются жёстко; внутренние
    8 глифов проверяются на принадлежность к диапазону F020..F0FF, не
    больше — конкретные значения распознаются ниже как пустота/фигура."""
    return (
        len(cps) == 10
        and cps[0] == 0xF024
        and cps[9] == 0xF025
        and all(0xF020 <= cps[i] <= 0xF0FF for i in range(1, 9))
    )


def _grid_to_fen(grid: List[List[str]]) -> str:
    rows: List[str] = []
    for r in grid:
        s, empty = '', 0
        for ch in r:
            if ch == '.':
                empty += 1
            else:
                if empty:
                    s += str(empty)
                    empty = 0
                s += ch
        if empty:
            s += str(empty)
        rows.append(s)
    return '/'.join(rows)


def _decode_window(window_lines_cps: List[List[int]]) -> str:
    """Из окна 10 строк × 10 глифов собрать FEN-board.

    Предполагается, что вызывающий уже верифицировал паттерн рамки.
    Неизвестные кодпойнты помечаются `?` — это ловушка для случаев, когда
    шрифт другой или разметка изменилась.
    """
    grid: List[List[str]] = []
    for r in range(1, 9):  # строки 1..8 — игровые ряды
        row_cells = window_lines_cps[r][1:9]  # глифы между F024 и F025
        row: List[str] = []
        for cp in row_cells:
            ascii_code = cp & 0xFF if 0xF000 <= cp <= 0xF0FF else cp
            row.append(PIECE_MAP.get(ascii_code, '?'))
        grid.append(row)
    return _grid_to_fen(grid)


def _apply_orientation(fen_board: str, orientation: str) -> str:
    """Если orientation='black' — перевернуть доску (зеркало по вертикали И горизонтали).

    PDF читает диаграмму сверху вниз как ряды; по умолчанию это уже соответствует
    «белые внизу» (FEN-row 0 = ранг 8). Для 'black' перестраиваем так, чтобы
    нижний ряд изображения стал FEN-row 0.
    """
    if orientation == 'white':
        return fen_board
    rows = fen_board.split('/')
    # Зеркалим: переворот рядов И символов в каждом ряду (но FEN-нотация
    # с числами требует разворачивать через сетку).
    grid_rows: List[List[str]] = []
    for row_str in rows:
        cells: List[str] = []
        for ch in row_str:
            if ch.isdigit():
                cells.extend(['.'] * int(ch))
            else:
                cells.append(ch)
        grid_rows.append(cells)
    rotated = [list(reversed(r)) for r in reversed(grid_rows)]
    return _grid_to_fen(rotated)


def _merge_bbox(bboxes: List[Tuple[float, float, float, float]]) -> List[float]:
    xs0 = min(b[0] for b in bboxes)
    ys0 = min(b[1] for b in bboxes)
    xs1 = max(b[2] for b in bboxes)
    ys1 = max(b[3] for b in bboxes)
    return [xs0, ys0, xs1, ys1]


def find_boards_on_page(page) -> List[dict]:
    """Найти все диаграммы Chess-Merida на странице PDF.

    Возвращает список словарей `{fen_board, bbox}` в порядке чтения
    (сверху вниз, слева направо).
    """
    boards: List[dict] = []
    data = page.get_text('dict')
    for block in data.get('blocks', []):
        if block.get('type') != 0:
            continue
        lines = block.get('lines', [])
        line_records = [
            {
                'text': _line_text(l),
                'font': _line_font(l),
                'bbox': l.get('bbox', (0, 0, 0, 0)),
            }
            for l in lines
        ]
        i = 0
        while i + 10 <= len(line_records):
            window = line_records[i:i + 10]
            if not all(CHESS_FONT_MARKER in r['font'] for r in window):
                i += 1
                continue
            cps_list: List[List[int]] = []
            ok = True
            for r in window:
                if len(r['text']) != 10:
                    ok = False
                    break
                cps_list.append([ord(c) for c in r['text']])
            if not ok:
                i += 1
                continue
            if not _is_top_frame(cps_list[0]):
                i += 1
                continue
            if not _is_bottom_frame(cps_list[9]):
                i += 1
                continue
            if not all(_is_board_row(cps_list[r]) for r in range(1, 9)):
                i += 1
                continue
            fen_board = _decode_window(cps_list)
            bbox = _merge_bbox([tuple(r['bbox']) for r in window])
            boards.append({'fen_board': fen_board, 'bbox': bbox})
            i += 10  # пропускаем уже декодированное окно

    # Сортировка в порядке чтения: y0 (с округлением, чтобы две доски на
    # одной горизонтальной полосе не перепутались), затем x0.
    boards.sort(key=lambda b: (round(b['bbox'][1] / 5), b['bbox'][0]))
    return boards


# ─── PDF-уровень ───────────────────────────────────────────────────────────


def _open_pdf(pdf_path: str):
    try:
        import fitz  # PyMuPDF
    except ImportError as exc:  # pragma: no cover — окруженческая ошибка
        raise RuntimeError(
            'PyMuPDF (fitz) is required for PDF input. Install: apt-get install python3-fitz'
        ) from exc
    return fitz.open(pdf_path)


def recognize_pdf(
    pdf_path: str,
    *,
    page: Optional[int] = None,
    all_pages: bool = False,
    orientation: str = 'white',
) -> List[dict]:
    """Распознать диаграммы Chess-Merida в PDF.

    Если `page` передан — обработать только эту страницу (1-indexed).
    Если `all_pages=True` — обойти все страницы.
    Иначе вернуть пустой список (вызывающий должен указать режим).

    Возвращает список объектов:
      {page, diagram, fen, fen_board, orientation, bbox}
    """
    if page is None and not all_pages:
        raise ValueError('either page=N or all_pages=True must be specified')

    doc = _open_pdf(pdf_path)
    try:
        if page is not None:
            if page < 1 or page > doc.page_count:
                raise ValueError(
                    f'page out of range: {page} (PDF has {doc.page_count} pages)'
                )
            page_indices = [page - 1]
        else:
            page_indices = list(range(doc.page_count))

        results: List[dict] = []
        for pi in page_indices:
            page_obj = doc[pi]
            boards = find_boards_on_page(page_obj)
            for k, b in enumerate(boards):
                fen_board = _apply_orientation(b['fen_board'], orientation)
                results.append({
                    'page': pi + 1,
                    'diagram': k,
                    'fen': f'{fen_board} w - - 0 1',
                    'fen_board': fen_board,
                    'orientation': orientation,
                    'bbox': b['bbox'],
                })
        return results
    finally:
        doc.close()


# ─── CLI ──────────────────────────────────────────────────────────────────


def _format_text_line(item: dict, page_has_multiple: bool) -> str:
    if page_has_multiple:
        return f"page={item['page']} diagram={item['diagram']}: {item['fen_board']}"
    return f"page={item['page']}: {item['fen_board']}"


def main(argv: Optional[Iterable[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        prog='board-image-to-fen-pdf',
        description='Распознать диаграммы Chess-Merida в PDF и вывести FEN.',
    )
    parser.add_argument('pdf', help='путь к PDF-файлу')
    grp = parser.add_mutually_exclusive_group()
    grp.add_argument('--page', type=int, default=None,
                     help='распознать только эту страницу (1-indexed)')
    grp.add_argument('--all-pages', action='store_true',
                     help='обойти все страницы PDF (по умолчанию)')
    parser.add_argument('--orientation', choices=('white', 'black'), default='white',
                        help='ориентация доски: чьи фигуры внизу (по умолчанию white)')
    parser.add_argument('--json', action='store_true',
                        help='вывести JSON-массив вместо текстовых строк')
    args = parser.parse_args(list(argv) if argv is not None else None)

    page = args.page
    all_pages = args.all_pages or page is None  # default — все страницы

    try:
        results = recognize_pdf(
            args.pdf,
            page=page,
            all_pages=all_pages,
            orientation=args.orientation,
        )
    except (FileNotFoundError, RuntimeError, ValueError) as exc:
        print(f'error: {exc}', file=sys.stderr)
        return 1

    if args.json:
        print(json.dumps(results, ensure_ascii=False, indent=2))
        return 0

    if not results:
        print(
            'warning: no Chess-Merida diagrams found',
            file=sys.stderr,
        )
        return 0

    # Пометка `diagram=K` нужна только если на странице нашлось несколько досок.
    per_page_count: dict = {}
    for r in results:
        per_page_count[r['page']] = per_page_count.get(r['page'], 0) + 1
    for r in results:
        print(_format_text_line(r, per_page_count[r['page']] > 1))
    return 0


if __name__ == '__main__':
    sys.exit(main())
