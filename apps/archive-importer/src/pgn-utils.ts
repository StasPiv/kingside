import { createHash } from 'node:crypto';
import iconv from 'iconv-lite';
import { Chess } from 'chess.js';
import { classifyGame, type GameCategory, type GameClassification } from './classify.js';

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
  /** Быстрый bool-флаг: category ∈ {classical, classical-legacy}. */
  isClassical: boolean;
  /** Причина отсева/принятия, для метрик. */
  classificationReason: GameClassification['reason'];
}

export interface ParseResult {
  games: ParsedGame[];
  failed: number;
}

/** Считываем один PGN-заголовок типа `[Tag "value"]`. */
function extractHeader(pgn: string, tag: string): string | null {
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

/**
 * Разбор одной партии — строит список ходов через chess.js.
 *
 * Вернёт null, если chess.js не смог прочитать PGN (битая партия) —
 * такие партии в MVP пропускаем, не роняя импорт.
 */
export function parseGame(rawPgn: string): ParsedGame | null {
  let chess: Chess;
  let history: ReturnType<Chess['history']>;
  try {
    chess = new Chess();
    chess.loadPgn(rawPgn, { strict: false });
    history = chess.history({ verbose: true }) as ReturnType<Chess['history']>;
  } catch {
    return null;
  }

  // Восстанавливаем FEN после каждого хода: заново проигрываем ходы на чистой доске.
  const moves: GameMoveStep[] = [];
  try {
    const replay = new Chess(extractHeader(rawPgn, 'FEN') ?? undefined);
    for (const mv of history as Array<{ from: string; to: string; promotion?: string }>) {
      const res = replay.move({ from: mv.from, to: mv.to, promotion: mv.promotion });
      if (!res) return null;
      const uci = res.from + res.to + (res.promotion ?? '');
      moves.push({ uci, fenAfter: replay.fen() });
    }
  } catch {
    return null;
  }

  const white = extractHeader(rawPgn, 'White');
  const black = extractHeader(rawPgn, 'Black');
  const date = extractHeader(rawPgn, 'Date');
  const round = extractHeader(rawPgn, 'Round');
  const event = extractHeader(rawPgn, 'Event');
  const site = extractHeader(rawPgn, 'Site');
  const timeControl = extractHeader(rawPgn, 'TimeControl');
  const classification = classifyGame({ timeControl, site, event });

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
    isClassical: classification.isClassical,
    classificationReason: classification.reason,
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
