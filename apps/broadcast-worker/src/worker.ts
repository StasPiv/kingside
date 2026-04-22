import { PrismaClient } from '@kingside/broadcasts-db';
import Redis from 'ioredis';
import { createHash } from 'crypto';
import { Chess } from 'chess.js';

const LICHESS_API = 'https://lichess.org/api';
const SYNC_INTERVAL_MS = 5 * 60 * 1000;
// KS-1700 Part A: после N пропусков в Lichess top-20 подряд broadcast
// помечается isActive=false. Default 72 цикла × 5 мин = 6 часов.
const DEFAULT_STALE_CYCLES = 72;
const MISS_COUNT_KEY_PREFIX = 'broadcast:miss-count:';
const PINNED_POLL_INTERVAL_MS = 60_000;
const MAX_PGN_POLLS_PER_CYCLE = 5;
const REDIS_FEN_TTL = 60 * 60 * 12;
const MAX_CONCURRENT_STREAMS = 50;
const FETCH_TIMEOUT_MS = 30_000;
const FETCH_COOLDOWN_TTL = 60 * 60;
const SYNC_LOCK_KEY = 'broadcast:sync:lock';
const SYNC_LOCK_TTL = 4 * 60;
const PINNED_LOCK_KEY = 'broadcast:pinned:lock';
const PINNED_LOCK_TTL = 50;
const PGN_HASH_TTL = 300;
const RATE_LIMIT_DELAY_MS = 1500;
const RATE_LIMIT_429_BACKOFF_TTL = 60;
const STARTING_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/** Redis pub/sub channels */
export const BROADCAST_MOVE_CHANNEL = 'broadcast:move';
export const BROADCAST_SYNC_CHANNEL = 'broadcast:sync';

interface LichessBroadcast {
  tour: { id: string; name: string; description?: string; url?: string; image?: string; dates?: [number, number]; info?: { format?: string; tc?: string; location?: string; players?: string; website?: string; standings?: string } };
  rounds: LichessRound[];
}

interface LichessRound {
  id: string; name: string; startsAt?: number; ongoing?: boolean; finished?: boolean;
}

interface ParsedGame {
  index: number; white: string; black: string; whiteElo: number | null; blackElo: number | null; result: string; fen: string; uci: string; pgn: string; lichessGameId: string | null;
}

export class BroadcastWorker {
  // KS-1697: broadcast-worker пишет в отдельную БД broadcasts_kingside
  // (ADR-021 §2.1). Использует переменную BROADCASTS_DATABASE_URL.
  private readonly prisma = new PrismaClient({
    datasourceUrl:
      process.env.BROADCASTS_DATABASE_URL ?? process.env.DATABASE_URL,
  });
  private readonly redis: Redis;
  private readonly pubRedis: Redis;
  private syncTimer: NodeJS.Timeout | null = null;
  private pinnedPollTimer: NodeJS.Timeout | null = null;
  private readonly activeStreams = new Map<string, AbortController>();
  private pollOffset = 0;
  private rateLimitBackoffUntil = 0;
  private stopped = false;

  constructor() {
    const redisHost = process.env.REDIS_HOST || 'localhost';
    const redisPort = parseInt(process.env.REDIS_PORT || '6380', 10);
    this.redis = new Redis({ host: redisHost, port: redisPort });
    this.pubRedis = new Redis({ host: redisHost, port: redisPort });
  }

  async start(): Promise<void> {
    const redisHost = process.env.REDIS_HOST || 'localhost';
    const redisPort = process.env.REDIS_PORT || '6380';
    console.log(`[broadcast-worker] Starting... Redis=${redisHost}:${redisPort}`);

    // Clear stale locks from previous instance
    await this.redis.del(SYNC_LOCK_KEY, PINNED_LOCK_KEY).catch(() => {});
    console.log('[broadcast-worker] Cleared stale locks');

    // DB connectivity check
    const dbUrlRaw = process.env.BROADCASTS_DATABASE_URL ?? process.env.DATABASE_URL ?? '';
    const dbUrl = dbUrlRaw.replace(/\/\/[^@]*@/, '//***@');
    const dbUrlSource = process.env.BROADCASTS_DATABASE_URL
      ? 'BROADCASTS_DATABASE_URL'
      : 'DATABASE_URL (fallback)';
    console.log(`[broadcast-worker] DB URL (${dbUrlSource})=${dbUrl}`);
    try {
      const start = Date.now();
      await this.prisma.$queryRawUnsafe('SELECT 1');
      console.log(`[broadcast-worker] DB reachable (${Date.now() - start}ms)`);
    } catch (e: any) {
      console.error(`[broadcast-worker] DB UNREACHABLE: ${e.message}`);
    }

    // Lichess API connectivity check
    try {
      const testRes = await fetch('https://lichess.org/api', { signal: AbortSignal.timeout(10_000) });
      console.log(`[broadcast-worker] Lichess API reachable: ${testRes.status}`);
    } catch (e: any) {
      console.error(`[broadcast-worker] Lichess API UNREACHABLE: ${e.message} cause=${(e.cause as any)?.message ?? 'none'}`);
    }

    await this.syncBroadcasts();
    this.syncTimer = setInterval(() => {
      this.syncBroadcasts().catch((e) => console.error(`[broadcast-worker] Sync error: ${e.message}`));
    }, SYNC_INTERVAL_MS);

    await this.syncPinnedBroadcasts();
    this.pinnedPollTimer = setInterval(() => {
      this.syncPinnedBroadcasts().catch((e) => console.error(`[broadcast-worker] PGN poll error: ${e.message}`));
    }, PINNED_POLL_INTERVAL_MS);

    console.log('[broadcast-worker] Running');
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.syncTimer) clearInterval(this.syncTimer);
    if (this.pinnedPollTimer) clearInterval(this.pinnedPollTimer);

    for (const [roundId, ctrl] of this.activeStreams) {
      ctrl.abort();
      console.log(`[broadcast-worker] Stream aborted for round ${roundId}`);
    }
    this.activeStreams.clear();

    await this.redis.del(SYNC_LOCK_KEY, PINNED_LOCK_KEY).catch(() => {});
    await this.redis.quit().catch(() => {});
    await this.pubRedis.quit().catch(() => {});
    await this.prisma.$disconnect();
    console.log('[broadcast-worker] Stopped');
  }

  // --- Lichess fetch ---

  private async lichessFetch(url: string, init?: RequestInit): Promise<Response> {
    if (Date.now() < this.rateLimitBackoffUntil) {
      const secsLeft = Math.ceil((this.rateLimitBackoffUntil - Date.now()) / 1000);
      throw new Error(`Lichess 429 backoff active (${secsLeft}s left)`);
    }
    try {
      const res = await fetch(url, {
        ...init,
        signal: init?.signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (res.status === 429) {
        this.rateLimitBackoffUntil = Date.now() + RATE_LIMIT_429_BACKOFF_TTL * 1000;
        console.warn(`[broadcast-worker] Lichess 429 on ${url}. Backing off ${RATE_LIMIT_429_BACKOFF_TTL}s`);
        throw new Error('Lichess 429 Too Many Requests');
      }
      return res;
    } catch (e: any) {
      // Enhanced diagnostics for network errors
      console.error(`[broadcast-worker] lichessFetch FAILED url=${url} error=${e.message} cause=${(e.cause as any)?.message ?? 'none'}`);
      throw e;
    }
  }

  private rateLimitDelay(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_DELAY_MS));
  }

  private async acquireLock(key: string, ttlSec: number): Promise<boolean> {
    try {
      const result = await this.redis.set(key, process.pid.toString(), 'EX', ttlSec, 'NX');
      return result === 'OK';
    } catch { return false; }
  }

  // --- Redis pub/sub ---

  private publishMove(roundId: string, payload: { roundId: string; gameIndex: number; uci: string; fen: string; whitePlayer: string; blackPlayer: string }): void {
    this.pubRedis.publish(BROADCAST_MOVE_CHANNEL, JSON.stringify(payload)).catch((e) =>
      console.error(`[broadcast-worker] Publish move error: ${e.message}`),
    );
  }

  private publishSync(roundId: string, payload: object): void {
    this.pubRedis.publish(BROADCAST_SYNC_CHANNEL, JSON.stringify(payload)).catch((e) =>
      console.error(`[broadcast-worker] Publish sync error: ${e.message}`),
    );
  }

  // --- Sync logic (ported from BroadcastSyncService) ---

  async syncBroadcasts(): Promise<void> {
    if (!await this.acquireLock(SYNC_LOCK_KEY, SYNC_LOCK_TTL)) {
      console.log('[broadcast-worker] syncBroadcasts: lock not acquired, skipping');
      return;
    }
    console.log('[broadcast-worker] Syncing broadcasts from Lichess...');

    try {
      const broadcasts = await this.fetchActiveBroadcasts();
      const currentLichessIds = new Set(broadcasts.map((b) => b.tour.id));

      console.log(`[broadcast-worker] Processing ${broadcasts.length} broadcasts...`);
      let fetchCount = 0;
      for (let idx = 0; idx < broadcasts.length; idx++) {
        const bc = broadcasts[idx];
        console.log(`[broadcast-worker] [${idx + 1}/${broadcasts.length}] upsert ${bc.tour.id} "${bc.tour.name}"`);
        try {
          await this.upsertBroadcast(bc);
        } catch (e: any) {
          console.error(`[broadcast-worker] upsertBroadcast FAILED ${bc.tour.id}: ${e.message}`);
          continue;
        }
        for (const round of bc.rounds) {
          const isActive = round.ongoing === true;
          try {
            await this.upsertRound(bc.tour.id, round, isActive);
          } catch (e: any) {
            console.error(`[broadcast-worker] upsertRound FAILED ${round.id}: ${e.message}`);
            continue;
          }
          if (isActive) {
            if (!this.activeStreams.has(round.id)) {
              if (this.activeStreams.size < MAX_CONCURRENT_STREAMS) {
                this.startStream(round.id);
              }
            }
          }
          // Finished rounds: re-fetch if games have no result or starting FEN
          if (round.finished && fetchCount < MAX_PGN_POLLS_PER_CYCLE) {
            try {
              await this.rateLimitDelay();
              const fetched = await this.fetchFinishedRoundGamesIfEmpty(round.id);
              if (fetched) fetchCount++;
            } catch (e: any) {
              console.warn(`[broadcast-worker] fetchFinishedRoundGamesIfEmpty failed ${round.id}: ${e.message}`);
            }
          }
        }
      }

      const activeRoundIds = new Set(broadcasts.flatMap((b) => b.rounds.filter((r) => r.ongoing).map((r) => r.id)));
      for (const [roundId, ctrl] of this.activeStreams) {
        if (!activeRoundIds.has(roundId)) {
          ctrl.abort();
          this.activeStreams.delete(roundId);
        }
      }

      // KS-1700 Part A: маркируем stale broadcasts. Защита от false-negative —
      // выполняем только если fetch вернул хотя бы что-то (пустой top-20 =
      // Lichess не ответил, не надо на его основании архивить свою БД).
      if (broadcasts.length > 0) {
        await this.checkStaleBroadcasts(currentLichessIds);
      } else {
        console.warn('[broadcast-worker] Empty Lichess response — skipping stale check to avoid false-negatives');
      }
    } catch (e: any) {
      console.error(`[broadcast-worker] Sync failed: ${e.message}`);
    }
  }

  /**
   * KS-1700 Part A: после N циклов отсутствия broadcast в Lichess top-20 —
   * `isActive=false`. Запись не удаляется, игры и раунды остаются для
   * исторических страниц. При возвращении в top-20 `upsertBroadcast` вернёт
   * `isActive=true`, а счётчик сбросится здесь же (ветка seen).
   *
   * Счётчик живёт в Redis — переживает перезапуск. TTL = N × SYNC_INTERVAL × 2,
   * чтобы между циклами не истёк, но и не накапливался вечно.
   *
   * Примечание про pinned: отдельного env-override после KS-1701 cleanup нет,
   * pinned считается на лету в broadcast-service по avg Elo. Stale-check
   * применяется ко всем isActive=true, включая ранее-pinned.
   */
  private async checkStaleBroadcasts(
    currentLichessIds: Set<string>,
  ): Promise<void> {
    const staleCycles = parseInt(
      process.env.BROADCAST_STALE_CYCLES ?? String(DEFAULT_STALE_CYCLES),
      10,
    );
    if (isNaN(staleCycles) || staleCycles < 1) {
      console.warn(
        `[broadcast-worker] Invalid BROADCAST_STALE_CYCLES, skipping stale check`,
      );
      return;
    }
    const ttlSeconds = Math.ceil((staleCycles * SYNC_INTERVAL_MS * 2) / 1000);

    await runStaleCheck({
      prisma: this.prisma,
      redis: this.redis,
      currentLichessIds,
      staleCycles,
      ttlSeconds,
      keyPrefix: MISS_COUNT_KEY_PREFIX,
      logger: console,
    });
  }

  async syncPinnedBroadcasts(): Promise<void> {
    if (!await this.acquireLock(PINNED_LOCK_KEY, PINNED_LOCK_TTL)) {
      console.log('[broadcast-worker] syncPinnedBroadcasts: lock not acquired, skipping');
      return;
    }

    const ongoingRounds = await this.prisma.broadcastRound.findMany({
      where: { status: 'ongoing' },
      select: { lichessRoundId: true },
    });

    // Exclude rounds that already have an active stream — they get data via streaming, no need to poll
    const streamedRoundIds = new Set(this.activeStreams.keys());
    const nonStreamedRounds = ongoingRounds.filter((r) => !streamedRoundIds.has(r.lichessRoundId));

    const toFetch: typeof nonStreamedRounds = [];
    if (nonStreamedRounds.length > 0) {
      this.pollOffset = this.pollOffset % nonStreamedRounds.length;
      const take = Math.min(MAX_PGN_POLLS_PER_CYCLE, nonStreamedRounds.length);
      for (let i = 0; i < take; i++) {
        toFetch.push(nonStreamedRounds[(this.pollOffset + i) % nonStreamedRounds.length]);
      }
      this.pollOffset = (this.pollOffset + take) % nonStreamedRounds.length;
    }

    for (let i = 0; i < toFetch.length; i++) {
      if (i > 0) await this.rateLimitDelay();
      await this.fetchAndProcessRoundPgn(toFetch[i].lichessRoundId).catch((e: Error) =>
        console.warn(`[broadcast-worker] PGN poll failed for ${toFetch[i].lichessRoundId}: ${e.message}`),
      );
    }
  }

  private async fetchAndProcessRoundPgn(lichessRoundId: string): Promise<void> {
    const url = `${LICHESS_API}/broadcast/round/${lichessRoundId}.pgn`;
    const res = await this.lichessFetch(url, {
      headers: { 'User-Agent': 'Kingside/1.0 (https://kingside.app)', Accept: 'application/x-chess-pgn' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return;
    const pgn = await res.text();
    if (!pgn.trim()) return;

    const hashKey = `broadcast:pgn-hash:${lichessRoundId}`;
    const newHash = createHash('md5').update(pgn).digest('hex');
    try {
      const prevHash = await this.redis.get(hashKey);
      if (prevHash === newHash) {
        const round = await this.prisma.broadcastRound.findUnique({ where: { lichessRoundId } });
        if (round) {
          const reallyStale = await this.prisma.$queryRaw<[{count: bigint}]>`
            SELECT count(*)::bigint as count FROM broadcast_games
            WHERE round_id = ${round.id}::uuid
              AND current_fen = ${STARTING_FEN}
              AND LENGTH(pgn) > 500`;
          if (Number(reallyStale[0].count) === 0) return;
        }
      }
      await this.redis.set(hashKey, newHash, 'EX', PGN_HASH_TTL);
    } catch { /* proceed */ }

    await this.processPgnUpdate(lichessRoundId, pgn);

    // Publish full sync via Redis pub/sub
    const round = await this.prisma.broadcastRound.findUnique({
      where: { lichessRoundId },
      include: { games: true },
    });
    if (round) {
      this.publishSync(round.id, {
        roundId: round.id,
        games: round.games.map((g, idx) => ({
          gameIndex: idx,
          fen: g.currentFen ?? STARTING_FEN,
          whitePlayer: g.whitePlayer ?? 'Unknown',
          blackPlayer: g.blackPlayer ?? 'Unknown',
          result: g.result ?? null,
          pgn: g.pgn ?? null,
        })),
      });
    }
  }

  private async fetchActiveBroadcasts(): Promise<LichessBroadcast[]> {
    const url = `${LICHESS_API}/broadcast?nb=20`;
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        // Use a single AbortSignal for both fetch and body read
        const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
        const res = await this.lichessFetch(url, {
          headers: { Accept: 'application/x-ndjson', 'User-Agent': 'Kingside/1.0 (https://kingside.app)' },
          signal,
        });
        if (!res.ok) throw new Error(`Lichess API error: ${res.status}`);
        const text = await res.text(); // signal aborts body read too
        const broadcasts: LichessBroadcast[] = [];
        for (const line of text.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try { broadcasts.push(JSON.parse(trimmed)); } catch { /* skip */ }
        }
        console.log(`[broadcast-worker] Fetched ${broadcasts.length} broadcasts from Lichess (attempt ${attempt + 1})`);
        return broadcasts;
      } catch (e: any) {
        lastError = e;
        if (attempt < 2) {
          const delay = (attempt + 1) * 5000;
          console.warn(`[broadcast-worker] fetchActiveBroadcasts attempt ${attempt + 1} failed: ${e.message}. Retry in ${delay}ms`);
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }
    throw lastError ?? new Error('fetchActiveBroadcasts failed');
  }

  private async upsertBroadcast(bc: LichessBroadcast): Promise<void> {
    const info = bc.tour.info;
    const dates = bc.tour.dates;
    const fields = {
      title: bc.tour.name, description: bc.tour.description ?? null, url: bc.tour.url ?? null,
      isActive: true, format: info?.format ?? null, timeControl: info?.tc ?? null,
      location: info?.location ?? null, players: info?.players ?? null,
      website: info?.website ?? null, standingsUrl: info?.standings ?? null,
      imageUrl: bc.tour.image ?? null,
      startDate: dates?.[0] ? new Date(dates[0]) : null,
      endDate: dates?.[1] ? new Date(dates[1]) : null,
    };
    const start = Date.now();
    await this.prisma.broadcast.upsert({
      where: { lichessId: bc.tour.id },
      update: fields,
      create: { lichessId: bc.tour.id, ...fields },
    });
    console.log(`[broadcast-worker] upsertBroadcast OK: ${bc.tour.id} "${bc.tour.name}" (${Date.now() - start}ms)`);
  }

  private async upsertRound(broadcastLichessId: string, round: LichessRound, isActive: boolean): Promise<void> {
    const broadcast = await this.prisma.broadcast.findUnique({ where: { lichessId: broadcastLichessId } });
    if (!broadcast) return;
    const status = round.finished ? 'finished' : isActive ? 'ongoing' : 'pending';
    await this.prisma.broadcastRound.upsert({
      where: { lichessRoundId: round.id },
      update: { name: round.name, startsAt: round.startsAt ? new Date(round.startsAt) : null, status },
      create: { broadcastId: broadcast.id, lichessRoundId: round.id, name: round.name, startsAt: round.startsAt ? new Date(round.startsAt) : null, status },
    });
  }

  /** Returns true if an actual Lichess fetch was performed */
  private async fetchFinishedRoundGamesIfEmpty(lichessRoundId: string): Promise<boolean> {
    const round = await this.prisma.broadcastRound.findUnique({ where: { lichessRoundId } });
    if (!round) return false;

    const staleGames = await this.prisma.broadcastGame.count({
      where: { roundId: round.id, OR: [{ currentFen: STARTING_FEN }, { result: null }, { result: '*' }] },
    });
    const totalGames = await this.prisma.broadcastGame.count({ where: { roundId: round.id } });
    if (totalGames > 0 && staleGames === 0) return false;

    const cooldownKey = `broadcast:pgn-fetch-cooldown:${lichessRoundId}`;
    const cooldown = await this.redis.get(cooldownKey).catch(() => null);
    if (cooldown) return false;

    try {
      const url = `${LICHESS_API}/broadcast/round/${lichessRoundId}.pgn`;
      const res = await this.lichessFetch(url, {
        headers: { 'User-Agent': 'Kingside/1.0 (https://kingside.app)', Accept: 'application/x-chess-pgn' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) {
        await this.redis.set(cooldownKey, '1', 'EX', FETCH_COOLDOWN_TTL).catch(() => {});
        return true;
      }
      const pgn = await res.text();
      if (pgn.trim()) {
        await this.processPgnUpdate(lichessRoundId, pgn);
      } else {
        await this.redis.set(cooldownKey, '1', 'EX', FETCH_COOLDOWN_TTL).catch(() => {});
      }
      return true;
    } catch (e: any) {
      console.error(`[broadcast-worker] PGN fetch error ${lichessRoundId}: ${e.message}`);
      await this.redis.set(cooldownKey, '1', 'EX', FETCH_COOLDOWN_TTL).catch(() => {});
      return true;
    }
  }

  private startStream(roundId: string): void {
    const ctrl = new AbortController();
    this.activeStreams.set(roundId, ctrl);
    this.runStream(roundId, ctrl.signal).then(() => {
      // Stream ended (aborted or stopped) — clean up
      this.activeStreams.delete(roundId);
    });
  }

  private async runStream(roundId: string, signal: AbortSignal): Promise<void> {
    const url = `${LICHESS_API}/stream/broadcast/round/${roundId}.pgn`;
    let retryDelay = 2000;
    const maxDelay = 300_000; // 5 minutes — let Lichess rate limit reset

    while (!signal.aborted && !this.stopped) {
      try {
        const res = await fetch(url, { headers: { Accept: 'application/x-ndjson' }, signal });
        if (res.status === 429) {
          console.warn(`[broadcast-worker] Stream ${roundId}: 429 rate limited, stopping stream (PGN poll will take over)`);
          return; // Exit runStream — activeStreams.delete in startStream.then()
        }
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        retryDelay = 2000;
        const decoder = new TextDecoder();
        let buffer = '';
        for await (const chunk of res.body as any) {
          if (signal.aborted) break;
          buffer += decoder.decode(chunk, { stream: true });
          // Lichess PGN stream separates full updates with triple newline
          const parts = buffer.split('\n\n\n');
          buffer = parts.pop() ?? '';
          for (const part of parts) {
            const pgn = part.trim();
            if (!pgn) continue;
            await this.processPgnUpdate(roundId, pgn);
          }
        }
      } catch (e: any) {
        if (signal.aborted) break;
        console.warn(`[broadcast-worker] Stream ${roundId} disconnected: ${e.message}. Retry in ${retryDelay}ms`);
        await this.sleep(retryDelay, signal);
        retryDelay = Math.min(retryDelay * 2, maxDelay);
      }
    }
  }

  private async processPgnUpdate(roundId: string, pgn: string): Promise<void> {
    const games = this.parsePgnGames(pgn);
    const round = await this.prisma.broadcastRound.findUnique({ where: { lichessRoundId: roundId } });
    if (!round) {
      console.warn(`[broadcast-worker] processPgnUpdate: round ${roundId} not found in DB`);
      return;
    }
    console.log(`[broadcast-worker] processPgnUpdate: round=${roundId.slice(0, 8)} games=${games.length} withUci=${games.filter(g => g.uci).length}`);

    for (const game of games) {
      const isStarting = game.fen === STARTING_FEN;
      console.log(`[broadcast-worker] game[${game.index}] ${game.white} vs ${game.black} fen=${isStarting ? 'STARTING' : game.fen.slice(0, 30)} uci=${game.uci || 'NONE'} lichessId=${game.lichessGameId?.slice(0, 8) ?? 'null'} pgnLen=${game.pgn.length}`);
      if (!isStarting) {
        await this.redis.set(`broadcast:fen:${roundId}:${game.index}`, game.fen, 'EX', REDIS_FEN_TTL).catch(() => {});
      }

      if (game.lichessGameId) {
        const existing = await this.prisma.broadcastGame.findFirst({
          where: { roundId: round.id, lichessGameId: game.lichessGameId },
        });
        if (existing) {
          const wouldRegress = game.fen === STARTING_FEN && existing.currentFen && existing.currentFen !== STARTING_FEN;
          const newFen = wouldRegress ? existing.currentFen! : game.fen;
          await this.prisma.broadcastGame.update({
            where: { id: existing.id },
            data: {
              whitePlayer: game.white,
              blackPlayer: game.black,
              whiteElo: game.whiteElo ?? existing.whiteElo,
              blackElo: game.blackElo ?? existing.blackElo,
              result: game.result || null,
              pgn: game.pgn,
              currentFen: newFen,
            },
          });
        } else {
          await this.prisma.broadcastGame.create({
            data: {
              roundId: round.id,
              lichessGameId: game.lichessGameId,
              whitePlayer: game.white,
              blackPlayer: game.black,
              whiteElo: game.whiteElo,
              blackElo: game.blackElo,
              result: game.result || null,
              pgn: game.pgn,
              currentFen: game.fen,
            },
          });
        }
      }

      // Publish move via Redis pub/sub (instead of gateway.emitMove)
      if (game.uci) {
        this.publishMove(round.id, {
          roundId: round.id, gameIndex: game.index, uci: game.uci, fen: game.fen,
          whitePlayer: game.white, blackPlayer: game.black,
        });
      }
    }
  }

  private parsePgnGames(rawPgn: string): ParsedGame[] {
    const cleanedPgn = rawPgn.split('\n').filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return true;
      if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        try { JSON.parse(trimmed); return false; } catch { return true; }
      }
      return true;
    }).join('\n');

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
      const whiteElo = this.parseElo(headerMap['WhiteElo']);
      const blackElo = this.parseElo(headerMap['BlackElo']);
      const result = headerMap['Result'] ?? '';
      const lastMove = headerMap['LastMove'] ?? '';
      const site = headerMap['Site'] ?? '';
      const lichessGameId = site.split('/').pop() ?? null;

      const { fen: computedFen, lastUci } = this.computeFenAndLastUci(section);
      const fen = fenValue || computedFen || STARTING_FEN;
      const uci = lastMove || lastUci;

      games.push({ index, white, black, whiteElo, blackElo, result, fen, uci, pgn: section.trim(), lichessGameId: lichessGameId || null });
      index++;
    }
    return games;
  }

  private parseElo(raw: string | undefined): number | null {
    if (!raw) return null;
    const trimmed = raw.trim();
    if (!trimmed || trimmed === '?' || trimmed === '-') return null;
    const n = parseInt(trimmed, 10);
    if (isNaN(n) || n <= 0 || n > 4000) return null;
    return n;
  }

  private computeFenAndLastUci(pgnText: string): { fen: string | null; lastUci: string } {
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
    } catch { /* loadPgn failed */ }
    return { fen: null, lastUci: '' };
  }

  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); });
    });
  }
}

// --- KS-1700 Part A: exported pure stale-check (testable) -------------------

export interface StaleCheckPrisma {
  broadcast: {
    findMany(args: {
      where: { isActive: boolean };
      select: { id: boolean; lichessId: boolean; title: boolean };
    }): Promise<Array<{ id: string; lichessId: string; title: string }>>;
    update(args: {
      where: { id: string };
      data: { isActive: boolean };
    }): Promise<unknown>;
  };
}

export interface StaleCheckRedis {
  incr(key: string): Promise<number>;
  expire(key: string, ttlSeconds: number): Promise<number | 'OK'>;
  del(key: string): Promise<number>;
}

export interface StaleCheckLogger {
  log(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export interface StaleCheckResult {
  marked: number;
  incremented: number;
  reset: number;
  scanned: number;
}

/**
 * Чистая функция stale-check (без привязки к классу и TCP-коннектам).
 *
 * Для каждого `isActive=true` broadcast:
 *  - если он в `currentLichessIds` — счётчик сбрасывается.
 *  - иначе — инкремент. На первом инкременте ставим TTL.
 *  - если счётчик достиг `staleCycles` — `isActive=false` и счётчик удаляется.
 *
 * Ошибки Redis/Prisma логируются но не прерывают обход (один сломанный
 * broadcast не должен ломать весь цикл).
 */
export async function runStaleCheck(opts: {
  prisma: StaleCheckPrisma;
  redis: StaleCheckRedis;
  currentLichessIds: Set<string>;
  staleCycles: number;
  ttlSeconds: number;
  keyPrefix: string;
  logger: StaleCheckLogger;
}): Promise<StaleCheckResult> {
  const { prisma, redis, currentLichessIds, staleCycles, ttlSeconds, keyPrefix, logger } = opts;
  const result: StaleCheckResult = { marked: 0, incremented: 0, reset: 0, scanned: 0 };

  const active = await prisma.broadcast.findMany({
    where: { isActive: true },
    select: { id: true, lichessId: true, title: true },
  });
  result.scanned = active.length;

  for (const bc of active) {
    const key = `${keyPrefix}${bc.lichessId}`;

    if (currentLichessIds.has(bc.lichessId)) {
      try {
        await redis.del(key);
        result.reset++;
      } catch { /* reset errors ignored — следующий цикл повторит */ }
      continue;
    }

    let count = 0;
    try {
      count = await redis.incr(key);
      if (count === 1) {
        await redis.expire(key, ttlSeconds);
      }
      result.incremented++;
    } catch (e: unknown) {
      logger.warn(
        `[broadcast-worker] Redis incr failed for ${bc.lichessId}: ${(e as Error).message}`,
      );
      continue;
    }

    if (count >= staleCycles) {
      try {
        await prisma.broadcast.update({
          where: { id: bc.id },
          data: { isActive: false },
        });
        try { await redis.del(key); } catch { /* cleanup best-effort */ }
        result.marked++;
        logger.log(
          `[broadcast-worker] Broadcast ${bc.lichessId} "${bc.title}" marked isActive=false after ${count} missed cycles`,
        );
      } catch (e: unknown) {
        logger.error(
          `[broadcast-worker] Failed to mark ${bc.lichessId} inactive: ${(e as Error).message}`,
        );
      }
    }
  }

  if (result.marked > 0) {
    logger.log(
      `[broadcast-worker] Stale check: marked ${result.marked} broadcasts isActive=false (cutoff=${staleCycles} cycles, scanned=${result.scanned})`,
    );
  }
  return result;
}
