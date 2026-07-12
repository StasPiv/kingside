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

  /**
   * KS-4884 / ADR-160 §5.2. Дневная активность lichess: число партий
   * за календарные сутки UTC + текущие рейтинги по категориям.
   * Лёгкие вызовы: NDJSON-список партий без ходов (max 200) + профиль.
   */
  async fetchLichessDailyActivity(
    username: string,
    dayStartUtc: Date,
  ): Promise<{ gamesPlayed: number; ratings: Record<string, number> }> {
    const since = dayStartUtc.getTime();
    const until = since + 86_400_000;
    const params = new URLSearchParams({
      since: String(since),
      until: String(until),
      moves: 'false',
      max: '200',
    });
    const gamesRes = await fetch(
      `https://lichess.org/api/games/user/${encodeURIComponent(username)}?${params}`,
      { headers: { Accept: 'application/x-ndjson' } },
    );
    if (!gamesRes.ok) {
      throw new Error(`lichess games API error: ${gamesRes.status}`);
    }
    const ndjson = (await gamesRes.text()).trim();
    const gamesPlayed = ndjson ? ndjson.split('\n').length : 0;

    const userRes = await fetch(
      `https://lichess.org/api/user/${encodeURIComponent(username)}`,
      { headers: { Accept: 'application/json' } },
    );
    const ratings: Record<string, number> = {};
    if (userRes.ok) {
      const body = (await userRes.json()) as {
        perfs?: Record<string, { rating?: number }>;
      };
      for (const [perf, data] of Object.entries(body.perfs ?? {})) {
        if (typeof data?.rating === 'number') ratings[perf] = data.rating;
      }
    }
    return { gamesPlayed, ratings };
  }

  /**
   * KS-4911 / ADR-162 §3.1. Дневной PGN lichess-партий (с ходами) для
   * авто-импорта в workshop. Лимит max — щадящий режим rate-limit.
   */
  async fetchLichessDailyPgn(
    username: string,
    dayStartUtc: Date,
    max = 50,
  ): Promise<string> {
    const since = dayStartUtc.getTime();
    const params = new URLSearchParams({
      since: String(since),
      until: String(since + 86_400_000),
      max: String(max),
      opening: 'true',
    });
    const res = await fetch(
      `https://lichess.org/api/games/user/${encodeURIComponent(username)}?${params}`,
      { headers: { Accept: 'application/x-chess-pgn' } },
    );
    if (!res.ok) {
      throw new Error(`lichess games API error: ${res.status}`);
    }
    return res.text();
  }

  /**
   * KS-4884 / ADR-160 §5.2. Дневная активность chess.com: партии за
   * сутки UTC (месячный PGN-архив, фильтр по [Date]) + рейтинги из
   * /stats. У chess.com нет per-day API — архив за месяц и так
   * кэшируется их CDN. `dayPgn` (KS-4911) — PGN-текст партий этих
   * суток для авто-импорта: архив уже скачан, второй запрос не нужен.
   */
  async fetchChesscomDailyActivity(
    username: string,
    dayStartUtc: Date,
  ): Promise<{ gamesPlayed: number; ratings: Record<string, number>; dayPgn: string }> {
    const y = dayStartUtc.getUTCFullYear();
    const m = dayStartUtc.getUTCMonth() + 1;
    const pgn = await this.fetchChesscomGames(username, y, m).catch(() => '');
    const dateTag = `[Date "${y}.${String(m).padStart(2, '0')}.${String(
      dayStartUtc.getUTCDate(),
    ).padStart(2, '0')}"]`;
    const dayGames = pgn
      .split(/\n(?=\[Event )/)
      .filter((g) => g.includes(dateTag));
    const gamesPlayed = dayGames.length;
    const dayPgn = dayGames.join('\n\n');

    const statsRes = await fetch(
      `https://api.chess.com/pub/player/${encodeURIComponent(username.toLowerCase())}/stats`,
    );
    const ratings: Record<string, number> = {};
    if (statsRes.ok) {
      const body = (await statsRes.json()) as Record<
        string,
        { last?: { rating?: number } }
      >;
      for (const [key, data] of Object.entries(body)) {
        const rating = data?.last?.rating;
        if (typeof rating === 'number') {
          ratings[key.replace(/^chess_/, '')] = rating;
        }
      }
    }
    return { gamesPlayed, ratings, dayPgn };
  }
}
