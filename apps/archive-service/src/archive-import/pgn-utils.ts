import { createHash } from 'node:crypto';
import iconv from 'iconv-lite';
import { Chess } from 'chess.js';
import {
  classifyPgnTimeControl,
  type ArchiveTimeControlCategory,
} from '@kingside/shared';
import { classifyGame, type GameCategory, type GameClassification } from './classify';

/**
 * Ply-хоп партии: UCI-ход и FEN после него.
 *
 * Отдельная структура используется позиционным индексером — ему важен FEN
 * ПОСЛЕ хода (позиция, к которой приводит ход), чтобы группировать ответы
 * на каждую позицию.
 */
export interface GameMoveStep {
  /** UCI (например `e2e4`, с промоушеном — `e7e8q`). */
  uci: string;
  /** FEN после того, как ход сыгран (включая половинные счётчики — для проверки валидации, нормализация делается отдельно). */
  fenAfter: string;
}

export interface ParsedGame {
  white: string | null;
  black: string | null;
  whiteElo: number | null;
  blackElo: number | null;
  whiteTitle: string | null;
  blackTitle: string | null;
  event: string | null;
  site: string | null;
  round: string | null;
  date: string | null;
  playedAt: Date | null;
  result: string | null;
  eco: string | null;
  opening: string | null;
  plyCount: number;
  moves: GameMoveStep[];
  finalFen: string;
  contentHash: Buffer;
  raw: string;
  /** Сырой TimeControl-тег из PGN (например `5400+30`, `-`, или null). */
  timeControl: string | null;
  /** Категория по ADR-015 §1 — выставляется в `parseGame` через `classifyGame`. */
  category: GameCategory;
  /**
   * KS-2118. Упрощённая категория контроля времени для индекса/фильтра:
   * `bullet|blitz|rapid|classical|unknown`. Вычисляется из `timeControl`
   * через {@link classifyPgnTimeControl} (формула base + 40·increment,
   * первая фаза для составных). Используется фронт-фильтром в Архиве
   * партий (`?timeControlCategory=...`).
   */
  timeControlCategory: ArchiveTimeControlCategory;
  /** Быстрый bool-флаг: category ∈ {classical, classical-legacy}. */
  isClassical: boolean;
  /** Причина отсева/принятия, для метрик. */
  classificationReason: GameClassification['reason'];
  /**
   * Нестандартная стартовая позиция партии (фишеррандом, этюды, партии с
   * PGN-заголовком `[SetUp "1"][FEN "..."]`). `undefined` для обычных партий,
   * которые начинаются со стандартной стартовой шахматной позиции.
   *
   * Используется индексерами (`PositionIndexer`, `buildPositionRowsForGame`)
   * чтобы:
   *   1) не прибавлять первый ход к стандартной стартовой позиции для партий
   *      с нестандартным стартом (раньше position_stats раздувалась — KS-1624);
   *   2) решить политику: такие партии не часть классического дерева дебютов,
   *      поэтому полностью исключаются из позиционных индексов.
   */
  startFen?: string;
}

export interface ParseResult {
  games: ParsedGame[];
  failed: number;
}

/** Считываем один PGN-заголовок типа `[Tag "value"]`. */
export function extractHeader(pgn: string, tag: string): string | null {
  const re = new RegExp(`\\[${tag}\\s+"([^"]*)"\\]`);
  const m = pgn.match(re);
  return m ? m[1] || null : null;
}

/**
 * Разбиение буфера на отдельные партии.
 *
 * Копия логики `apps/api/src/workshop/pgn.parser.ts::splitPgn` — специально
 * не заимствуем из пакета workshop, чтобы воркер не тянул NestJS. Поведение
 * байт-в-байт совпадает; если понадобится единый источник — выноси в
 * `packages/shared` отдельной задачей.
 */
export function splitPgn(content: string): string[] {
  const games: string[] = [];
  const lines = content.split('\n');
  let current: string[] = [];
  let hasMovesInCurrent = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[') && hasMovesInCurrent) {
      const game = current.join('\n').trim();
      if (game) games.push(game);
      current = [line];
      hasMovesInCurrent = false;
    } else {
      current.push(line);
      if (trimmed && !trimmed.startsWith('[')) {
        hasMovesInCurrent = true;
      }
    }
  }

  const last = current.join('\n').trim();
  if (last) games.push(last);

  return games.filter((g) => g.length > 0);
}

/**
 * Sniff encoding у загруженного zip-содержимого.
 *
 * TWIC-архивы в основном в UTF-8, но исторические выпуски встречаются в
 * Latin-1 (windows-1252). Эвристика: декодируем как UTF-8, считаем
 * replacement-символы `\uFFFD`; если их доля > 0.05% — считаем, что это
 * Latin-1, перекодируем через iconv-lite.
 */
export function decodePgnBuffer(buffer: Buffer): string {
  const utf8 = buffer.toString('utf8');
  const replacements = (utf8.match(/\uFFFD/g) ?? []).length;
  const ratio = utf8.length > 0 ? replacements / utf8.length : 0;
  if (ratio > 0.0005) {
    return iconv.decode(buffer, 'latin1');
  }
  return utf8;
}

function parseElo(raw: string | null): number | null {
  if (!raw) return null;
  const t = raw.trim();
  if (!t || t === '?' || t === '-') return null;
  const n = parseInt(t, 10);
  if (Number.isNaN(n) || n <= 0 || n > 4000) return null;
  return n;
}

function parsePlayedAt(date: string | null): Date | null {
  if (!date) return null;
  // Формат `YYYY.MM.DD` c возможными `??` вместо неизвестных компонент.
  const m = date.match(/^(\d{4})\.(\d{2}|\?\?)\.(\d{2}|\?\?)$/);
  if (!m) return null;
  const year = parseInt(m[1], 10);
  const month = m[2] === '??' ? 1 : parseInt(m[2], 10);
  const day = m[3] === '??' ? 1 : parseInt(m[3], 10);
  if (Number.isNaN(year) || Number.isNaN(month) || Number.isNaN(day)) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Хэш-ключ партии для UNIQUE (`archive_games.content_hash`).
 *
 * SHA-1 над конкатенацией `white|black|date|round|<uci joined by ' '>`.
 * Берём первые 20 байт (полный SHA-1) — уникальности с запасом.
 */
export function computeContentHash(
  white: string | null,
  black: string | null,
  date: string | null,
  round: string | null,
  uciList: string[],
): Buffer {
  const input = [white ?? '', black ?? '', date ?? '', round ?? '', uciList.join(' ')].join('|');
  return createHash('sha1').update(input, 'utf8').digest();
}

/** Стандартная начальная позиция — тот же FEN, что и в индексерах. */
const STANDARD_STARTING_FEN =
  'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/**
 * Определяем, начата ли партия с нестандартной позиции.
 *
 * По PGN-стандарту нестандартный старт обозначается парой `[SetUp "1"]` +
 * `[FEN "..."]`. В реальных архивах встречаются и небрежные записи без
 * `SetUp` — только `[FEN]` с нестандартной позицией (TWIC такое регулярно
 * кладёт для партий chess960/этюдов). Считаем партию SetUp'ной, если
 * присутствует `[FEN]` с позицией, отличной от стандартной стартовой; тег
 * `[SetUp "0"]` явно отменяет это (нестандартный FEN игнорируется).
 */
function resolveStartFen(rawPgn: string): string | undefined {
  const fenHeader = extractHeader(rawPgn, 'FEN');
  if (!fenHeader) return undefined;
  const setUp = extractHeader(rawPgn, 'SetUp');
  if (setUp !== null && setUp.trim() === '0') return undefined;
  const trimmed = fenHeader.trim();
  if (!trimmed) return undefined;
  if (trimmed === STANDARD_STARTING_FEN) return undefined;
  return trimmed;
}

/**
 * Разбор одной партии — строит список ходов через chess.js.
 *
 * Вернёт null, если chess.js не смог прочитать PGN (битая партия) —
 * такие партии в MVP пропускаем, не роняя импорт.
 *
 * KS-2128 (профилирование парсера): убран second-pass replay
 * (`new Chess(startFen)` + `replay.move(...)` + `replay.fen()` для каждого
 * хода). На fixture 7000 партий по 80 полуходов он давал ~110 сек из 114
 * сек `parseBatch` (96% времени), полностью дублируя работу chess.js
 * валидатора, чтобы получить FEN после каждого хода.
 *
 * `chess.history({ verbose: true })` в chess.js v1.4 возвращает на каждом
 * элементе поля `before`/`after` — FEN до и после хода соответственно
 * (см. `node_modules/chess.js/dist/types/chess.d.ts`). Это уже
 * вычислено chess.js во время `loadPgn`, второй проход не нужен. Бенчмарк
 * после правки: 50 сек на тех же 7000 партий, экономия ~55%
 * (`apps/archive-service/test/profile/profile-pgn-parser.ts`).
 *
 * Поведение для нестандартного starting FEN: `chess.loadPgn(..., {strict:false})`
 * сам читает `[FEN]` (даже без `[SetUp "1"]`, см. `loadPgn` в chess.js
 * v1.4 src), стартовая позиция выставляется автоматически — отдельная
 * `resolveStartFen` нужна только для downstream-консьюмеров
 * (`position-row-builder` и т.п.), которые работают с FEN'ами вне
 * парсера.
 */
export function parseGame(rawPgn: string): ParsedGame | null {
  let chess: Chess;
  let history: Array<{
    from: string;
    to: string;
    promotion?: string;
    after: string;
  }>;
  try {
    chess = new Chess();
    chess.loadPgn(rawPgn, { strict: false });
    history = chess.history({ verbose: true }) as Array<{
      from: string;
      to: string;
      promotion?: string;
      after: string;
    }>;
  } catch {
    return null;
  }

  const startFen = resolveStartFen(rawPgn);

  // Берём FEN из verbose-истории напрямую — chess.js уже посчитал его в
  // `loadPgn`. UCI собираем из from/to/promotion (полностью совместимо с
  // прежним replay-вариантом — те же поля Move).
  const moves: GameMoveStep[] = new Array(history.length);
  for (let i = 0; i < history.length; i++) {
    const mv = history[i]!;
    const uci = mv.from + mv.to + (mv.promotion ?? '');
    moves[i] = { uci, fenAfter: mv.after };
  }

  const white = extractHeader(rawPgn, 'White');
  const black = extractHeader(rawPgn, 'Black');
  const date = extractHeader(rawPgn, 'Date');
  const round = extractHeader(rawPgn, 'Round');
  const event = extractHeader(rawPgn, 'Event');
  const site = extractHeader(rawPgn, 'Site');
  const timeControl = extractHeader(rawPgn, 'TimeControl');
  const classification = classifyGame({ timeControl, site, event });
  const timeControlCategory = classifyPgnTimeControl(timeControl);

  return {
    white,
    black,
    whiteElo: parseElo(extractHeader(rawPgn, 'WhiteElo')),
    blackElo: parseElo(extractHeader(rawPgn, 'BlackElo')),
    whiteTitle: extractHeader(rawPgn, 'WhiteTitle'),
    blackTitle: extractHeader(rawPgn, 'BlackTitle'),
    event,
    site,
    round,
    date,
    playedAt: parsePlayedAt(date),
    result: extractHeader(rawPgn, 'Result'),
    eco: extractHeader(rawPgn, 'ECO'),
    opening: extractHeader(rawPgn, 'Opening'),
    plyCount: moves.length,
    moves,
    finalFen: chess.fen(),
    contentHash: computeContentHash(white, black, date, round, moves.map((m) => m.uci)),
    raw: rawPgn,
    timeControl,
    category: classification.category,
    timeControlCategory,
    isClassical: classification.isClassical,
    classificationReason: classification.reason,
    startFen,
  };
}

/** Пачечный парсинг: разбивает контент на партии и пропускает битые. */
export function parseBatch(content: string): ParseResult {
  const raw = splitPgn(content);
  const games: ParsedGame[] = [];
  let failed = 0;
  for (const pgn of raw) {
    const parsed = parseGame(pgn);
    if (parsed) games.push(parsed);
    else failed++;
  }
  return { games, failed };
}
