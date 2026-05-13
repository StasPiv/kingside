import { Chess } from 'chess.js';

/**
 * KS-2946: построение PGN сыгранной партии из state'а `GamePage`.
 *
 * `GamePage` хранит `moves: string[]` (SAN-нотации), `players` и `result`
 * — но шахматный объект `game` содержит только последнюю позицию. Чтобы
 * открыть сыгранную партию в анализе, нужен полный PGN с заголовками и
 * последовательностью ходов.
 *
 * Без этой утилиты модалка результата ссылала на `/analysis/<gameId>` —
 * где `gameId` это id live-игры, а не id записи в `/analyses`. Эндпоинт
 * `/analyses/:id` отвечал 404, AnalysisPage уходил в режим «новый
 * чистый анализ» — отсюда «пустая доска, пустой move-list».
 *
 * Helper создаёт чистый `Chess()`, выставляет минимальные PGN-headers
 * (Event/Date/White/Black/Result) и проигрывает все SAN-ходы. Невалидные
 * хвостовые ходы прерывают цикл без бросания ошибок — на UI всё равно
 * лучше отдать частичный PGN, чем 0 ходов.
 */
export interface BuildGamePgnArgs {
  /** Имена игроков. Пустые → '?'. */
  players: { white: string; black: string };
  /** SAN-ходы партии в порядке от 1-го хода белых. */
  moves: readonly string[];
  /** Итог партии для тега Result: 'white' | 'black' | 'draw' | null. */
  result: string | null;
  /** Опционально — id партии для тега Site/GameId. */
  gameId?: string | null;
  /** Опционально — кастомный Event (по умолчанию `Kingside Game`). */
  event?: string;
  /** Опционально — Date в формате PGN `YYYY.MM.DD` (по умолчанию — сегодня UTC). */
  date?: string;
}

function todayPgnDate(): string {
  const d = new Date();
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${d.getUTCFullYear()}.${pad(d.getUTCMonth() + 1)}.${pad(d.getUTCDate())}`;
}

function resultToTag(result: string | null): string {
  if (result === 'white') return '1-0';
  if (result === 'black') return '0-1';
  if (result === 'draw') return '1/2-1/2';
  return '*';
}

export function buildGamePgn(args: BuildGamePgnArgs): string {
  const chess = new Chess();
  chess.header(
    'Event',
    args.event ?? 'Kingside Game',
    'Date',
    args.date ?? todayPgnDate(),
    'White',
    args.players.white || '?',
    'Black',
    args.players.black || '?',
    'Result',
    resultToTag(args.result),
  );
  for (const san of args.moves) {
    try {
      chess.move(san);
    } catch {
      // Невалидный SAN-ход (рассинхрон со state'ом сервера) — обрываем,
      // но возвращаем PGN с теми ходами, которые уже сыграны.
      break;
    }
  }
  return chess.pgn();
}

/**
 * Удобный builder title'а для анализа — «White vs Black», или
 * fallback'и если одно из имён отсутствует.
 */
export function buildGameAnalysisTitle(players: {
  white: string;
  black: string;
}): string {
  const w = players.white?.trim() || '?';
  const b = players.black?.trim() || '?';
  return `${w} vs ${b}`;
}
