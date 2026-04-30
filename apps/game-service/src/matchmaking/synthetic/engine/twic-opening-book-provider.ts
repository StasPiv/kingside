/**
 * KS-2163. TwicOpeningBookProvider — реализация интерфейса
 * `OpeningBookProvider` (KS-2161 seam) через archive-service `/tree`
 * endpoint.
 *
 * Логика:
 *   1. Дёргаем `GET <archive>/tree?fen=<fen>&minElo=<rating-150>&limit=12`.
 *   2. archive-service возвращает агрегаты по ходам в этой позиции
 *      (`uci`, `total`, `whiteWins/draws/blackWins`, `avgElo`).
 *   3. Weighted-pick по `total` — частые ходы выбираются чаще; отбрасываем
 *      ходы с `total < MIN_GAMES_PER_MOVE` (мусор).
 *   4. Кэшируем результат в Redis под ключ `synth:opening:<sha1(fen,rating-band)>`
 *      с TTL 1 ч — opening lookup'ы повторяются.
 *   5. На любой ошибке (archive 5xx, timeout, нет ходов) — `null`,
 *      caller (SyntheticMoveEngineService) фолбэчит на Stockfish.
 *
 * Никаких прямых обращений к БД — всё через archive-service HTTP, чтобы
 * не дублировать прод-источник истины. Опт-ин через
 * `SYNTHETIC_OPENING_BOOK_ENABLED=true` (default `false` — без флага
 * provider возвращает null, MoveEngine сразу идёт на Stockfish).
 */
import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import type { OpeningBookProvider } from './synthetic-move-engine.service';

const ARCHIVE_BASE_URL_DEFAULT = 'http://archive-service:3003';
const FETCH_TIMEOUT_MS = 5_000;
const REDIS_TTL_SEC = 60 * 60; // 1 час
const REDIS_KEY_PREFIX = 'synth:opening:';
/** Минимальное число партий по ходу — отсеивает шум (1-2 партии = случайность). */
const MIN_GAMES_PER_MOVE = 5;
/** Окно ELO ±N от target rating (ADR §5 — оригинал ±150). */
const ELO_BAND = 150;

interface ArchiveTreeMoveLite {
  uci: string;
  total: number;
  whiteWins: number;
  draws: number;
  blackWins: number;
  avgElo?: number | null;
}

interface ArchiveTreeResponseLite {
  moves: ArchiveTreeMoveLite[];
}

/**
 * Узкий API Redis для кэша. Подменяемый в тестах.
 */
export interface OpeningRedis {
  get(key: string): Promise<string | null>;
  set(
    key: string,
    value: string,
    mode: 'EX',
    ttl: number,
  ): Promise<'OK' | null>;
}

export interface OpeningHttp {
  fetch(url: string, init?: RequestInit): Promise<Response>;
}

/** Pure-helper: weighted-pick хода по `total`. */
export function pickWeightedMove(
  moves: readonly ArchiveTreeMoveLite[],
  rng: () => number = Math.random,
): ArchiveTreeMoveLite | null {
  const eligible = moves.filter((m) => m.total >= MIN_GAMES_PER_MOVE);
  if (eligible.length === 0) return null;
  const total = eligible.reduce((s, m) => s + m.total, 0);
  if (total <= 0) return null;
  let r = rng() * total;
  for (const m of eligible) {
    r -= m.total;
    if (r < 0) return m;
  }
  return eligible[eligible.length - 1];
}

/** Кэш-ключ детерминируется по fen + rating-band, чтобы делить кэш. */
export function openingCacheKey(fen: string, rating: number): string {
  // Сводим rating к шкале по 100 (1500 → 1500, 1465 → 1500), чтобы
  // близкие рейтинги делили один кэш.
  const band = Math.round(rating / 100) * 100;
  const sha = createHash('sha1')
    .update(`${fen}|${band}`)
    .digest('hex')
    .slice(0, 16);
  return `${REDIS_KEY_PREFIX}${sha}`;
}

@Injectable()
export class TwicOpeningBookProvider implements OpeningBookProvider {
  private readonly logger = new Logger(TwicOpeningBookProvider.name);
  private redis: OpeningRedis | null = null;
  private http: OpeningHttp = {
    fetch: (url, init) => globalThis.fetch(url, init as RequestInit),
  };

  configure(redis: OpeningRedis, http?: OpeningHttp): void {
    this.redis = redis;
    if (http) this.http = http;
  }

  private archiveBaseUrl(): string {
    return process.env.ARCHIVE_SERVICE_URL ?? ARCHIVE_BASE_URL_DEFAULT;
  }

  async pickMove(opts: {
    fen: string;
    plyCount: number;
    rating: number;
    ecoPrefix?: string;
  }): Promise<string | null> {
    if (process.env.SYNTHETIC_OPENING_BOOK_ENABLED !== 'true') {
      return null;
    }
    if (opts.plyCount > 20) return null; // только дебют

    const cacheKey = openingCacheKey(opts.fen, opts.rating);

    // 1. Cache lookup.
    const cached = await this.readCache(cacheKey);
    if (cached) {
      const moves = cached.moves ?? [];
      const picked = pickWeightedMove(moves);
      return picked?.uci ?? null;
    }

    // 2. Archive HTTP.
    const url = this.buildTreeUrl(opts.fen, opts.rating);
    let body: ArchiveTreeResponseLite | null = null;
    try {
      const res = await this.http.fetch(url, {
        method: 'GET',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) {
        this.logger.warn(
          `archive /tree returned ${res.status} for fen=${opts.fen.slice(0, 30)}`,
        );
        return null;
      }
      body = (await res.json()) as ArchiveTreeResponseLite;
    } catch (err) {
      this.logger.warn(
        `archive /tree fetch failed: ${(err as Error).message}`,
      );
      return null;
    }
    if (!body || !Array.isArray(body.moves)) return null;

    // 3. Cache write (async, не ждём).
    void this.writeCache(cacheKey, body);

    // 4. Pick.
    const picked = pickWeightedMove(body.moves);
    return picked?.uci ?? null;
  }

  private buildTreeUrl(fen: string, rating: number): string {
    const minElo = Math.max(0, rating - ELO_BAND);
    const params = new URLSearchParams({
      fen,
      minElo: String(minElo),
      limit: '12',
    });
    return `${this.archiveBaseUrl()}/tree?${params.toString()}`;
  }

  private async readCache(
    key: string,
  ): Promise<ArchiveTreeResponseLite | null> {
    if (!this.redis) return null;
    try {
      const raw = await this.redis.get(key);
      if (!raw) return null;
      return JSON.parse(raw) as ArchiveTreeResponseLite;
    } catch {
      return null;
    }
  }

  private async writeCache(
    key: string,
    body: ArchiveTreeResponseLite,
  ): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.set(key, JSON.stringify(body), 'EX', REDIS_TTL_SEC);
    } catch {
      /* no-op */
    }
  }
}
