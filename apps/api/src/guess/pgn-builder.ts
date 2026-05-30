/**
 * KS-3460 / ADR-089 §3. PGN-builder с NAG-аннотациями для guess→analysis.
 *
 * Принцип (ADR-089 §3.1, выбран вариант A):
 *  - Основная линия = реальная партия (ровно как в `session.pgn`).
 *  - На ходах выбранной стороны (тех, где есть GuessMove) добавляются:
 *      * NAG основной линии по `lossPlayer` (§4.1)
 *      * вариант `(userSan {комментарий} $NAG)`, если `userUci !==
 *        playedUci` (§4.2 + §5)
 *
 * Почему свой builder, а не `chess.js#pgn()`: chess.js не выводит
 * варианты (`()` блоки) в своём `pgn()` — это его известное
 * ограничение (ADR-089 §3.2). Свой строковый builder простой
 * (~150 строк) и тестируется фикстурами.
 *
 * Чистая функция: НЕ зависит от NestJS-DI. I18n передаётся
 * параметром-функцией `translate` — сервис прокидывает
 * `nestjs-i18n` под нужный язык, тесты — стаб.
 */
import { Chess, type Move } from 'chess.js';

/** Подмножество полей `GuessMove`, нужных builder'у. */
export interface GuessMoveForBuilder {
  ply: number;
  fenBefore: string;
  playedUci: string;
  userUci: string;
  lossPlayer: number;
  lossUser: number;
  accuracyPlayer: number;
  accuracyUser: number;
  userClass: string;
  verdict: string;
}

/**
 * Локализованный перевод. `args` — плейсхолдеры `{name}` в шаблоне.
 * Сервис оборачивает `nestjs-i18n` (с lang из JWT/header), тесты —
 * передают простую функцию-стаб.
 */
export type PgnTranslator = (
  key: string,
  args?: Record<string, string | number>,
) => string;

export interface BuildPgnOptions {
  /** Если задано — будет добавлено в заголовок [Annotator "…"]. */
  annotator?: string;
}

/**
 * Построить PGN с NAG'ами и вариантами игрока.
 *
 *  @param sessionPgn  Исходный PGN партии (snapshot из GuessSession.pgn).
 *  @param side        За кого играл угадывающий ('white'|'black').
 *                     Используется только как метаданные/sanity-check;
 *                     фактический фильтр — наличие GuessMove на ply.
 *  @param moves       Persisted guess-ходы. Builder проставит NAG только
 *                     на тех ply, для которых есть запись.
 *  @param translate   Локализатор для текстов в комментариях.
 *  @param options     Доп. флаги (annotator).
 *  @returns           PGN-строка, обратимая через chess.js#loadPgn.
 */
export function buildAnnotatedPgn(
  sessionPgn: string,
  side: 'white' | 'black',
  moves: GuessMoveForBuilder[],
  translate: PgnTranslator,
  options: BuildPgnOptions = {},
): string {
  const chess = new Chess();
  chess.loadPgn(sessionPgn);

  const headers: Record<string, string> = { ...chess.getHeaders() };
  if (options.annotator) {
    headers.Annotator = options.annotator;
  }
  // Зафиксируем сторону игрока в headers — позволяет UI понять контекст.
  headers.GuessSide = side === 'white' ? 'White' : 'Black';

  const history = chess.history({ verbose: true }) as Move[];
  const moveByPly = new Map<number, GuessMoveForBuilder>();
  for (const m of moves) moveByPly.set(m.ply, m);

  const tokens: string[] = [];
  let lastWasVariantClose = false;

  for (let i = 0; i < history.length; i++) {
    const ply = i + 1;
    const move = history[i];
    const moveNumber = Math.ceil(ply / 2);
    const isWhitePly = ply % 2 === 1;

    // Маркер хода. Белые — всегда `N.`. Чёрные — `N...` только если
    // первый ход (партия с чёрного хода) или сразу после варианта.
    if (isWhitePly) {
      tokens.push(`${moveNumber}.`);
    } else if (i === 0 || lastWasVariantClose) {
      tokens.push(`${moveNumber}...`);
    }
    lastWasVariantClose = false;

    tokens.push(move.san);

    const guess = moveByPly.get(ply);
    if (guess) {
      const mainNag = nagForMainLine(guess.lossPlayer);
      if (mainNag !== null) tokens.push(`$${mainNag}`);

      if (guess.userUci !== guess.playedUci) {
        const variantStr = buildVariantString(guess, ply, translate);
        if (variantStr) {
          tokens.push(`(${variantStr})`);
          lastWasVariantClose = true;
        }
      }
    }
  }

  // Финальный результат — обязателен для valid PGN, иначе loadPgn ругается
  // не всегда, но безопаснее добавить.
  const result = (headers.Result || '*') as string;
  tokens.push(result);

  const headerLines = Object.entries(headers)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `[${k} "${escapeHeaderValue(String(v))}"]`);

  return `${headerLines.join('\n')}\n\n${tokens.join(' ')}\n`;
}

/** NAG основной линии по `lossPlayer` (ADR-089 §4.1). */
function nagForMainLine(lossPlayer: number): number | null {
  if (lossPlayer > 0.25) return 4; // $4 = ??
  if (lossPlayer > 0.12) return 2; // $2 = ?
  if (lossPlayer > 0.05) return 6; // $6 = ?!
  return null;
}

/** NAG варианта по verdict + userClass (ADR-089 §4.2). */
function nagForVariant(g: GuessMoveForBuilder): number | null {
  switch (g.verdict) {
    case 'strongest':
      return 3; // $3 = !!
    case 'betterThanPlayer':
      return 1; // $1 = !
    case 'asPlayer':
      return null;
    case 'weaker':
      switch (g.userClass) {
        case 'blunder':
          return 4;
        case 'mistake':
          return 2;
        case 'inaccuracy':
          return 6;
        case 'good':
        case 'best':
          return 5; // $5 = !?
        default:
          return null;
      }
    default:
      return null;
  }
}

/** Локализованный комментарий варианта (ADR-089 §5). */
function buildComment(
  g: GuessMoveForBuilder,
  translate: PgnTranslator,
): string {
  const accUser = Math.round(g.accuracyUser);
  const accPlayer = Math.round(g.accuracyPlayer);
  const lossPct = Math.round(g.lossUser * 100);
  switch (g.verdict) {
    case 'asPlayer':
      return translate('guess.pgn.asPlayer');
    case 'strongest':
      return translate('guess.pgn.strongest', { acc: accUser });
    case 'betterThanPlayer':
      return translate('guess.pgn.betterThanPlayer', { accUser, accPlayer });
    case 'weaker':
      if (
        g.userClass === 'mistake' ||
        g.userClass === 'blunder' ||
        g.userClass === 'inaccuracy'
      ) {
        return translate('guess.pgn.weakerLoss', { loss: lossPct });
      }
      return translate('guess.pgn.weakerGood', { accUser, accPlayer });
    default:
      return '';
  }
}

/** Собрать строковое содержимое варианта (без обрамляющих скобок). */
function buildVariantString(
  g: GuessMoveForBuilder,
  ply: number,
  translate: PgnTranslator,
): string {
  // userSan: применить userUci к позиции fenBefore.
  const chess = new Chess(g.fenBefore);
  const from = g.userUci.slice(0, 2);
  const to = g.userUci.slice(2, 4);
  const promotion = g.userUci.length > 4 ? g.userUci.slice(4, 5) : undefined;
  const move = chess.move({ from, to, promotion });
  if (!move) return '';

  const moveNumber = Math.ceil(ply / 2);
  const isWhite = ply % 2 === 1;
  const numPrefix = isWhite ? `${moveNumber}.` : `${moveNumber}...`;

  // ВНИМАНИЕ: chess.js#loadPgn внутри варианта принимает порядок
  // `SAN $NAG {comment}` (PEG-парсер: NAG ДО комментария). Если поменять
  // местами — `{comment} $NAG` — парсинг падает. Подтверждено
  // экспериментально (KS-3460).
  const parts: string[] = [numPrefix, move.san];
  const nag = nagForVariant(g);
  if (nag !== null) parts.push(`$${nag}`);
  const comment = buildComment(g, translate);
  if (comment) parts.push(`{${sanitizeComment(comment)}}`);
  return parts.join(' ');
}

/** Запрещаем `{` `}` `}` внутри комментариев (ломают PGN-парсер). */
function sanitizeComment(s: string): string {
  return s.replace(/[{}]/g, '');
}

/** Экранирование значения PGN-header: `"` и `\`. */
function escapeHeaderValue(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
