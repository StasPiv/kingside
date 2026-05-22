/**
 * KS-3230: чистые функции парсинга PGN broadcast'ов, вынесенные из
 * BroadcastSyncService для регрессионного тестирования.
 *
 * Сюда же отнесена вся логика извлечения lichessGameId — ровно та, что
 * после KS-3229 защищена тремя источниками: `[GameURL]` (preferred),
 * `[Site]` (старый формат), pseudo-id `round:X.Y` из `[Round]`. Тесты
 * прогоняются на реальных PGN-фикстурах разных broadcast-форматов из
 * __fixtures__/ — если Lichess поменяет header'ы, тесты упадут.
 *
 * extractClocksFromPgn по-прежнему живёт в broadcast-sync.service.ts —
 * вынос не делал, чтобы не плодить движение кода за рамками задачи.
 */

import { Chess } from 'chess.js';
import { extractClocksFromPgn } from './broadcast-sync.service';

export const STARTING_FEN =
  'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

export interface ParsedGame {
  index: number;
  white: string;
  black: string;
  whiteElo: number | null;
  blackElo: number | null;
  result: string;
  fen: string;
  uci: string;
  pgn: string;
  lichessGameId: string | null;
  whiteClockMs: number | null;
  blackClockMs: number | null;
}

export function parseElo(raw: string | undefined): number | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed === '?' || trimmed === '-') return null;
  const n = parseInt(trimmed, 10);
  if (isNaN(n) || n <= 0 || n > 4000) return null;
  return n;
}

export function computeFenAndLastUci(pgnText: string): {
  fen: string | null;
  lastUci: string;
} {
  const cleaned = pgnText.replace(/\{[^}]*\}/g, '');
  try {
    const chess = new Chess();
    chess.loadPgn(cleaned);
    const history = chess.history({ verbose: true });
    if (history.length > 0) {
      const last = history[history.length - 1];
      const uci = last.from + last.to + (last.promotion ?? '');
      return { fen: chess.fen(), lastUci: uci };
    }
  } catch {
    /* loadPgn failed */
  }
  return { fen: null, lastUci: '' };
}

/**
 * KS-3229: извлечение lichess_game_id из PGN-headers одной партии.
 * Цепочка fallback'ов:
 *  1. `[GameURL "https://lichess.org/.../<RID>/<GID>"]` — основной для
 *     современных broadcast'ов. `split('/').pop()` даёт base62-id.
 *  2. `[Site "https://..."]` — старый формат, где URL был в Site
 *     (часть broadcast'ов до 2024).
 *  3. `round:X.Y` из `[Round]` — pseudo-id; гарантирует уникальность
 *     внутри одного раунда, чтобы партии без обоих URL-headers не
 *     схлопывались на один id (как было до фикса у Romania).
 *
 * Возвращает null только если ни одного источника нет (теоретически
 * невозможный для Lichess PGN кейс — тогда processPgnUpdate просто
 * скипнёт партию, см. strict-mode).
 */
export function extractLichessGameId(
  headerMap: Record<string, string>,
): string | null {
  const gameUrl = headerMap['GameURL'] ?? '';
  const site = headerMap['Site'] ?? '';
  const roundTag = headerMap['Round'] ?? '';
  const urlSource = gameUrl || (site.includes('/') ? site : '');
  if (urlSource) {
    const id = urlSource.split('/').pop() ?? null;
    if (id) return id;
  }
  if (roundTag) return `round:${roundTag}`;
  return null;
}

export function parsePgnGames(rawPgn: string): ParsedGame[] {
  const cleanedPgn = rawPgn
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return true;
      if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        try {
          JSON.parse(trimmed);
          return false;
        } catch {
          return true;
        }
      }
      return true;
    })
    .join('\n');

  const gameSections = cleanedPgn.split(/\n\n(?=\[)/);
  const games: ParsedGame[] = [];
  let index = 0;

  for (const section of gameSections) {
    if (!section.trim()) continue;
    const headerMap: Record<string, string> = {};
    const headerLines = section.match(/\[(\w+)\s+"([^"]*)"\]/g) ?? [];
    if (headerLines.length === 0) continue;
    for (const line of headerLines) {
      const m = line.match(/\[(\w+)\s+"([^"]*)"\]/);
      if (m) headerMap[m[1]] = m[2];
    }

    const fenValue = headerMap['FEN'] ?? '';
    const white = headerMap['White'] ?? 'Unknown';
    const black = headerMap['Black'] ?? 'Unknown';
    const whiteElo = parseElo(headerMap['WhiteElo']);
    const blackElo = parseElo(headerMap['BlackElo']);
    const result = headerMap['Result'] ?? '';
    const lastMove = headerMap['LastMove'] ?? '';
    const lichessGameId = extractLichessGameId(headerMap);

    const { fen: computedFen, lastUci } = computeFenAndLastUci(section);
    const fen = fenValue || computedFen || STARTING_FEN;
    const uci = lastMove || lastUci;

    const { whiteMs, blackMs } = extractClocksFromPgn(section);

    games.push({
      index,
      white,
      black,
      whiteElo,
      blackElo,
      result,
      fen,
      uci,
      pgn: section.trim(),
      lichessGameId,
      whiteClockMs: whiteMs,
      blackClockMs: blackMs,
    });
    index++;
  }
  return games;
}

/**
 * KS-3230 strict mode: проверка уникальности lichessGameId в пакете
 * партий из одного раунда. До KS-3229 баг с `Site=venue` приводил к
 * тому, что все 5 партий получали один и тот же id, и upsert по
 * (roundId, lichessGameId) перезаписывал одну запись 5 раз — молча.
 *
 * Возвращает массив дублированных id (пустой если всё ок). Вызывающая
 * сторона должна решить, что делать: log.warn + skip раунда (default)
 * или throw (для тестов / dev-env через env-флаг).
 */
export function findDuplicateGameIds(games: ParsedGame[]): string[] {
  const counts = new Map<string, number>();
  for (const g of games) {
    if (g.lichessGameId === null) continue;
    counts.set(g.lichessGameId, (counts.get(g.lichessGameId) ?? 0) + 1);
  }
  const dupes: string[] = [];
  for (const [id, n] of counts) {
    if (n > 1) dupes.push(id);
  }
  return dupes;
}
