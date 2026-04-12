import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

const INITIAL_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

export const MATCHMAKER_PAIRED_CHANNEL = 'matchmaker:paired';
export const MATCHMAKER_FOUND_CHANNEL = 'matchmaker:found';

const arenaSeekKey = (tid: string) => `arena:${tid}:seeking`;
const lastOpponentKey = (tid: string, a: string) => `arena:${tid}:last:${a}`;
const activePlayers = (tid: string) => `arena:${tid}:active_players`;

const CLAIM_PAIR_SCRIPT = `
  if redis.call("SISMEMBER", KEYS[1], ARGV[1]) == 1 then return 0 end
  if redis.call("SISMEMBER", KEYS[1], ARGV[2]) == 1 then return 0 end
  redis.call("SADD", KEYS[1], ARGV[1], ARGV[2])
  redis.call("ZREM", KEYS[2], ARGV[1], ARGV[2])
  return 1`;

@Injectable()
export class MatchmakerWorkerService {
  private readonly logger = new Logger(MatchmakerWorkerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  /**
   * Called on every tournament:seek — tries to pair the seeker immediately.
   */
  async tryPairArena(tournamentId: string): Promise<void> {
    try {
      const pairStart = Date.now();
      const t = await this.prisma.arenaTournament.findUnique({
        where: { id: tournamentId },
        select: { id: true, timeControlType: true, timeInitialSec: true, timeIncrementSec: true, status: true },
      });
      if (!t || t.status !== 'active') return;

      const key = arenaSeekKey(t.id);
      const apKey = activePlayers(t.id);

      const members = await this.redis.zrange(key, 0, -1);
      if (members.length < 2) {
        this.logger.log(`tryPairArena: seekQueue=${members.length} elapsed=${Date.now() - pairStart}ms`);
        return;
      }

      // Batch check: which members are active (already playing)
      const pipe = this.redis.pipeline();
      for (const userId of members) {
        pipe.sismember(apKey, userId);
      }
      const activeResults = await pipe.exec();

      // Filter: remove active players from seek queue, collect available
      const available: string[] = [];
      const toRemove: string[] = [];
      for (let i = 0; i < members.length; i++) {
        const isActive = activeResults?.[i]?.[1];
        if (isActive) {
          toRemove.push(members[i]);
        } else {
          available.push(members[i]);
        }
      }
      if (toRemove.length > 0) {
        await this.redis.zrem(key, ...toRemove);
      }

      this.logger.log(`tryPairArena: seekQueue=${members.length} available=${available.length} removed=${toRemove.length} elapsed=${Date.now() - pairStart}ms`);
      if (available.length < 2) return;

      // Batch fetch lastOpponent for all available players
      const oppPipe = this.redis.pipeline();
      for (const userId of available) {
        oppPipe.get(lastOpponentKey(t.id, userId));
      }
      const oppResults = await oppPipe.exec();
      const lastOppMap = new Map<string, string | null>();
      for (let i = 0; i < available.length; i++) {
        lastOppMap.set(available[i], (oppResults?.[i]?.[1] as string) ?? null);
      }

      // Pair all available matches
      let created = 0;
      const paired = new Set<string>();
      const gamesToCreate: Array<{ userId: string; match: string }> = [];

      for (let i = 0; i < available.length; i++) {
        if (paired.has(available[i])) continue;
        const userId = available[i];
        const lastOpp = lastOppMap.get(userId) ?? null;

        let match: string | null = null;
        for (let j = i + 1; j < available.length; j++) {
          if (paired.has(available[j])) continue;
          if (available[j] !== lastOpp) { match = available[j]; break; }
          if (!match) match = available[j]; // fallback
        }
        if (!match) continue;

        const claimed = await this.redis.eval(CLAIM_PAIR_SCRIPT, 2, apKey, key, userId, match) as number;
        if (!claimed) continue;

        paired.add(userId);
        paired.add(match);
        gamesToCreate.push({ userId, match });
      }

      // Create all games concurrently
      await Promise.all(gamesToCreate.map(({ userId, match }) =>
        this.createArenaGame(t, userId, match),
      ));
      created = gamesToCreate.length;

      this.logger.log(`tryPairArena: paired=${created} total=${Date.now() - pairStart}ms`);
    } catch (e: any) {
      this.logger.error(`tryPairArena error: ${e.message}`);
    }
  }

  private async createArenaGame(
    t: { id: string; timeControlType: string; timeInitialSec: number; timeIncrementSec: number },
    userId: string, candidateId: string,
  ): Promise<void> {
    const whiteId = Math.random() < 0.5 ? userId : candidateId;
    const blackId = whiteId === userId ? candidateId : userId;

    const game = await this.prisma.game.create({
      data: {
        whiteId, blackId, status: 'waiting',
        timeControlType: t.timeControlType as any,
        timeInitialSec: t.timeInitialSec,
        timeIncrementSec: t.timeIncrementSec,
        tournamentId: t.id,
      },
    });

    const timeMs = t.timeInitialSec * 1000;
    const pipe = this.redis.pipeline();
    pipe.set(lastOpponentKey(t.id, userId), candidateId, 'EX', 300);
    pipe.set(lastOpponentKey(t.id, candidateId), userId, 'EX', 300);
    pipe.hset(`game:${game.id}:state`, {
      fen: INITIAL_FEN, moves: '[]', status: 'active', active_color: 'white',
      white_id: whiteId, black_id: blackId,
      time_increment_sec: String(t.timeIncrementSec),
    });
    pipe.hset(`game:${game.id}:clocks`, {
      white_ms: String(timeMs), black_ms: String(timeMs),
      last_tick: '0', running: '0',
    });
    await pipe.exec();

    await this.prisma.game.update({
      where: { id: game.id },
      data: { status: 'active', startedAt: new Date() },
    });

    this.redis.publish(MATCHMAKER_PAIRED_CHANNEL, JSON.stringify({
      tournamentId: t.id, gameId: game.id, whiteId, blackId,
    })).catch((e: any) => this.logger.error(`Publish error: ${e.message}`));
  }
}
