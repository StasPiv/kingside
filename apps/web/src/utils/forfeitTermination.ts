/**
 * KS-3258 (UX): «Партия не игралась (forfeit)»-плашка.
 *
 * Lichess PGN иногда содержит `[Termination "Unplayed"]` без movetext —
 * это техническое поражение (неявка, снятие с турнира, walkover). Lichess
 * отдаёт `Result=0-1` (или `1-0`) без ходов; импорт у нас работает
 * корректно, но раньше UI показывал «No moves» / «Партия ещё не
 * началась» — неотличимо от не-стартовавшей live-партии.
 *
 * Этот helper определяет, является ли пустой movelist следствием
 * forfeit'а (а не «партия начнётся позже»). Парсим PGN headers через
 * простой regex — не используем `chess.js#header()`, чтобы избежать
 * лишней загрузки PGN в новый Chess-instance (вызывающий код может
 * уже работать с готовым Chess или с raw PGN'ом).
 */

const FORFEIT_TERMINATIONS = new Set<string>([
  // Lichess-стандартные термины + варианты с пробелом/регистром.
  'unplayed',
  'forfeit',
  'default',
  'walkover',
  'rules infraction',
  'abandoned',
]);

/**
 * Извлекает значение PGN-header'а по имени (case-insensitive).
 * Lichess формат: `[Termination "Unplayed"]`. Если header'а нет —
 * возвращает null.
 */
export function readPgnHeader(pgn: string, name: string): string | null {
  if (!pgn) return null;
  const re = new RegExp(
    `\\[${name.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\s+"([^"]*)"\\]`,
    'i',
  );
  const m = pgn.match(re);
  return m ? m[1] : null;
}

/**
 * Нормализует строку Termination и проверяет, относится ли она к
 * forfeit-типам. Возвращает true для «Unplayed», «Forfeit», «Default»,
 * «Walkover», «Rules infraction», «Abandoned» (в любом регистре).
 */
export function isForfeitTermination(
  termination: string | null | undefined,
): boolean {
  if (!termination) return false;
  return FORFEIT_TERMINATIONS.has(termination.trim().toLowerCase());
}

/**
 * Верхнеуровневый детектор: «партия не игралась»?
 *
 *  - есть movetext? → false (это нормальная сыгранная партия).
 *  - есть [Termination "Unplayed"|...] header → true.
 *  - есть [Result] != "*" при пустой истории → fallback true (Lichess
 *    отдаёт 0-1 без ходов = forfeit, даже если Termination header
 *    отсутствует в payload).
 *  - иначе → false (партия ещё не началась / live-stream без ходов).
 *
 * @param pgn raw PGN-текст (или пустая строка / undefined).
 * @param historyLen длина уже распарсенной истории (chess.js).
 */
export function isForfeitGame(
  pgn: string | null | undefined,
  historyLen: number,
): boolean {
  if (historyLen > 0) return false;
  if (!pgn) return false;
  const termination = readPgnHeader(pgn, 'Termination');
  if (isForfeitTermination(termination)) return true;
  // Fallback: Result уже выставлен и не '*' (live в процессе). Без
  // ходов и с финальным результатом — практически всегда forfeit.
  const result = readPgnHeader(pgn, 'Result');
  if (result && result !== '*' && (result.includes('1-0') || result.includes('0-1') || result.includes('1/2'))) {
    return true;
  }
  return false;
}
