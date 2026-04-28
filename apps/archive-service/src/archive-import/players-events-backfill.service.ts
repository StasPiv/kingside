/**
 * KS-2064 / ADR-033 §4.4.5:
 * One-shot backfill таблиц `archive_players` / `archive_events` и
 * рефреш материализованного view `archive_player_stats` поверх корпуса
 * `archive_games`.
 *
 * Алгоритм:
 *   1. Стрим `archive_games` чанками (LIMIT/OFFSET по `id`).
 *   2. Агрегируем в JS Map'ах по `nameNormalized` (одинаково для имён
 *      и для названий турниров) — собираем canonical (самую частую
 *      форму), aliases (Set всех встретившихся), games_count, peak_elo,
 *      first_seen_at, last_seen_at, first_date, last_date.
 *   3. TRUNCATE целевых таблиц + bulk INSERT чанками по 1000.
 *   4. REFRESH MATERIALIZED VIEW (первый прогон — без CONCURRENTLY,
 *      т.к. MV пустая после CREATE; повторные — CONCURRENTLY).
 *
 * Зачем JS-агрегация, а не INSERT...SELECT с SQL-функцией:
 *   - Единая утилита нормализации (`@kingside/shared`
 *     `normalizeArchiveName`) — гарантирует, что write-path (этот
 *     backfill) и read-path (endpoint'ы B3) дают идентичные ключи. Иначе
 *     запрос пользователя через FTS/`name_normalized` не совпадёт с
 *     записью.
 *   - Не требует расширения `unaccent` и SQL-функции с дублирующейся
 *     логикой нормализации.
 *   - Объём корпуса TWIC (~250k партий) укладывается в RAM и в SLA
 *     (~10s локально).
 *
 * Сервис также используется инкрементально: после каждого успешного
 * импорта `TwicImporter` собирает дельту имён/событий и вызывает
 * {@link PlayersEventsBackfillService.syncDelta}, после чего дёргается
 * `REFRESH MATERIALIZED VIEW CONCURRENTLY archive_player_stats` —
 * нагрузка на 250k оценивается в 10-30s, асинхронно (ADR-033 §4.4.6).
 */

import { Injectable, Logger } from '@nestjs/common';
import { archiveSlug, normalizeArchiveName } from '@kingside/shared';
import { PrismaService } from '../prisma/prisma.service';
import { ArchiveImportMetricsService } from './archive-import-metrics.service';

const READ_CHUNK_SIZE = 5000;
const INSERT_CHUNK_SIZE = 1000;

type RawArchiveGameRow = {
  id: string;
  white_name: string | null;
  black_name: string | null;
  white_elo: number | null;
  black_elo: number | null;
  event: string | null;
  played_at: Date | null;
  date: string | null;
};

interface PlayerAgg {
  /** Нормализованная форма (ключ Map). */
  nameNormalized: string;
  /** Slug = nameNormalized с пробелами→дефисами. */
  slug: string;
  /** Все встреченные raw-формы (для name_aliases). */
  aliases: Set<string>;
  /** Счётчик каждой raw-формы — самая частая становится name_canonical. */
  rawNameCounts: Map<string, number>;
  gamesCount: number;
  peakElo: number | null;
  firstSeenAt: Date | null;
  lastSeenAt: Date | null;
}

interface EventAgg {
  nameNormalized: string;
  slug: string;
  rawNameCounts: Map<string, number>;
  gamesCount: number;
  /** Минимальная PGN-дата (строка как в архиве). */
  firstDate: string | null;
  lastDate: string | null;
}

export interface BackfillReport {
  scannedGames: number;
  insertedPlayers: number;
  insertedEvents: number;
  refreshedViewMode: 'initial' | 'concurrent';
  durationMs: number;
}

export interface SyncDeltaInput {
  /** Партии, которые только что были вставлены — сюда смотрим имена/события. */
  games: Array<{
    whiteName: string | null;
    blackName: string | null;
    whiteElo: number | null;
    blackElo: number | null;
    event: string | null;
    playedAt: Date | null;
    date: string | null;
  }>;
}

export interface SyncDeltaReport {
  upsertedPlayers: number;
  upsertedEvents: number;
}

@Injectable()
export class PlayersEventsBackfillService {
  private readonly logger = new Logger(PlayersEventsBackfillService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly metrics: ArchiveImportMetricsService,
  ) {}

  // ─── Public API ──────────────────────────────────────────────────

  async backfillAll(): Promise<BackfillReport> {
    const startedAt = Date.now();
    this.logger.log('backfill: scanning archive_games...');

    const players = new Map<string, PlayerAgg>();
    const events = new Map<string, EventAgg>();

    let scanned = 0;
    let lastId: string | null = null;

    // Постраничный стрим по убыванию id для устойчивости при росте таблицы.
    while (true) {
      const rows = await this.fetchChunk(lastId);
      if (rows.length === 0) break;

      for (const r of rows) {
        scanned++;
        this.consumeGame(r, players, events);
      }
      lastId = rows[rows.length - 1].id;
      if (rows.length < READ_CHUNK_SIZE) break;
    }

    this.logger.log(
      `backfill: scanned ${scanned} games → ${players.size} players, ${events.size} events`,
    );

    await this.prisma.$executeRawUnsafe('TRUNCATE archive_players RESTART IDENTITY');
    await this.prisma.$executeRawUnsafe('TRUNCATE archive_events RESTART IDENTITY');

    const insertedPlayers = await this.bulkInsertPlayers([...players.values()]);
    const insertedEvents = await this.bulkInsertEvents([...events.values()]);

    const refreshedViewMode = await this.refreshPlayerStats({ allowConcurrent: false });

    await this.publishGauges();

    return {
      scannedGames: scanned,
      insertedPlayers,
      insertedEvents,
      refreshedViewMode,
      durationMs: Date.now() - startedAt,
    };
  }

  /**
   * Инкрементальный апдейт после успешного импорта новой пачки партий.
   * Игроки и события UPSERT'ятся; gamesCount атомарно увеличивается.
   * После UPSERT'а — REFRESH MV CONCURRENTLY (нагрузка ~10-30s, не блокирует читателей).
   */
  async syncDelta(input: SyncDeltaInput): Promise<SyncDeltaReport> {
    const players = new Map<string, PlayerAgg>();
    const events = new Map<string, EventAgg>();

    for (const g of input.games) {
      const row: RawArchiveGameRow = {
        id: 'delta',
        white_name: g.whiteName,
        black_name: g.blackName,
        white_elo: g.whiteElo,
        black_elo: g.blackElo,
        event: g.event,
        played_at: g.playedAt,
        date: g.date,
      };
      this.consumeGame(row, players, events);
    }

    const upsertedPlayers = await this.upsertPlayers([...players.values()]);
    const upsertedEvents = await this.upsertEvents([...events.values()]);

    if (upsertedPlayers > 0 || upsertedEvents > 0) {
      await this.refreshPlayerStats({ allowConcurrent: true }).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        // Refresh не блокирует API-чтения — кэш профиля живёт час и
        // в худшем случае покажет стейл данные. Логируем и идём дальше.
        this.logger.warn(`refreshPlayerStats failed (delta): ${msg}`);
      });
      await this.publishGauges().catch(() => {});
    }

    return { upsertedPlayers, upsertedEvents };
  }

  /** Обновляет gauge'и `archive_players_total` / `archive_events_total`. */
  private async publishGauges(): Promise<void> {
    try {
      const [pl] = await this.prisma.$queryRawUnsafe<Array<{ n: bigint | number }>>(
        'SELECT COUNT(*)::bigint AS n FROM archive_players',
      );
      const [ev] = await this.prisma.$queryRawUnsafe<Array<{ n: bigint | number }>>(
        'SELECT COUNT(*)::bigint AS n FROM archive_events',
      );
      this.metrics.archivePlayersTotal.set(typeof pl?.n === 'bigint' ? Number(pl.n) : Number(pl?.n ?? 0));
      this.metrics.archiveEventsTotal.set(typeof ev?.n === 'bigint' ? Number(ev.n) : Number(ev?.n ?? 0));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`publishGauges failed: ${msg}`);
    }
  }

  /** REFRESH MV. Возвращает использованный режим. */
  async refreshPlayerStats(opts: { allowConcurrent: boolean }): Promise<'initial' | 'concurrent'> {
    if (opts.allowConcurrent) {
      try {
        await this.prisma.$executeRawUnsafe(
          'REFRESH MATERIALIZED VIEW CONCURRENTLY archive_player_stats',
        );
        return 'concurrent';
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // CONCURRENTLY требует, чтобы MV был хотя бы раз заполнен и имел
        // UNIQUE-индекс. Если MV пустой — fallback на обычный REFRESH.
        if (/cannot refresh materialized view.*concurrently/i.test(msg)) {
          this.logger.warn(
            'REFRESH CONCURRENTLY отказал (MV пуст) — fallback на REFRESH без CONCURRENTLY',
          );
        } else {
          throw err;
        }
      }
    }
    await this.prisma.$executeRawUnsafe('REFRESH MATERIALIZED VIEW archive_player_stats');
    return 'initial';
  }

  // ─── Aggregation ─────────────────────────────────────────────────

  private consumeGame(
    r: RawArchiveGameRow,
    players: Map<string, PlayerAgg>,
    events: Map<string, EventAgg>,
  ): void {
    if (r.white_name) {
      this.aggregatePlayer(players, r.white_name, r.white_elo, r.played_at);
    }
    if (r.black_name) {
      this.aggregatePlayer(players, r.black_name, r.black_elo, r.played_at);
    }
    if (r.event) {
      this.aggregateEvent(events, r.event, r.date);
    }
  }

  private aggregatePlayer(
    map: Map<string, PlayerAgg>,
    rawName: string,
    elo: number | null,
    playedAt: Date | null,
  ): void {
    const trimmed = rawName.trim();
    if (!trimmed) return;
    const normalized = normalizeArchiveName(trimmed);
    if (!normalized) return;

    let agg = map.get(normalized);
    if (!agg) {
      agg = {
        nameNormalized: normalized,
        slug: archiveSlug(trimmed),
        aliases: new Set<string>(),
        rawNameCounts: new Map<string, number>(),
        gamesCount: 0,
        peakElo: null,
        firstSeenAt: null,
        lastSeenAt: null,
      };
      map.set(normalized, agg);
    }
    agg.aliases.add(trimmed);
    agg.rawNameCounts.set(trimmed, (agg.rawNameCounts.get(trimmed) ?? 0) + 1);
    agg.gamesCount += 1;
    if (elo != null && (agg.peakElo == null || elo > agg.peakElo)) {
      agg.peakElo = elo;
    }
    if (playedAt) {
      if (agg.firstSeenAt == null || playedAt < agg.firstSeenAt) {
        agg.firstSeenAt = playedAt;
      }
      if (agg.lastSeenAt == null || playedAt > agg.lastSeenAt) {
        agg.lastSeenAt = playedAt;
      }
    }
  }

  private aggregateEvent(
    map: Map<string, EventAgg>,
    rawName: string,
    date: string | null,
  ): void {
    const trimmed = rawName.trim();
    if (!trimmed) return;
    const normalized = normalizeArchiveName(trimmed);
    if (!normalized) return;

    let agg = map.get(normalized);
    if (!agg) {
      agg = {
        nameNormalized: normalized,
        slug: archiveSlug(trimmed),
        rawNameCounts: new Map<string, number>(),
        gamesCount: 0,
        firstDate: null,
        lastDate: null,
      };
      map.set(normalized, agg);
    }
    agg.rawNameCounts.set(trimmed, (agg.rawNameCounts.get(trimmed) ?? 0) + 1);
    agg.gamesCount += 1;
    if (date) {
      if (agg.firstDate == null || date < agg.firstDate) agg.firstDate = date;
      if (agg.lastDate == null || date > agg.lastDate) agg.lastDate = date;
    }
  }

  private pickCanonical(rawNameCounts: Map<string, number>): string {
    let best = '';
    let bestCount = -1;
    for (const [name, count] of rawNameCounts) {
      if (count > bestCount || (count === bestCount && name < best)) {
        best = name;
        bestCount = count;
      }
    }
    return best;
  }

  // ─── DB I/O ──────────────────────────────────────────────────────

  private async fetchChunk(lastId: string | null): Promise<RawArchiveGameRow[]> {
    if (lastId === null) {
      return this.prisma.$queryRawUnsafe<RawArchiveGameRow[]>(
        `SELECT id::text, white_name, black_name, white_elo, black_elo, event, played_at, date
           FROM archive_games
           ORDER BY id ASC
           LIMIT $1`,
        READ_CHUNK_SIZE,
      );
    }
    return this.prisma.$queryRawUnsafe<RawArchiveGameRow[]>(
      `SELECT id::text, white_name, black_name, white_elo, black_elo, event, played_at, date
         FROM archive_games
         WHERE id > $1::uuid
         ORDER BY id ASC
         LIMIT $2`,
      lastId,
      READ_CHUNK_SIZE,
    );
  }

  private async bulkInsertPlayers(aggs: PlayerAgg[]): Promise<number> {
    let inserted = 0;
    for (let i = 0; i < aggs.length; i += INSERT_CHUNK_SIZE) {
      const chunk = aggs.slice(i, i + INSERT_CHUNK_SIZE);
      const rows = chunk.map((a) => this.serializePlayer(a));
      // 9 колонок (id берётся default'ом).
      const valuesSql: string[] = [];
      const params: unknown[] = [];
      for (const r of rows) {
        const base = params.length;
        valuesSql.push(
          `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, NOW())`,
        );
        params.push(
          r.slug,
          r.name_canonical,
          r.name_normalized,
          r.name_aliases,
          r.games_count,
          r.peak_elo,
          r.first_seen_at,
          r.last_seen_at,
        );
      }
      const sql = `
        INSERT INTO archive_players
          (slug, name_canonical, name_normalized, name_aliases, games_count, peak_elo, first_seen_at, last_seen_at, updated_at)
        VALUES ${valuesSql.join(',')}
        ON CONFLICT (slug) DO NOTHING
      `;
      await this.prisma.$executeRawUnsafe(sql, ...params);
      inserted += chunk.length;
      this.logger.log(`backfill: players ${inserted}/${aggs.length}`);
    }
    return inserted;
  }

  private async bulkInsertEvents(aggs: EventAgg[]): Promise<number> {
    let inserted = 0;
    for (let i = 0; i < aggs.length; i += INSERT_CHUNK_SIZE) {
      const chunk = aggs.slice(i, i + INSERT_CHUNK_SIZE);
      const valuesSql: string[] = [];
      const params: unknown[] = [];
      for (const a of chunk) {
        const r = this.serializeEvent(a);
        const base = params.length;
        valuesSql.push(
          `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, NOW())`,
        );
        params.push(
          r.slug,
          r.name_canonical,
          r.name_normalized,
          r.games_count,
          r.first_date,
          r.last_date,
        );
      }
      const sql = `
        INSERT INTO archive_events
          (slug, name_canonical, name_normalized, games_count, first_date, last_date, updated_at)
        VALUES ${valuesSql.join(',')}
        ON CONFLICT (slug) DO NOTHING
      `;
      await this.prisma.$executeRawUnsafe(sql, ...params);
      inserted += chunk.length;
      this.logger.log(`backfill: events ${inserted}/${aggs.length}`);
    }
    return inserted;
  }

  private async upsertPlayers(aggs: PlayerAgg[]): Promise<number> {
    let upserted = 0;
    for (const a of aggs) {
      const r = this.serializePlayer(a);
      // UPSERT с приращением gamesCount: при конфликте по slug —
      //   аугментируем aliases (string concat dedup'ится при backfill'е),
      //   gamesCount += новые,
      //   peak_elo = GREATEST,
      //   first_seen_at/last_seen_at — расширяем диапазон.
      // KS-2064: aliases дедуплицируются на стороне SQL через `string_to_array`
      // + `array_distinct` симуляцией: проще — конкатенация, дубли в FTS не критичны.
      await this.prisma.$executeRawUnsafe(
        `
        INSERT INTO archive_players
          (slug, name_canonical, name_normalized, name_aliases, games_count, peak_elo, first_seen_at, last_seen_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
        ON CONFLICT (slug) DO UPDATE SET
          name_aliases = CASE
            WHEN archive_players.name_aliases ILIKE '%' || EXCLUDED.name_canonical || '%'
              THEN archive_players.name_aliases
            ELSE archive_players.name_aliases || ', ' || EXCLUDED.name_canonical
          END,
          games_count = archive_players.games_count + EXCLUDED.games_count,
          peak_elo = GREATEST(archive_players.peak_elo, EXCLUDED.peak_elo),
          first_seen_at = LEAST(archive_players.first_seen_at, EXCLUDED.first_seen_at),
          last_seen_at = GREATEST(archive_players.last_seen_at, EXCLUDED.last_seen_at),
          updated_at = NOW()
        `,
        r.slug,
        r.name_canonical,
        r.name_normalized,
        r.name_aliases,
        r.games_count,
        r.peak_elo,
        r.first_seen_at,
        r.last_seen_at,
      );
      upserted += 1;
    }
    return upserted;
  }

  private async upsertEvents(aggs: EventAgg[]): Promise<number> {
    let upserted = 0;
    for (const a of aggs) {
      const r = this.serializeEvent(a);
      await this.prisma.$executeRawUnsafe(
        `
        INSERT INTO archive_events
          (slug, name_canonical, name_normalized, games_count, first_date, last_date, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, NOW())
        ON CONFLICT (slug) DO UPDATE SET
          games_count = archive_events.games_count + EXCLUDED.games_count,
          first_date = LEAST(archive_events.first_date, EXCLUDED.first_date),
          last_date = GREATEST(archive_events.last_date, EXCLUDED.last_date),
          updated_at = NOW()
        `,
        r.slug,
        r.name_canonical,
        r.name_normalized,
        r.games_count,
        r.first_date,
        r.last_date,
      );
      upserted += 1;
    }
    return upserted;
  }

  // ─── Serialization ───────────────────────────────────────────────

  private serializePlayer(a: PlayerAgg): {
    slug: string;
    name_canonical: string;
    name_normalized: string;
    name_aliases: string;
    games_count: number;
    peak_elo: number | null;
    first_seen_at: Date | null;
    last_seen_at: Date | null;
  } {
    return {
      slug: a.slug,
      name_canonical: this.pickCanonical(a.rawNameCounts),
      name_normalized: a.nameNormalized,
      name_aliases: [...a.aliases].join(', '),
      games_count: a.gamesCount,
      peak_elo: a.peakElo,
      first_seen_at: a.firstSeenAt,
      last_seen_at: a.lastSeenAt,
    };
  }

  private serializeEvent(a: EventAgg): {
    slug: string;
    name_canonical: string;
    name_normalized: string;
    games_count: number;
    first_date: string | null;
    last_date: string | null;
  } {
    return {
      slug: a.slug,
      name_canonical: this.pickCanonical(a.rawNameCounts),
      name_normalized: a.nameNormalized,
      games_count: a.gamesCount,
      first_date: a.firstDate,
      last_date: a.lastDate,
    };
  }
}
