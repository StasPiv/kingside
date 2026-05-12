import { Chess } from 'chess.js';

/**
 * KS-2606 (ADR-051 §4 этап B4): собирает PGN из стартовой позиции пазла
 * (FEN-header) и UCI-ходов решения. Используется кнопкой «Анализ» на
 * `PuzzlePage`, чтобы передать получившийся PGN в helper `openAnalysis`,
 * который POST'ит запись `/analyses` и navigate'ит на
 * `/analysis/<created.id>` (без `puzzleFen`/`puzzlePgn` через router state —
 * это и было причиной KS-2403, см. ADR-051).
 *
 * # Контракт
 *
 * - `fen` — стандартный FEN стартовой позиции пазла (6 полей).
 * - `moves` — список UCI-ходов (`e2e4`, при превращении `e7e8q`); либо
 *   массив, либо строка ходов через пробел (как приходит из API).
 *
 * Возвращаемый PGN имеет вид:
 *
 *     [FEN "<fen>"]
 *
 *     <move1> <move2> …
 *
 * Нумерация ходов и `…` для чёрного respect'ится по `fen[1]` и `fen[5]`
 * (полный номер хода). Если очередной UCI-ход незаконен в текущей
 * позиции (битая запись) — обрываемся, возвращая то что собралось до
 * этого момента (как и было в исходной inline-логике PuzzlePage).
 */
export function buildPuzzleAnalysisPgn(
  fen: string,
  moves: string[] | string,
): string {
  const movesList = Array.isArray(moves) ? moves : moves.split(' ');
  const c = new Chess(fen);
  const fenParts = fen.split(' ');
  let isWhiteTurn = fenParts[1] === 'w';
  let moveNum = parseInt(fenParts[5] || '1', 10);
  const pgnParts: string[] = [];

  for (const uci of movesList) {
    if (!uci || uci.length < 4) break;
    try {
      const mv = c.move({
        from: uci.slice(0, 2),
        to: uci.slice(2, 4),
        promotion: uci[4],
      });
      if (!mv) break;
      if (isWhiteTurn) {
        pgnParts.push(`${moveNum}. ${mv.san}`);
      } else if (pgnParts.length === 0) {
        // Чёрный начинает — записываем как `N... <san>`.
        pgnParts.push(`${moveNum}... ${mv.san}`);
      } else {
        pgnParts.push(mv.san);
      }
      if (!isWhiteTurn) moveNum += 1;
      isWhiteTurn = !isWhiteTurn;
    } catch {
      break;
    }
  }

  const movesText = pgnParts.join(' ');
  // KS-2828: `[SetUp "1"]` обязательная пара к `[FEN]` по PGN-стандарту
  // (PGN Specification §9.7.3). Без `SetUp=1` парсеры по стандарту
  // вправе игнорировать `[FEN]` тег. Наш собственный `parseAnnotatedPgn`
  // его регекспом всё равно ловит, но для совместимости с внешними
  // инструментами (chess.com, lichess, любой PGN-viewer) добавляем
  // обе пары.
  return `[SetUp "1"]\n[FEN "${fen}"]\n\n${movesText}`;
}
