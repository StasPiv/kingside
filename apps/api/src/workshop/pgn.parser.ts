export interface ParsedPgnGame {
  pgn: string;
  white: string | null;
  black: string | null;
  result: string | null;
  date: string | null;
  opening: string | null;
}

function extractHeader(pgn: string, tag: string): string | null {
  const match = pgn.match(new RegExp(`\\[${tag}\\s+"([^"]*)"\\]`));
  return match ? match[1] || null : null;
}

/**
 * Split a multi-game PGN string into individual game PGN strings.
 * A new game begins when a header tag appears after move text has been seen.
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
 * Extract the best available date string for sorting.
 * Prefers UTCDate+UTCTime (chess.com/lichess) for precise ordering.
 * Falls back to Date header.
 */
function extractSortDate(pgn: string): string | null {
  const utcDate = extractHeader(pgn, 'UTCDate');
  const utcTime = extractHeader(pgn, 'UTCTime');
  if (utcDate && utcTime) return `${utcDate} ${utcTime}`;
  if (utcDate) return utcDate;
  return extractHeader(pgn, 'Date');
}

export function parsePgnGames(content: string): ParsedPgnGame[] {
  const rawGames = splitPgn(content);
  return rawGames.map((pgn) => ({
    pgn,
    white: extractHeader(pgn, 'White'),
    black: extractHeader(pgn, 'Black'),
    result: extractHeader(pgn, 'Result'),
    date: extractSortDate(pgn),
    opening: extractHeader(pgn, 'Opening'),
  }));
}
