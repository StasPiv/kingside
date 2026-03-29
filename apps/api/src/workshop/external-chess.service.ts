import { BadRequestException, Injectable, Logger } from '@nestjs/common';

@Injectable()
export class ExternalChessService {
  private readonly logger = new Logger(ExternalChessService.name);

  /**
   * Verify a chess.com username exists.
   */
  async verifyChesscomUser(username: string): Promise<boolean> {
    try {
      const res = await fetch(`https://api.chess.com/pub/player/${encodeURIComponent(username.toLowerCase())}`);
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Verify a lichess username exists.
   */
  async verifyLichessUser(username: string): Promise<boolean> {
    try {
      const res = await fetch(`https://lichess.org/api/user/${encodeURIComponent(username)}`, {
        headers: { Accept: 'application/json' },
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Fetch chess.com games for a month as PGN text.
   * API: GET /pub/player/{username}/games/{YYYY}/{MM}/pgn
   */
  async fetchChesscomGames(
    username: string,
    year: number,
    month: number,
    timeClass?: string,
  ): Promise<string> {
    const mm = String(month).padStart(2, '0');
    const url = `https://api.chess.com/pub/player/${encodeURIComponent(username.toLowerCase())}/games/${year}/${mm}/pgn`;
    this.logger.log(`Fetching chess.com games: ${url}`);

    const res = await fetch(url);
    if (!res.ok) {
      throw new BadRequestException(`chess.com API error: ${res.status}`);
    }

    let pgn = await res.text();

    // Filter by time class if specified (chess.com PGN has [TimeControl] header)
    if (timeClass) {
      pgn = this.filterPgnByTimeClass(pgn, timeClass);
    }

    return pgn;
  }

  /**
   * Fetch lichess games for a month as PGN text.
   * API: GET /api/games/user/{username}?since=&until=&pgnInJson=false
   */
  async fetchLichessGames(
    username: string,
    year: number,
    month: number,
    maxGames?: number,
  ): Promise<string> {
    const since = new Date(year, month - 1, 1).getTime();
    const until = new Date(year, month, 1).getTime();
    const params = new URLSearchParams({
      since: String(since),
      until: String(until),
      pgnInJson: 'false',
      opening: 'true',
    });
    if (maxGames) params.set('max', String(maxGames));

    const url = `https://lichess.org/api/games/user/${encodeURIComponent(username)}?${params}`;
    this.logger.log(`Fetching lichess games: ${url}`);

    const res = await fetch(url, {
      headers: { Accept: 'application/x-chess-pgn' },
    });
    if (!res.ok) {
      throw new BadRequestException(`lichess API error: ${res.status}`);
    }

    return res.text();
  }

  /**
   * Filter PGN games by TimeControl header.
   * chess.com timeClass values: bullet, blitz, rapid, daily
   * We match by checking the TimeClass header in PGN.
   */
  private filterPgnByTimeClass(pgn: string, timeClass: string): string {
    // Split into individual games
    const games = pgn.split(/\n(?=\[Event )/);
    const filtered = games.filter((game) => {
      const match = game.match(/\[TimeClass\s+"([^"]+)"\]/i);
      return match && match[1].toLowerCase() === timeClass.toLowerCase();
    });
    return filtered.join('\n\n');
  }
}
