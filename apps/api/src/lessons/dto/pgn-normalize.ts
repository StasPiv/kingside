/**
 * KS-2280 (ADR-037 §6, R6): нормализация порядка NAG-токенов и
 * комментариев в PGN.
 *
 * Контекст: `chess.js#loadPgn` принимает токены в виде
 * `<move> $N {comment}`, но падает на reverse-order
 * `<move> {comment} $N` ("Expected ... but '$' found"). При этом сам
 * PGN-стандарт обоих порядков допускает, и ряд внешних программ
 * (ChessBase, импорт-партии lichess studies в редких кейсах) пишут
 * комментарий перед NAG.
 *
 * Чтобы валидаторы lesson-payload (`IsValidPgn` / `IsDrillPgn`) не
 * отвергали такие PGN на пороге, прежде чем отдать строку в
 * `chess.js#loadPgn`, прогоняем её через `normalizeNagOrder` —
 * простой текстовый swap `{comment} $N+` → `$N+ {comment}`.
 *
 * Сама запись в БД сохраняет PGN как есть (validator не мутирует
 * payload). Это не изменяет видимое поведение для PGN, которые наш
 * фронтовый `PgnSerializer` уже пишет в «правильном» порядке (он
 * ставит `$N` до `{comment}`, см. ADR-037 §6.4 / `PgnSerializer.ts`),
 * но открывает приём импортируемых партий с reverse-order.
 */

const NAG_BEFORE_COMMENT_RE =
  /(\{[^}]*\})(\s*)((?:\$\d+(?:\s+|\b))+)/g;

export function normalizeNagOrder(pgn: string): string {
  if (typeof pgn !== 'string' || pgn.length === 0) return pgn;
  return pgn.replace(NAG_BEFORE_COMMENT_RE, (_m, comment: string, _ws: string, nags: string) => {
    return `${nags.trim()} ${comment} `;
  });
}
