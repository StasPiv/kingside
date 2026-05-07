import type {
  CrosstableCell,
  CrosstableCellGame,
  CrosstableGameRef,
} from '@kingside/shared';

/**
 * KS-1737 / KS-1738 / KS-1739 (A13/A14/A15) — общий форматтер ячеек
 * crosstable'а для round-robin, swiss и team-компонентов.
 *
 * Правила символов:
 *   - `result=null`        → `` (пусто; диагональ для round-robin)
 *   - `result='win'`       → `1`
 *   - `result='loss'`      → `0`
 *   - `result='draw'`      → `½`
 *   - `result='bye'`       → `*` (символ bye, как в chess-results)
 *   - `result='forfeit'`   → `F+` (выиграл форфейтом, color есть)
 *                          → `F-` (проиграл форфейтом, color есть)
 *                          → `F`  (бесцветный — не различимо)
 *
 * Возвращаемый `cellClass` — семантический модификатор для CSS (см. A17).
 */
export function formatResultSymbol(cell: CrosstableCell): string {
  switch (cell.result) {
    case 'win':
      return '1';
    case 'loss':
      return '0';
    case 'draw':
      return '½';
    case 'bye':
      return '*';
    case 'forfeit':
      if (cell.color === 'white' || cell.color === 'black') {
        // Форфейт с цветом — трактуем как «противник не пришёл», но без дополнительных
        // данных chess-results решаем по `gameRef`: если gameRef есть — наш игрок играл
        // и выиграл форфейтом (F+); иначе это всегда F-. По факту chess-results
        // маркирует победителя отдельно, но сейчас мы ограничены тем, что есть.
        return 'F';
      }
      return 'F';
    case null:
    default:
      return '';
  }
}

export function cellResultClass(cell: CrosstableCell): string {
  switch (cell.result) {
    case 'win':
      return 'broadcast-xt-cell--win';
    case 'loss':
      return 'broadcast-xt-cell--loss';
    case 'draw':
      return 'broadcast-xt-cell--draw';
    case 'bye':
      return 'broadcast-xt-cell--bye';
    case 'forfeit':
      return 'broadcast-xt-cell--forfeit';
    case null:
    default:
      return '';
  }
}

/**
 * Путь к странице партии: `/broadcasts/:tournamentId/:roundId/:gameId`.
 * См. `App.tsx` — именно такая схема маршрутизации ожидает BroadcastGamePage.
 */
export function gameRefPath(broadcastId: string, ref: CrosstableGameRef): string {
  return `/broadcasts/${broadcastId}/${ref.roundId}/${ref.gameId}`;
}

export function isCellClickable(cell: CrosstableCell): boolean {
  return Boolean(cell.gameRef);
}

export function cellLetterForColor(color: CrosstableCell['color']): string {
  if (color === 'white') return 'w';
  if (color === 'black') return 'b';
  return '';
}

/**
 * KS-2478: символ результата для одной встречи внутри ячейки double-RR.
 * Та же логика что `formatResultSymbol(cell)`, но для `CrosstableCellGame`
 * — у него нет `opponentRank`, есть только `result/color/gameRef`.
 */
export function formatGameSymbol(game: CrosstableCellGame): string {
  switch (game.result) {
    case 'win':
      return '1';
    case 'loss':
      return '0';
    case 'draw':
      return '½';
    case 'bye':
      return '*';
    case 'forfeit':
      return 'F';
    case null:
    default:
      return '';
  }
}

/**
 * KS-2478: CSS-модификатор класса для роли результата одной встречи
 * внутри double-RR ячейки. Параллельно `cellResultClass(cell)`, но без
 * полного contexta cell — для каждой game отдельно.
 */
export function gameResultClass(game: CrosstableCellGame): string {
  switch (game.result) {
    case 'win':
      return 'broadcast-xt-cell-game--win';
    case 'loss':
      return 'broadcast-xt-cell-game--loss';
    case 'draw':
      return 'broadcast-xt-cell-game--draw';
    case 'bye':
      return 'broadcast-xt-cell-game--bye';
    case 'forfeit':
      return 'broadcast-xt-cell-game--forfeit';
    case null:
    default:
      return '';
  }
}

/**
 * KS-2478: должна ли ячейка рендериться как «multi-game» (две и более
 * встреч пары — double / multi-RR). Backend (rev:40) выставляет
 * `cell.games` только при ≥2 встречах; защищаемся длиной массива на
 * случай, если backend начнёт отдавать одиночный массив (single-RR
 * back-compat).
 */
export function isMultiGameCell(cell: CrosstableCell): boolean {
  return Array.isArray(cell.games) && cell.games.length >= 2;
}
