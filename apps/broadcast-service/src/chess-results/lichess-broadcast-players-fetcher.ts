/**
 * KS-3540. Fetcher для Lichess Broadcast Players API.
 *
 * Lichess раздаёт per-tour список игроков с метаданными по эндпоинту
 *   GET https://lichess.org/broadcast/{tourId}/players
 * (`Accept: application/json` обязателен — без него отдаёт HTML 404).
 *
 * Ответ — массив:
 *   {
 *     name: string,           // "So, Wesley"
 *     title?: string,         // "GM"
 *     rating?: number,        // 2754
 *     fideId?: number,        // 5202213
 *     fed?: string,           // "USA" (ISO3 federation)
 *     ...
 *   }
 *
 * Зачем нужен: `CrosstablePlayer.federation` поле есть в shared-типах,
 * но для broadcast'ов без chess-results (Norway Chess → stats.norwaychess.no)
 * federation никогда не заполнялась — `buildLegacyPlayersFromGames`
 * берёт данные из PGN-заголовков, а Lichess в PGN не кладёт country/fed.
 * Этот fetcher закрывает пробел: для всех веток builder'а enrich'им
 * federation/fideId/title из Lichess как из источника правды.
 *
 * Кэш — Redis 10 мин, ключ `broadcast:lichess-players:<tourId>`. Пустые
 * ответы НЕ кэшируем, чтобы не блокировать recovery после Lichess-сбоя.
 */
import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';
import { normalizePlayerName } from '../crosstable/player-matcher';

export interface LichessPlayerInfo {
  /** Исходное имя `"Last, First"` из Lichess. */
  name: string;
  /** `normalizePlayerName(name)` — ключ для матчинга с CrosstablePlayer. */
  normalizedName: string;
  /** ISO3 (`USA`, `NOR`, `IND`). undefined если Lichess не дал. */
  federation?: string;
  /** FIDE ID игрока. */
  fideId?: number;
  /** Шахматный титул (`GM`, `IM`, ...). */
  title?: string;
  /** Standard FIDE rating. */
  rating?: number;
}

const LICHESS_PLAYERS_URL_TPL = (tourId: string): string =>
  `https://lichess.org/broadcast/${tourId}/players`;
const CACHE_KEY_PREFIX = 'broadcast:lichess-players';
const CACHE_TTL_SEC = 10 * 60;
const FETCH_TIMEOUT_MS = 8000;

type RawPlayer = {
  name?: unknown;
  title?: unknown;
  rating?: unknown;
  fideId?: unknown;
  fed?: unknown;
};

@Injectable()
export class LichessBroadcastPlayersFetcher {
  private readonly logger = new Logger(LichessBroadcastPlayersFetcher.name);

  constructor(private readonly redis: RedisService) {}

  /**
   * Возвращает список игроков broadcast'а. При любой ошибке (network /
   * non-200 / парсинг) — `[]`, caller продолжает без enrichment'а
   * (federation останется undefined для unmatched игроков).
   */
  async fetchPlayers(tourId: string): Promise<LichessPlayerInfo[]> {
    if (!tourId) return [];
    const cacheKey = `${CACHE_KEY_PREFIX}:${tourId}`;

    const cached = await this.redis.get(cacheKey).catch(() => null);
    if (cached) {
      try {
        const parsed = JSON.parse(cached) as LichessPlayerInfo[];
        if (Array.isArray(parsed)) return parsed;
      } catch {
        // упавший JSON в кэше — игнорируем и идём за свежим
      }
    }

    let res: Response;
    try {
      res = await fetch(LICHESS_PLAYERS_URL_TPL(tourId), {
        headers: {
          'User-Agent': 'Kingside/1.0 (https://kingside.app)',
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      this.logger.warn(
        `[lichess-players] fetch failed for ${tourId}: ${(err as Error).message}`,
      );
      return [];
    }

    if (!res.ok) {
      this.logger.warn(
        `[lichess-players] HTTP ${res.status} for ${tourId}`,
      );
      return [];
    }

    let raw: unknown;
    try {
      raw = await res.json();
    } catch (err) {
      this.logger.warn(
        `[lichess-players] JSON parse failed for ${tourId}: ${(err as Error).message}`,
      );
      return [];
    }
    if (!Array.isArray(raw)) return [];

    const players: LichessPlayerInfo[] = [];
    for (const p of raw as RawPlayer[]) {
      if (!p || typeof p.name !== 'string' || p.name.length === 0) continue;
      const normalizedName = normalizePlayerName(p.name);
      if (!normalizedName) continue;
      players.push({
        name: p.name,
        normalizedName,
        federation:
          typeof p.fed === 'string' && p.fed.trim().length > 0
            ? p.fed.trim()
            : undefined,
        fideId:
          typeof p.fideId === 'number' && Number.isFinite(p.fideId)
            ? p.fideId
            : undefined,
        title:
          typeof p.title === 'string' && p.title.trim().length > 0
            ? p.title.trim()
            : undefined,
        rating:
          typeof p.rating === 'number' && Number.isFinite(p.rating)
            ? p.rating
            : undefined,
      });
    }

    if (players.length > 0) {
      try {
        await this.redis.set(
          cacheKey,
          JSON.stringify(players),
          'EX',
          CACHE_TTL_SEC,
        );
      } catch (err) {
        this.logger.warn(
          `[lichess-players] cache set failed for ${tourId}: ${(err as Error).message}`,
        );
      }
    }

    return players;
  }

  /**
   * Хелпер: построить Map<normalizedName, LichessPlayerInfo> для O(1)
   * lookup'а в enrichment-цикле.
   */
  static toMap(
    players: ReadonlyArray<LichessPlayerInfo>,
  ): Map<string, LichessPlayerInfo> {
    const m = new Map<string, LichessPlayerInfo>();
    for (const p of players) {
      if (!m.has(p.normalizedName)) m.set(p.normalizedName, p);
    }
    return m;
  }
}
