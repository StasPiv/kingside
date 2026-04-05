import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createHash } from 'crypto';
import { Chess } from 'chess.js';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { BroadcastGateway } from './broadcast.gateway';

const LICHESS_API = 'https://lichess.org/api';
const SYNC_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes — metadata discovery only
const PINNED_POLL_INTERVAL_MS = 60_000; // 60 seconds for PGN polling
const MAX_PGN_POLLS_PER_CYCLE = 5; // max rounds to poll per cycle (avoid 429)
const REDIS_FEN_TTL = 60 * 60 * 12; // 12 hours
const MAX_CONCURRENT_STREAMS = 50;
const FETCH_TIMEOUT_MS = 30_000; // 30 seconds
const FETCH_COOLDOWN_TTL = 60 * 60; // 1 hour
const SYNC_LOCK_KEY = 'broadcast:sync:lock';
const SYNC_LOCK_TTL = 4 * 60; // 4 min — shorter than SYNC_INTERVAL_MS to auto-release
const PINNED_LOCK_KEY = 'broadcast:pinned:lock';
const PINNED_LOCK_TTL = 50; // seconds — shorter than PINNED_POLL_INTERVAL_MS (60s)
const PGN_HASH_TTL = 300; // 5 min — how long we remember PGN hash to skip re-parse
const RATE_LIMIT_DELAY_MS = 1500; // delay between sequential Lichess API calls
const RATE_LIMIT_429_BACKOFF_TTL = 60; // seconds — in-memory backoff on 429
const STARTING_FEN =
  'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

interface LichessBroadcast {
  tour: {
    id: string;
    name: string;
    description?: string;
    url?: string;
    image?: string;
    dates?: [number, number];
    info?: {
      format?: string;
      tc?: string;
      location?: string;
      players?: string;
      website?: string;
      standings?: string;
    };
  };
  rounds: LichessRound[];
}

interface LichessRound {
  id: string;
  name: string;
  startsAt?: number;
  ongoing?: boolean;
  finished?: boolean;
}

interface ParsedGame {
  index: number;
  white: string;
  black: string;
  result: string;
  fen: string;
  uci: string;
  pgn: string;
  lichessGameId: string | null;
}

@Injectable()
export class BroadcastSyncService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BroadcastSyncService.name);
  private syncTimer: NodeJS.Timeout | null = null;
  private pinnedPollTimer: NodeJS.Timeout | null = null;
  private readonly activeStreams = new Map<string, AbortController>();
  private gateway: BroadcastGateway | null = null;
  private readonly pinnedBroadcastIds: string[];
  /** In-memory 429 backoff — resets on restart, no Redis persistence issues */
  private rateLimitBackoffUntil = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {
    const ids = process.env.LICHESS_BROADCAST_IDS ?? '';
    this.pinnedBroadcastIds = ids.split(',').map((s) => s.trim()).filter(Boolean);
    if (this.pinnedBroadcastIds.length > 0) {
      this.logger.log(`Pinned broadcast IDs: ${this.pinnedBroadcastIds.join(', ')}`);
    }
  }

  setGateway(gateway: BroadcastGateway): void {
    this.gateway = gateway;
  }

  async onModuleInit(): Promise<void> {
    await this.syncBroadcasts();
    this.syncTimer = setInterval(() => {
      this.syncBroadcasts().catch((e) =>
        this.logger.error(`Sync error: ${e.message}`),
      );
    }, SYNC_INTERVAL_MS);

    // Frequent PGN polling for all ongoing rounds (10s interval)
    await this.syncPinnedBroadcasts();
    this.pinnedPollTimer = setInterval(() => {
      this.syncPinnedBroadcasts().catch((e) =>
        this.logger.error(`PGN poll error: ${e.message}`),
      );
    }, PINNED_POLL_INTERVAL_MS);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.syncTimer) clearInterval(this.syncTimer);
    if (this.pinnedPollTimer) clearInterval(this.pinnedPollTimer);
    for (const [roundId, ctrl] of this.activeStreams) {
      ctrl.abort();
      this.logger.log(`Stream aborted for round ${roundId}`);
    }
    this.activeStreams.clear();

    // Release distributed locks so new instances don't wait for TTL expiry
    await this.redis.del(SYNC_LOCK_KEY, PINNED_LOCK_KEY).catch(() => {});
    this.logger.log('Broadcast sync locks released');
  }

  /**
   * Rate-limited fetch wrapper for Lichess API.
   * - On 429: in-memory backoff for BACKOFF_TTL (resets on process restart)
   * - Logs warnings for non-ok responses
   */
  private async lichessFetch(url: string, init?: RequestInit): Promise<Response> {
    // Check in-memory 429 backoff
    if (Date.now() < this.rateLimitBackoffUntil) {
      const secsLeft = Math.ceil((this.rateLimitBackoffUntil - Date.now()) / 1000);
      throw new Error(`Lichess 429 backoff active (${secsLeft}s left) — skipping`);
    }

    const res = await fetch(url, init);

    if (res.status === 429) {
      this.rateLimitBackoffUntil = Date.now() + RATE_LIMIT_429_BACKOFF_TTL * 1000;
      this.logger.warn(`Lichess 429 on ${url}. Backing off for ${RATE_LIMIT_429_BACKOFF_TTL}s`);
      throw new Error('Lichess 429 Too Many Requests');
    }

    return res;
  }

  /** Delay between sequential Lichess API calls to avoid rate limiting */
  private rateLimitDelay(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_DELAY_MS));
  }

  /**
   * Acquire a distributed lock via Redis SET NX.
   * Returns true if lock was acquired, false if another instance holds it.
   */
  private async acquireLock(key: string, ttlSec: number): Promise<boolean> {
    try {
      const result = await this.redis.set(key, process.pid.toString(), 'EX', ttlSec, 'NX');
      return result === 'OK';
    } catch {
      return false; // Redis error — skip sync to be safe
    }
  }

  async syncBroadcasts(): Promise<void> {
    if (!await this.acquireLock(SYNC_LOCK_KEY, SYNC_LOCK_TTL)) {
      this.logger.debug('Sync lock held by another instance, skipping');
      return;
    }
    this.logger.log('Syncing broadcasts from Lichess...');

    try {
      const broadcasts = await this.fetchActiveBroadcasts();

      for (const bc of broadcasts) {
        await this.upsertBroadcast(bc);
        for (const round of bc.rounds) {
          const isActive = round.ongoing === true;
          await this.upsertRound(bc.tour.id, round, isActive);
          if (isActive) {
            // Start stream for live updates; snapshot PGN only via pinned polls
            if (!this.activeStreams.has(round.id)) {
              if (this.activeStreams.size < MAX_CONCURRENT_STREAMS) {
                this.startStream(round.id);
              } else {
                this.logger.warn(
                  `Max concurrent streams reached, skipping round ${round.id}`,
                );
              }
            }
          } else if (round.finished) {
            void this.fetchFinishedRoundGamesIfEmpty(round.id);
          }
        }
      }

      // Stop streams for rounds that are no longer active
      const activeRoundIds = new Set(
        broadcasts.flatMap((b) =>
          b.rounds.filter((r) => r.ongoing).map((r) => r.id),
        ),
      );
      for (const [roundId, ctrl] of this.activeStreams) {
        if (!activeRoundIds.has(roundId)) {
          ctrl.abort();
          this.activeStreams.delete(roundId);
          this.logger.log(`Stopped stream for inactive round ${roundId}`);
        }
      }
    } catch (e: any) {
      this.logger.error(`Failed to sync broadcasts: ${e.message}`);
    }
  }

  /**
   * Poll ongoing rounds for PGN updates.
   * Prioritizes pinned broadcasts, then other ongoing rounds.
   * Limited to MAX_PGN_POLLS_PER_CYCLE to avoid Lichess 429.
   */
  async syncPinnedBroadcasts(): Promise<void> {
    if (!await this.acquireLock(PINNED_LOCK_KEY, PINNED_LOCK_TTL)) {
      return;
    }

    // Get ongoing rounds, prioritize pinned broadcasts
    const ongoingRounds = await this.prisma.broadcastRound.findMany({
      where: { status: 'ongoing' },
      select: { lichessRoundId: true, broadcast: { select: { lichessId: true } } },
    });

    const pinnedSet = new Set(this.pinnedBroadcastIds);
    const pinned = ongoingRounds.filter((r) => pinnedSet.has(r.broadcast.lichessId));
    const others = ongoingRounds.filter((r) => !pinnedSet.has(r.broadcast.lichessId));

    // Pinned first, then others, capped at limit
    const toFetch = [...pinned, ...others].slice(0, MAX_PGN_POLLS_PER_CYCLE);

    this.logger.log(`PGN poll: ${toFetch.length}/${ongoingRounds.length} ongoing rounds (${pinned.length} pinned)`);

    for (let i = 0; i < toFetch.length; i++) {
      if (i > 0) await this.rateLimitDelay();
      await this.fetchAndProcessRoundPgn(toFetch[i].lichessRoundId).catch((e: Error) =>
        this.logger.warn(`PGN poll failed for ${toFetch[i].lichessRoundId}: ${e.message}`),
      );
    }
  }

  private async fetchBroadcastById(tourId: string): Promise<LichessBroadcast | null> {
    const url = `${LICHESS_API}/broadcast/${tourId}`;
    const res = await this.lichessFetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      this.logger.warn(`Failed to fetch broadcast ${tourId}: HTTP ${res.status}`);
      return null;
    }
    return res.json() as Promise<LichessBroadcast>;
  }

  private async fetchAndProcessRoundPgn(lichessRoundId: string): Promise<void> {
    const url = `${LICHESS_API}/broadcast/round/${lichessRoundId}.pgn`;
    const res = await this.lichessFetch(url, {
      headers: {
        'User-Agent': 'Kingside/1.0 (https://kingside.app)',
        Accept: 'application/x-chess-pgn',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return;
    const pgn = await res.text();
    if (!pgn.trim()) return;

    // Skip PGN parsing if content unchanged AND all games have real FEN
    const hashKey = `broadcast:pgn-hash:${lichessRoundId}`;
    const newHash = createHash('md5').update(pgn).digest('hex');
    try {
      const prevHash = await this.redis.get(hashKey);
      if (prevHash === newHash) {
        // PGN unchanged — re-parse only if games have STARTING_FEN but PGN with moves (>500 chars)
        // Short PGN (headers only) = no moves on Lichess = legitimate STARTING_FEN
        const round = await this.prisma.broadcastRound.findUnique({
          where: { lichessRoundId },
        });
        if (round) {
          const staleWithMoves = await this.prisma.broadcastGame.count({
            where: {
              roundId: round.id,
              currentFen: STARTING_FEN,
              pgn: { not: null },
              // Only count as stale if PGN is long enough to contain moves
              // Short PGN = headers only = no moves = legitimate STARTING_FEN
            },
          });
          // Check if any stale game has PGN long enough to have moves
          if (staleWithMoves === 0) return;
          const reallyStale = await this.prisma.$queryRaw<[{count: bigint}]>`
            SELECT count(*)::bigint as count FROM broadcast_games
            WHERE round_id = ${round.id}::uuid
              AND current_fen = ${STARTING_FEN}
              AND LENGTH(pgn) > 500`;
          if (Number(reallyStale[0].count) === 0) return;
          this.logger.log(`Re-parsing round ${lichessRoundId}: ${Number(reallyStale[0].count)} games with stale FEN (long PGN)`);
        }
      }
      await this.redis.set(hashKey, newHash, 'EX', PGN_HASH_TTL);
    } catch { /* Redis error — proceed with parse */ }

    await this.processPgnUpdate(lichessRoundId, pgn);

    // Emit full sync to subscribed clients
    if (this.gateway) {
      const round = await this.prisma.broadcastRound.findUnique({
        where: { lichessRoundId },
        include: { games: true },
      });
      if (round) {
        this.gateway.emitSync(round.id, {
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
  }

  private async fetchActiveBroadcasts(): Promise<LichessBroadcast[]> {
    const url = `${LICHESS_API}/broadcast?nb=20`;
    const res = await this.lichessFetch(url, {
      headers: { Accept: 'application/x-ndjson' },
    });
    if (!res.ok) {
      throw new Error(`Lichess API error: ${res.status}`);
    }
    const text = await res.text();
    const broadcasts: LichessBroadcast[] = [];
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        broadcasts.push(JSON.parse(trimmed));
      } catch (e: unknown) { this.logger.warn(`Broadcast sync parse error: ${(e as Error).message ?? e}`);
        // skip malformed lines
      }
    }
    return broadcasts;
  }

  private async upsertBroadcast(bc: LichessBroadcast): Promise<void> {
    const info = bc.tour.info;
    const dates = bc.tour.dates;
    const fields = {
      title: bc.tour.name,
      description: bc.tour.description ?? null,
      url: bc.tour.url ?? null,
      isActive: true,
      format: info?.format ?? null,
      timeControl: info?.tc ?? null,
      location: info?.location ?? null,
      players: info?.players ?? null,
      website: info?.website ?? null,
      standingsUrl: info?.standings ?? null,
      imageUrl: bc.tour.image ?? null,
      startDate: dates?.[0] ? new Date(dates[0]) : null,
      endDate: dates?.[1] ? new Date(dates[1]) : null,
    };

    await this.prisma.broadcast.upsert({
      where: { lichessId: bc.tour.id },
      update: fields,
      create: { lichessId: bc.tour.id, ...fields },
    });
  }

  private async upsertRound(
    broadcastLichessId: string,
    round: LichessRound,
    isActive: boolean,
  ): Promise<void> {
    const broadcast = await this.prisma.broadcast.findUnique({
      where: { lichessId: broadcastLichessId },
    });
    if (!broadcast) return;

    const status = round.finished ? 'finished' : isActive ? 'ongoing' : 'pending';

    await this.prisma.broadcastRound.upsert({
      where: { lichessRoundId: round.id },
      update: {
        name: round.name,
        startsAt: round.startsAt ? new Date(round.startsAt) : null,
        status,
      },
      create: {
        broadcastId: broadcast.id,
        lichessRoundId: round.id,
        name: round.name,
        startsAt: round.startsAt ? new Date(round.startsAt) : null,
        status,
      },
    });
  }

  private async fetchFinishedRoundGamesIfEmpty(
    lichessRoundId: string,
  ): Promise<void> {
    const round = await this.prisma.broadcastRound.findUnique({
      where: { lichessRoundId },
    });
    if (!round) return;

    // Re-fetch if any game still has starting FEN (previous parser bugs may have left stale data)
    const gamesWithStartingFen = await this.prisma.broadcastGame.count({
      where: { roundId: round.id, currentFen: STARTING_FEN },
    });
    const totalGames = await this.prisma.broadcastGame.count({
      where: { roundId: round.id },
    });
    if (totalGames > 0 && gamesWithStartingFen === 0) return;

    // Avoid repeated failures: skip if cooldown is active
    const cooldownKey = `broadcast:pgn-fetch-cooldown:${lichessRoundId}`;
    const cooldown = await this.redis.get(cooldownKey).catch(() => null);
    if (cooldown) return;

    try {
      const url = `${LICHESS_API}/broadcast/round/${lichessRoundId}.pgn`;
      const res = await this.lichessFetch(url, {
        headers: {
          'User-Agent': 'Kingside/1.0 (https://kingside.app)',
          Accept: 'application/x-chess-pgn',
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        this.logger.warn(
          `Failed to fetch PGN for finished round ${lichessRoundId}: HTTP ${res.status} ${res.statusText}. Body: ${body.slice(0, 500)}`,
        );
        await this.redis.set(cooldownKey, '1', 'EX', FETCH_COOLDOWN_TTL).catch(() => {});
        return;
      }
      const pgn = await res.text();
      if (pgn.trim()) {
        await this.processPgnUpdate(lichessRoundId, pgn);
        this.logger.log(
          `Fetched games for finished round ${lichessRoundId}`,
        );
      } else {
        // No games yet — retry after cooldown
        await this.redis.set(cooldownKey, '1', 'EX', FETCH_COOLDOWN_TTL).catch(() => {});
      }
    } catch (e: any) {
      const cause =
        e.cause instanceof Error ? e.cause.message : String(e.cause ?? '');
      this.logger.error(
        `Error fetching PGN for finished round ${lichessRoundId}: ${e.message}${cause ? ` (cause: ${cause})` : ''}`,
      );
      await this.redis.set(cooldownKey, '1', 'EX', FETCH_COOLDOWN_TTL).catch(() => {});
    }
  }

  private startStream(roundId: string): void {
    const ctrl = new AbortController();
    this.activeStreams.set(roundId, ctrl);
    this.logger.log(`Starting stream for round ${roundId}`);

    this.runStream(roundId, ctrl.signal).catch((e) => {
      if (!ctrl.signal.aborted) {
        this.logger.error(`Stream error for round ${roundId}: ${e.message}`);
      }
      this.activeStreams.delete(roundId);
    });
  }

  private async runStream(roundId: string, signal: AbortSignal): Promise<void> {
    const url = `${LICHESS_API}/stream/broadcast/round/${roundId}.pgn`;
    let retryDelay = 2000;
    const maxDelay = 60000;

    while (!signal.aborted) {
      try {
        const res = await fetch(url, {
          headers: { Accept: 'application/x-ndjson' },
          signal,
        });
        if (!res.ok || !res.body) {
          throw new Error(`HTTP ${res.status}`);
        }

        retryDelay = 2000;
        const decoder = new TextDecoder();
        let buffer = '';

        for await (const chunk of res.body as any) {
          if (signal.aborted) break;
          buffer += decoder.decode(chunk, { stream: true });
          const parts = buffer.split('\n\n');
          buffer = parts.pop() ?? '';
          for (const part of parts) {
            const pgn = part.trim();
            if (!pgn) continue;
            await this.processPgnUpdate(roundId, pgn);
          }
        }
      } catch (e: any) {
        if (signal.aborted) break;
        this.logger.warn(
          `Stream for round ${roundId} disconnected: ${e.message}. Retrying in ${retryDelay}ms`,
        );
        await this.sleep(retryDelay, signal);
        retryDelay = Math.min(retryDelay * 2, maxDelay);
      }
    }

    this.logger.log(`Stream ended for round ${roundId}`);
  }

  private async processPgnUpdate(roundId: string, pgn: string): Promise<void> {
    const games = this.parsePgnGames(pgn);
    const round = await this.prisma.broadcastRound.findUnique({
      where: { lichessRoundId: roundId },
    });
    if (!round) return;

    const startingCount = games.filter((g) => g.fen === STARTING_FEN).length;
    if (startingCount > 0) {
      this.logger.log(
        `processPgnUpdate ${roundId}: ${games.length} games parsed, ${startingCount} with STARTING_FEN, PGN size ${pgn.length}`,
      );
    }

    for (const game of games) {
      // Only cache FEN in Redis if it's a real position (not fallback STARTING_FEN)
      if (game.fen !== STARTING_FEN) {
        const fenKey = `broadcast:fen:${roundId}:${game.index}`;
        await this.redis.set(fenKey, game.fen, 'EX', REDIS_FEN_TTL).catch(() => {});
      }

      if (game.lichessGameId) {
        const existing = await this.prisma.broadcastGame.findFirst({
          where: { roundId: round.id, lichessGameId: game.lichessGameId },
        });
        if (existing) {
          // Never overwrite a real FEN with STARTING_FEN (parser may fail on some PGN formats)
          const wouldRegress = game.fen === STARTING_FEN && existing.currentFen && existing.currentFen !== STARTING_FEN;
          if (wouldRegress) {
            this.logger.warn(
              `Prevented FEN regression for ${game.white} vs ${game.black} (${game.lichessGameId}): ` +
              `parser returned STARTING_FEN, keeping existing ${existing.currentFen?.substring(0, 40)}`,
            );
          }
          const newFen = wouldRegress ? existing.currentFen! : game.fen;
          await this.prisma.broadcastGame.update({
            where: { id: existing.id },
            data: {
              whitePlayer: game.white,
              blackPlayer: game.black,
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
              result: game.result || null,
              pgn: game.pgn,
              currentFen: game.fen,
            },
          });
        }
      }

      if (this.gateway && game.uci) {
        this.gateway.emitMove(round.id, {
          roundId: round.id,
          gameIndex: game.index,
          uci: game.uci,
          fen: game.fen,
          whitePlayer: game.white,
          blackPlayer: game.black,
        });
      }
    }
  }

  private parsePgnGames(rawPgn: string): ParsedGame[] {
    // Filter out JSON lines from NDJSON responses
    const cleanedPgn = rawPgn
      .split('\n')
      .filter((line) => {
        const trimmed = line.trim();
        if (!trimmed) return true; // keep empty lines (PGN separators)
        // Skip lines that are pure JSON objects (NDJSON)
        if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
          try { JSON.parse(trimmed); return false; } catch { return true; }
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
      const result = headerMap['Result'] ?? '';

      // Extract last UCI move from [LastMove] header (Lichess broadcast extension)
      const lastMove = headerMap['LastMove'] ?? '';

      // Extract lichess game ID from Site header
      // e.g. [Site "https://lichess.org/abcdefgh"]
      const site = headerMap['Site'] ?? '';
      const lichessGameId = site.split('/').pop() ?? null;

      // FEN header is authoritative — skip expensive chess.js parsing
      const computedFen = fenValue || this.computeFenFromMoves(section);
      const fen = computedFen || STARTING_FEN;
      if (!computedFen && section.length > 200) {
        // PGN has content but parser couldn't extract FEN — log for debugging
        const movePart = section.replace(/\{[^}]*\}/g, '').split(/\n\n/).pop() ?? '';
        this.logger.warn(
          `FEN parse failed for ${white} vs ${black}: section=${section.length}b, ` +
          `moves="${movePart.substring(0, 80)}"`,
        );
      }

      games.push({
        index,
        white,
        black,
        result,
        fen,
        uci: lastMove,
        pgn: section.trim(),
        lichessGameId: lichessGameId || null,
      });
      index++;
    }

    return games;
  }

  private computeFenFromMoves(pgnText: string): string | null {
    // Strip PGN comments in { } that chess.js cannot handle
    // e.g. {[%clk 1:30:00]}, {[%eval 0.5]}, { Inaccuracy. Nf3 was best. }
    const cleaned = pgnText.replace(/\{[^}]*\}/g, '');

    try {
      const chess = new Chess();
      chess.loadPgn(cleaned);
      if (chess.history().length > 0) return chess.fen();
    } catch {
      // loadPgn failed — no valid moves in PGN
    }
    return null;
  }

  async getGameFens(roundId: string): Promise<Array<{ index: number; fen: string }>> {
    const pattern = `broadcast:fen:${roundId}:*`;
    const keys = await this.redis.keys(pattern).catch(() => [] as string[]);
    const result: Array<{ index: number; fen: string }> = [];

    for (const key of keys) {
      const fen = await this.redis.get(key).catch(() => null);
      const indexStr = key.split(':').pop();
      if (fen && indexStr !== undefined) {
        result.push({ index: parseInt(indexStr, 10), fen });
      }
    }
    return result.sort((a, b) => a.index - b.index);
  }

  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
