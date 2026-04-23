import {
  loadHtml,
  findSection,
  findDataRows,
  detectColumns,
  extractPlayer,
  parseCellResult,
  type ParseResult,
} from './parser-common';
import type { CrosstablePlayer, CrosstableCell } from '@kingside/shared';

/**
 * Парсер `art=5` для индивидуальных round-robin турниров (KS-1729, A04).
 *
 * Заголовок секции — `<h2>Starting rank crosstable</h2>` (либо
 * `Ranking crosstable …` — chess-results использует оба для разных
 * сортировок; см. ADR-023 §2.1). Структура таблицы `class="CRs1"`:
 *
 *   No. | (Title) | Name | Rtg | FED | 1 | 2 | … | N | Pts. | Rk. | TB1 | …
 *
 * Где колонки `1..N` (N = число игроков) — ячейки матрицы. На диагонали
 * `*`. Содержимое ячейки — `1` / `0` / `½` / `+` / `-` / `K` / `1F` / `0F`
 * / пусто (см. `parseCellResult`). Цвет (white/black) в этой проекции НЕ
 * закодирован — ячейка не содержит CSS-маркера цвета. Возвращаем
 * `color: undefined` в `CrosstableCell` — фронт может вычислить цвет
 * комбинаторно (для round-robin это детерминированно по pairing-table) или
 * не показывать.
 *
 * Возврат:
 *   - `{ ok: true, data: { players, matrix } }` где `matrix[i][j]` — игра
 *     `players[i].rank` против `players[j].rank`. Диагональ `result=null`.
 *   - `{ ok: false, reason }` при h2-несовпадении или сломанной структуре.
 *     Sync-service (A09) при `ok=false` падает на legacy-fallback.
 */

export interface ParseRrCrosstableData {
  players: CrosstablePlayer[];
  matrix: CrosstableCell[][];
}

const H2_PREDICATE = (text: string): boolean =>
  /crosstable/i.test(text);

export function parseRrCrosstable(
  html: string,
): ParseResult<ParseRrCrosstableData> {
  const $ = loadHtml(html);
  const section = findSection($, H2_PREDICATE);
  if (!section) {
    return {
      ok: false,
      reason: 'h2 with "crosstable" not found in any defaultDialog',
    };
  }
  const table = section.find('table.CRs1').first();
  if (!table.length) {
    return { ok: false, reason: 'table.CRs1 not found inside section' };
  }
  const headerRow = table.find('tr.CRg1b, tr.CRng1b').first();
  if (!headerRow.length) {
    return { ok: false, reason: 'header row (CRg1b/CRng1b) not found' };
  }
  const headerCells = headerRow.find('th');
  if (!headerCells.length) {
    return { ok: false, reason: 'no <th> cells in header row' };
  }
  const cols = detectColumns(headerCells);
  if (!cols) {
    return {
      ok: false,
      reason: 'cannot detect required columns (No./Name)',
    };
  }

  // Определяем диапазон player-cells: между fedIdx (или rating, если fed нет)
  // и pointsIdx. Каждая колонка с числовым лейблом 1..N — opponent-rank cell.
  const labels: string[] = [];
  headerCells.each((_, el) => {
    labels.push($(el).text().trim());
  });
  const matrixStart = pickMatrixStart(labels, cols);
  if (matrixStart === null) {
    return { ok: false, reason: 'cannot locate matrix start column' };
  }
  const matrixEnd = pickMatrixEnd(labels, matrixStart);
  if (matrixEnd === null || matrixEnd <= matrixStart) {
    return { ok: false, reason: 'cannot locate matrix end column' };
  }
  const playerCount = matrixEnd - matrixStart;

  // Перебираем data-rows (CRg1/CRg2/CRng1/CRng2, исключая *b — header).
  const dataRows = findDataRows($, table);
  const players: CrosstablePlayer[] = [];
  const matrix: CrosstableCell[][] = [];

  dataRows.each((_, rowEl) => {
    const $row = $(rowEl);
    const cells = $row.find('td');
    if (cells.length < matrixEnd) return; // skip короткие/служебные

    // Извлекаем CrosstableCell[] для этой строки.
    const rowCells: CrosstableCell[] = [];
    let gamesPlayed = 0;
    let pointsCalc = 0;
    for (let j = 0; j < playerCount; j++) {
      const cellText = cells.eq(matrixStart + j).text().trim();
      const parsed = parseCellResult(cellText);
      if (parsed.isDiagonal) {
        rowCells.push({ result: null });
        continue;
      }
      if (parsed.result === null) {
        rowCells.push({ result: null, opponentRank: j + 1 });
        continue;
      }
      gamesPlayed++;
      pointsCalc += parsed.score ?? 0;
      rowCells.push({
        result: parsed.result,
        opponentRank: j + 1,
        // color: undefined — art=5 не несёт цвет.
        gameRef: null,
      });
    }

    const player = extractPlayer($, cells, cols, {
      gamesPlayed,
      // Пользуемся header-Pts. колонкой если есть, иначе считаем по cells.
      points: cols.pointsIdx !== null ? undefined : pointsCalc,
    });
    if (!player) return;
    players.push(player);
    matrix.push(rowCells);
  });

  if (players.length === 0) {
    return { ok: false, reason: 'no data rows parsed' };
  }
  if (players.length !== playerCount) {
    // Мягкое предупреждение: matrix может оказаться не квадратной если
    // chess-results добавил/убрал игрока. Возвращаем что есть.
    // Sync-service логирует и идёт по best-effort пути.
  }

  return { ok: true, data: { players, matrix } };
}

/**
 * Находит индекс первой колонки, где label — целое число (`"1"`, `"2"`, …).
 * Возвращает индекс начала матрицы.
 */
function pickMatrixStart(
  labels: string[],
  cols: ReturnType<typeof detectColumns>,
): number | null {
  if (!cols) return null;
  // Стартуем поиск ПОСЛЕ FED-колонки (или, если её нет, после Rtg / Name).
  let from = (cols.fedIdx ?? cols.ratingIdx ?? cols.nameIdx) + 1;
  for (let i = from; i < labels.length; i++) {
    if (/^\d+$/.test(labels[i])) return i;
  }
  return null;
}

/**
 * Находит индекс первой не-числовой колонки после `start`. Это конец матрицы
 * (за ним идут Pts./Rk./TB1/...).
 */
function pickMatrixEnd(labels: string[], start: number): number | null {
  for (let i = start; i < labels.length; i++) {
    if (!/^\d+$/.test(labels[i])) return i;
  }
  return labels.length;
}
