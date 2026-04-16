import { Injectable, Logger, ConflictException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { Chess, Square } from 'chess.js';
import { I18nService } from 'nestjs-i18n';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { GameClockService, ClockState } from './game-clock.service';
import { RatingService } from './rating.service';
import { INITIAL_FEN, MAX_ACTIVE_BOT_GAMES, STOCKFISH_BOT_ID, DEFAULT_CATEGORY_TC, classifyTimeControl } from '@kingside/shared';
import { GameResult, Termination } from '../generated/prisma/enums';

interface GameState {
  fen: string;
  moves: { uci: string; san: string }[];
  status: string;
  activeColor: 'white' | 'black';
}

export interface RatingChange {
  whiteRatingBefore: number;
  whiteRatingAfter: number;
  blackRatingBefore: number;
  blackRatingAfter: number;
}

export interface MoveFlags {
  captured: boolean;
  isCheck: boolean;
  isCastle: boolean;
  isPromotion: boolean;
}

interface MoveResult {
  san: string;
  fen: string;
  clocks: ClockState;
  gameOver: boolean;
  result?: 'white' | 'black' | 'draw';
  termination?: string;
  ratingChange?: RatingChange | null;
  moveFlags?: MoveFlags;
}

interface EndResult {
  result: 'white' | 'black' | 'draw';
  termination: string;
  clocks: ClockState;
  ratingChange?: RatingChange | null;
}

@Injectable()
export class GameService {
  private readonly logger = new Logger(GameService.name);
  private readonly postGameHooks: Array<(gameId: string) => Promise<void>> = [];

  /** Register a callback to be called after each game ends. */
  onGameEnd(hook: (gameId: string) => Promise<void>) {
    this.postGameHooks.push(hook);
  }

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly clockService: GameClockService,
    private readonly ratingService: RatingService,
    private readonly i18n: I18nService,
  ) {}

  private stateKey(gameId: string): string {
    return `game:${gameId}:state`;
  }

  async initGame(gameId: string): Promise<GameState> {
    const game = await this.prisma.game.findUniqueOrThrow({
      where: { id: gameId },
    });

    const state: GameState = {
      fen: INITIAL_FEN,
      moves: [],
      status: 'active',
      activeColor: 'white',
    };

    await this.redis.hset(this.stateKey(gameId), {
      fen: state.fen,
      moves: '[]',
      status: 'active',
      active_color: 'white',
      white_id: game.whiteId,
      black_id: game.blackId,
      time_increment_sec: String(game.timeIncrementSec),
    });

    await this.clockService.initClocks(gameId, game.timeInitialSec * 1000);
    await this.clockService.startClock(gameId);

    await this.prisma.game.update({
      where: { id: gameId },
      data: { status: 'active', startedAt: new Date() },
    });

    return state;
  }

  async getGameState(gameId: string): Promise<{
    state: GameState;
    clocks: ClockState;
    whiteId: string;
    blackId: string;
    players: { white: string; black: string };
    isBot: boolean;
    botLevel: number | null;
    botClientSide: boolean;
  }> {
    const raw = await this.redis.hgetall(this.stateKey(gameId));

    if (!raw.fen) {
      const game = await this.prisma.game.findUniqueOrThrow({
        where: { id: gameId },
        include: {
          moves: { orderBy: { moveNumber: 'asc' } },
          white: { select: { username: true } },
          black: { select: { username: true } },
        },
      });
      const state: GameState = {
        fen: game.finalFen || INITIAL_FEN,
        moves: game.moves.map((m) => ({ uci: m.uci, san: m.san })),
        status: game.status,
        activeColor: 'white',
      };
      const clocks = await this.clockService.getClocks(gameId);
      const players = { white: game.white.username ?? '', black: game.black.username ?? '' };
      return { state, clocks, whiteId: game.whiteId, blackId: game.blackId, players, isBot: game.isBot, botLevel: game.botLevel, botClientSide: game.botClientSide };
    }

    const game = await this.prisma.game.findUniqueOrThrow({
      where: { id: gameId },
      select: {
        whiteId: true,
        blackId: true,
        isBot: true,
        botLevel: true,
        botClientSide: true,
        white: { select: { username: true } },
        black: { select: { username: true } },
      },
    });

    const activeColor = raw.active_color as 'white' | 'black';
    const state: GameState = {
      fen: raw.fen,
      moves: JSON.parse(raw.moves || '[]'),
      status: raw.status,
      activeColor,
    };
    const clocks = await this.clockService.getClocks(gameId, activeColor);

    const players = { white: game.white.username ?? '', black: game.black.username ?? '' };
    return { state, clocks, whiteId: game.whiteId, blackId: game.blackId, players, isBot: game.isBot, botLevel: game.botLevel, botClientSide: game.botClientSide };
  }

  async makeMove(gameId: string, userId: string, uci: string): Promise<MoveResult> {
    // --- I/O #1: Pipeline read — state + clocks in one round-trip ---
    const stateKey = this.stateKey(gameId);
    const clockKey = `game:${gameId}:clocks`;
    const pipelineRead = this.redis.pipeline();
    pipelineRead.hgetall(stateKey);
    pipelineRead.hgetall(clockKey);
    const [[, raw], [, clockRaw]] = await pipelineRead.exec() as [[null, Record<string, string>], [null, Record<string, string>]];

    if (raw.status !== 'active') {
      throw new BadRequestException(this.i18n.t('messages.game.notActive'));
    }

    const activeColor = raw.active_color as 'white' | 'black';
    const whiteId = raw.white_id;
    const blackId = raw.black_id;
    const timeIncrementSec = Number(raw.time_increment_sec || '0');

    // Fallback: if whiteId/blackId not cached in Redis, fetch from Prisma
    if (!whiteId || !blackId) {
      return this.makeMoveWithPrismaFallback(gameId, userId, uci);
    }

    const expectedPlayer = activeColor === 'white' ? whiteId : blackId;
    if (userId !== expectedPlayer) {
      throw new ForbiddenException(this.i18n.t('messages.game.notYourTurn'));
    }

    // --- Inline timeout check (no extra Redis call) ---
    const now = Date.now();
    const clocksRunning = clockRaw.running === '1';
    const clockField = activeColor === 'white' ? 'white_ms' : 'black_ms';
    const elapsed = clocksRunning ? now - Number(clockRaw.last_tick) : 0;
    const timeRemaining = Number(clockRaw[clockField]) - elapsed;

    if (clocksRunning && timeRemaining <= 0) {
      const timeoutClocks: ClockState = {
        whiteMs: activeColor === 'white' ? 0 : Number(clockRaw.white_ms),
        blackMs: activeColor === 'black' ? 0 : Number(clockRaw.black_ms),
        lastTick: now,
        running: clockRaw.running === '1',
      };
      const result = activeColor === 'white' ? 'black' : 'white';
      const ratingChange = await this.endGame(gameId, result, 'timeout');
      return {
        san: '',
        fen: raw.fen,
        clocks: timeoutClocks,
        gameOver: true,
        result,
        termination: 'timeout',
        ratingChange,
      };
    }

    // --- CPU: chess.js validation ---
    // Reconstruct chess.js from move history (required for isThreefoldRepetition)
    const moves = JSON.parse(raw.moves || '[]') as { uci: string; san: string }[];
    const chess = new Chess();
    for (const m of moves) {
      const hFrom = m.uci.substring(0, 2);
      const hTo = m.uci.substring(2, 4);
      const hPromotion = m.uci.length > 4 ? m.uci[4] : undefined;
      chess.move({ from: hFrom, to: hTo, promotion: hPromotion });
    }

    const from = uci.substring(0, 2);
    const to = uci.substring(2, 4);
    let promotion = uci.length > 4 ? uci[4] : undefined;

    if (!promotion) {
      const piece = chess.get(from as Square);
      if (piece?.type === 'p' && (to[1] === '8' || to[1] === '1')) {
        promotion = 'q';
      }
    }

    const normalizedUci = promotion && uci.length <= 4 ? `${from}${to}${promotion}` : uci;

    const move = chess.move({ from, to, promotion });
    if (!move) {
      throw new BadRequestException(this.i18n.t('messages.game.invalidMove'));
    }

    const moveFlags: MoveFlags = {
      captured: !!move.captured,
      isCheck: chess.inCheck(),
      isCastle: move.flags.includes('k') || move.flags.includes('q'),
      isPromotion: move.flags.includes('p'),
    };

    const newFen = chess.fen();
    moves.push({ uci: normalizedUci, san: move.san });
    const nextColor = activeColor === 'white' ? 'black' : 'white';

    // --- Inline clock switch (compute from already-fetched clock data) ---
    const incrementMs = timeIncrementSec * 1000;
    const movedField = activeColor === 'white' ? 'white_ms' : 'black_ms';
    const remaining = Math.max(0, Number(clockRaw[movedField]) - elapsed + incrementMs);
    const whiteMs = activeColor === 'white' ? remaining : Number(clockRaw.white_ms);
    const blackMs = activeColor === 'black' ? remaining : Number(clockRaw.black_ms);
    const clocks: ClockState = { whiteMs, blackMs, lastTick: now, running: true };

    // --- I/O #2: Pipeline write — state + clocks + deadline in one round-trip ---
    const nextActiveMs = activeColor === 'white' ? blackMs : whiteMs;
    const pipelineWrite = this.redis.pipeline();
    pipelineWrite.hset(stateKey, {
      fen: newFen,
      moves: JSON.stringify(moves),
      active_color: nextColor,
    });
    pipelineWrite.hset(clockKey, {
      [movedField]: String(remaining),
      last_tick: String(now),
    });
    pipelineWrite.zadd('game:deadlines', now + nextActiveMs, gameId);
    await pipelineWrite.exec();

    // Moves stored in Redis only (batch written to DB in endGame)

    let gameOver = false;
    let result: GameResult | undefined;
    let termination: Termination | undefined;

    if (chess.isCheckmate()) {
      result = activeColor;
      termination = 'checkmate';
      gameOver = true;
    } else if (chess.isStalemate()) {
      result = 'draw';
      termination = 'stalemate';
      gameOver = true;
    } else if (chess.isInsufficientMaterial()) {
      result = 'draw';
      termination = 'insufficient';
      gameOver = true;
    } else if (chess.isThreefoldRepetition()) {
      result = 'draw';
      termination = 'repetition';
      gameOver = true;
    } else if (chess.isDraw()) {
      result = 'draw';
      termination = 'fifty_moves';
      gameOver = true;
    }

    let ratingChange: RatingChange | null | undefined;
    if (gameOver && result && termination) {
      ratingChange = await this.endGame(gameId, result, termination);
    }

    return { san: move.san, fen: newFen, clocks, gameOver, result, termination, ratingChange, moveFlags };
  }

  /**
   * Fallback makeMove for games initialized before whiteId/blackId caching.
   * Uses Prisma to fetch game metadata (old behavior).
   */
  private async makeMoveWithPrismaFallback(gameId: string, userId: string, uci: string): Promise<MoveResult> {
    const game = await this.prisma.game.findUniqueOrThrow({
      where: { id: gameId },
      select: { whiteId: true, blackId: true, timeIncrementSec: true, status: true },
    });

    if (game.status !== 'active') {
      throw new BadRequestException(this.i18n.t('messages.game.notActive'));
    }

    // Backfill Redis cache for future calls
    await this.redis.hset(this.stateKey(gameId), {
      white_id: game.whiteId,
      black_id: game.blackId,
      time_increment_sec: String(game.timeIncrementSec),
    });

    const raw = await this.redis.hgetall(this.stateKey(gameId));
    const activeColor = raw.active_color as 'white' | 'black';

    const expectedPlayer = activeColor === 'white' ? game.whiteId : game.blackId;
    if (userId !== expectedPlayer) {
      throw new ForbiddenException(this.i18n.t('messages.game.notYourTurn'));
    }

    const { timedOut, clocks: timeoutClocks } = await this.clockService.checkTimeout(
      gameId,
      activeColor,
    );
    if (timedOut) {
      const result = activeColor === 'white' ? 'black' : 'white';
      const ratingChange = await this.endGame(gameId, result, 'timeout');
      return {
        san: '',
        fen: raw.fen,
        clocks: timeoutClocks,
        gameOver: true,
        result,
        termination: 'timeout',
        ratingChange,
      };
    }

    // Reconstruct chess.js from move history (required for isThreefoldRepetition)
    const moves = JSON.parse(raw.moves || '[]') as { uci: string; san: string }[];
    const chess = new Chess();
    for (const m of moves) {
      const hFrom = m.uci.substring(0, 2);
      const hTo = m.uci.substring(2, 4);
      const hPromotion = m.uci.length > 4 ? m.uci[4] : undefined;
      chess.move({ from: hFrom, to: hTo, promotion: hPromotion });
    }
    const from = uci.substring(0, 2);
    const to = uci.substring(2, 4);
    let promotion = uci.length > 4 ? uci[4] : undefined;
    if (!promotion) {
      const piece = chess.get(from as Square);
      if (piece?.type === 'p' && (to[1] === '8' || to[1] === '1')) {
        promotion = 'q';
      }
    }
    const normalizedUci = promotion && uci.length <= 4 ? `${from}${to}${promotion}` : uci;
    const move = chess.move({ from, to, promotion });
    if (!move) {
      throw new BadRequestException(this.i18n.t('messages.game.invalidMove'));
    }

    const moveFlags: MoveFlags = {
      captured: !!move.captured,
      isCheck: chess.inCheck(),
      isCastle: move.flags.includes('k') || move.flags.includes('q'),
      isPromotion: move.flags.includes('p'),
    };

    const newFen = chess.fen();
    moves.push({ uci: normalizedUci, san: move.san });
    const nextColor = activeColor === 'white' ? 'black' : 'white';

    await this.redis.hset(this.stateKey(gameId), {
      fen: newFen,
      moves: JSON.stringify(moves),
      active_color: nextColor,
    });

    const clocks = await this.clockService.switchClock(
      gameId,
      activeColor,
      game.timeIncrementSec * 1000,
    );

    // Moves stored in Redis only (batch written to DB in endGame)

    let gameOver = false;
    let result: GameResult | undefined;
    let termination: Termination | undefined;

    if (chess.isCheckmate()) {
      result = activeColor;
      termination = 'checkmate';
      gameOver = true;
    } else if (chess.isStalemate()) {
      result = 'draw';
      termination = 'stalemate';
      gameOver = true;
    } else if (chess.isInsufficientMaterial()) {
      result = 'draw';
      termination = 'insufficient';
      gameOver = true;
    } else if (chess.isThreefoldRepetition()) {
      result = 'draw';
      termination = 'repetition';
      gameOver = true;
    } else if (chess.isDraw()) {
      result = 'draw';
      termination = 'fifty_moves';
      gameOver = true;
    }

    let ratingChange: RatingChange | null | undefined;
    if (gameOver && result && termination) {
      ratingChange = await this.endGame(gameId, result, termination);
    }

    return { san: move.san, fen: newFen, clocks, gameOver, result, termination, ratingChange, moveFlags };
  }

  async resign(gameId: string, userId: string): Promise<EndResult> {
    const game = await this.prisma.game.findUniqueOrThrow({
      where: { id: gameId },
      select: { whiteId: true, blackId: true, status: true },
    });

    if (game.status !== 'active') {
      throw new BadRequestException(this.i18n.t('messages.game.notActive'));
    }
    if (userId !== game.whiteId && userId !== game.blackId) {
      throw new ForbiddenException(this.i18n.t('messages.game.notAPlayer'));
    }

    const result = userId === game.whiteId ? 'black' : 'white';
    const clocks = await this.clockService.stopClock(gameId);
    const ratingChange = await this.endGame(gameId, result, 'resignation');

    return { result, termination: 'resignation', clocks, ratingChange };
  }

  async handleDrawOffer(gameId: string, userId: string): Promise<void> {
    const game = await this.prisma.game.findUniqueOrThrow({
      where: { id: gameId },
      select: { whiteId: true, blackId: true, status: true },
    });
    if (game.status !== 'active') {
      throw new BadRequestException(this.i18n.t('messages.game.notActive'));
    }
    if (userId !== game.whiteId && userId !== game.blackId) {
      throw new ForbiddenException(this.i18n.t('messages.game.notAPlayer'));
    }
    await this.redis.set(`game:${gameId}:draw_offer`, userId, 'EX', 120);
  }

  async handleDrawAccept(gameId: string, userId: string): Promise<EndResult> {
    const game = await this.prisma.game.findUniqueOrThrow({
      where: { id: gameId },
      select: { whiteId: true, blackId: true, status: true },
    });
    if (game.status !== 'active') {
      throw new BadRequestException(this.i18n.t('messages.game.notActive'));
    }

    const offerer = await this.redis.get(`game:${gameId}:draw_offer`);
    if (!offerer || offerer === userId) {
      throw new BadRequestException(this.i18n.t('messages.game.noDrawOffer'));
    }

    const clocks = await this.clockService.stopClock(gameId);
    const ratingChange = await this.endGame(gameId, 'draw', 'draw_agreement');
    await this.redis.del(`game:${gameId}:draw_offer`);

    return { result: 'draw', termination: 'draw_agreement', clocks, ratingChange };
  }

  async handleDrawDecline(gameId: string, userId: string): Promise<void> {
    await this.redis.del(`game:${gameId}:draw_offer`);
  }

  async endGame(
    gameId: string,
    result: GameResult,
    termination: Termination,
  ): Promise<RatingChange | null> {
    const stack = new Error().stack?.split('\n').slice(1, 4).map(s => s.trim()).join(' <- ');
    this.logger.log(`endGame(${gameId}, ${result}, ${termination}) called from: ${stack}`);

    await this.redis.hset(this.stateKey(gameId), { status: 'finished' });
    await this.clockService.stopClock(gameId);

    const raw = await this.redis.hgetall(this.stateKey(gameId));

    try {
      await this.prisma.game.update({
        where: { id: gameId },
        data: {
          status: 'finished',
          result,
          termination,
          finalFen: raw.fen,
          finishedAt: new Date(),
        },
      });
    } catch (e: any) {
      this.logger.error(`Failed to update game ${gameId} to finished: ${e.message}`);
      // Retry once — race condition may have already finished it
      try {
        const game = await this.prisma.game.findUnique({ where: { id: gameId }, select: { status: true } });
        if (game && game.status === 'active') {
          await this.prisma.game.update({
            where: { id: gameId },
            data: { status: 'finished', result, termination, finishedAt: new Date() },
          });
        }
      } catch { /* give up */ }
    }

    // Batch write all moves from Redis to DB (replay FENs via chess.js)
    try {
      const movesJson = raw.moves || '[]';
      const moves: Array<{ uci: string; san: string }> = JSON.parse(movesJson);
      if (moves.length > 0) {
        const replay = new Chess();
        const data = moves.map((m, idx) => {
          const from = m.uci.substring(0, 2);
          const to = m.uci.substring(2, 4);
          const promotion = m.uci.length > 4 ? m.uci[4] : undefined;
          replay.move({ from, to, promotion });
          return {
            gameId,
            moveNumber: idx + 1,
            color: idx % 2 === 0 ? 'white' as const : 'black' as const,
            uci: m.uci,
            san: m.san,
            fenAfter: replay.fen(),
            timeLeftMs: 0,
          };
        });
        await this.prisma.move.createMany({ data });
        this.logger.log(`endGame ${gameId}: batch wrote ${moves.length} moves to DB`);
      }
    } catch (e: any) {
      this.logger.error(`endGame ${gameId}: batch move write failed: ${e.message}`);
    }

    await this.redis.del(this.stateKey(gameId));
    await this.clockService.deleteClock(gameId);
    await this.redis.del(`game:${gameId}:draw_offer`);

    let ratingChange: RatingChange | null = null;
    try {
      ratingChange = await this.ratingService.updateRatingsAfterGame(gameId, result);
    } catch (e: any) {
      this.logger.error(`Rating update failed for game ${gameId}: ${e.message}`);
    }
    this.logger.log(`Game ${gameId} ended: ${result} by ${termination}`);

    // Clear arena playing flags BEFORE emit game:end reaches client (avoid seek BLOCKED race)
    try {
      const gameForTournament = await this.prisma.game.findUnique({
        where: { id: gameId },
        select: { tournamentId: true, whiteId: true, blackId: true },
      });
      if (gameForTournament?.tournamentId) {
        const tid = gameForTournament.tournamentId;
        const apKey = `arena:${tid}:active_players`;
        await this.redis.srem(apKey, gameForTournament.whiteId, gameForTournament.blackId).catch(() => {});
        await this.redis.del(`arena:${tid}:playing:${gameForTournament.whiteId}`, `arena:${tid}:playing:${gameForTournament.blackId}`).catch(() => {});
      }
    } catch { /* non-critical */ }

    // Push to puzzle generation queue (human vs human only)
    try {
      const wId = raw.white_id;
      const bId = raw.black_id;
      if (wId && bId && wId !== STOCKFISH_BOT_ID && bId !== STOCKFISH_BOT_ID) {
        await this.redis.lpush('puzzle-gen:queue', gameId);
      }
    } catch { /* non-critical */ }

    // Fire post-game hooks in background (arena scoring, etc.) — don't block the hot path
    if (this.postGameHooks.length > 0) {
      const hooks = [...this.postGameHooks];
      setImmediate(async () => {
        for (const hook of hooks) {
          try { await hook(gameId); } catch (e: any) {
            this.logger.error(`Post-game hook failed for ${gameId}: ${e.message}`);
          }
        }
      });
    }

    return ratingChange;
  }

  async createGame(
    whiteId: string,
    blackId: string,
    timeInitialSec: number,
    timeIncrementSec: number,
  ) {
    const timeControlType = classifyTimeControl(timeInitialSec, timeIncrementSec);

    return this.prisma.game.create({
      data: {
        whiteId,
        blackId,
        timeControlType,
        timeInitialSec,
        timeIncrementSec,
        status: 'waiting',
      },
    });
  }

  async createGameWithBot(
    userId: string,
    color: 'white' | 'black' | 'random',
    botLevel: number,
    timeControl: 'bullet' | 'blitz' | 'rapid' | 'classical',
    wasmSupported?: boolean,
  ) {
    await this.cleanupStaleBotGames(userId);

    const activeBotGames = await this.prisma.game.count({
      where: {
        isBot: true,
        status: 'active',
        OR: [{ whiteId: userId }, { blackId: userId }],
      },
    });

    if (activeBotGames >= MAX_ACTIVE_BOT_GAMES) {
      throw new ConflictException(
        this.i18n.t('messages.game.botGameLimitReached'),
      );
    }

    const resolvedColor =
      color === 'random' ? (Math.random() < 0.5 ? 'white' : 'black') : color;

    const whiteId = resolvedColor === 'white' ? userId : STOCKFISH_BOT_ID;
    const blackId = resolvedColor === 'black' ? userId : STOCKFISH_BOT_ID;

    const tc = DEFAULT_CATEGORY_TC[timeControl];

    const game = await this.prisma.game.create({
      data: {
        whiteId,
        blackId,
        timeControlType: timeControl,
        timeInitialSec: tc.initialTime,
        timeIncrementSec: tc.increment,
        status: 'waiting',
        isBot: true,
        botLevel,
        botClientSide: !!wasmSupported,
      },
    });

    await this.initGame(game.id);

    return this.getGame(game.id);
  }

  async getGame(id: string) {
    return this.prisma.game.findUniqueOrThrow({
      where: { id },
      include: {
        white: { select: { id: true, username: true } },
        black: { select: { id: true, username: true } },
      },
    });
  }

  async setBerserk(gameId: string, color: 'white' | 'black'): Promise<void> {
    const field = color === 'white' ? 'whiteBerserk' : 'blackBerserk';
    await this.prisma.game.update({
      where: { id: gameId },
      data: { [field]: true },
    });
  }

  async getActiveGameForUser(userId: string): Promise<{ gameId: string; opponent: string; timeControlType: string; tournamentId: string | null } | null> {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const game = await this.prisma.game.findFirst({
      where: {
        status: 'active',
        createdAt: { gte: twoHoursAgo },
        OR: [{ whiteId: userId }, { blackId: userId }],
      },
      include: {
        white: { select: { username: true } },
        black: { select: { username: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!game) return null;

    // Verify game still has Redis state (not stale)
    const raw = await this.redis.hgetall(this.stateKey(game.id));
    if (!raw.fen) {
      // Stale: DB says active but Redis state gone — clean up
      await this.prisma.game.update({
        where: { id: game.id },
        data: { status: 'finished', result: 'draw', termination: 'abandon', finishedAt: new Date() },
      });
      return null;
    }

    const isWhite = game.whiteId === userId;
    return {
      gameId: game.id,
      opponent: isWhite ? (game.black.username ?? '?') : (game.white.username ?? '?'),
      timeControlType: game.timeControlType ?? '',
      tournamentId: game.tournamentId ?? null,
    };
  }

  async getGameMoves(gameId: string) {
    return this.prisma.move.findMany({
      where: { gameId },
      orderBy: { moveNumber: 'asc' },
    });
  }

  /** Stale bot game threshold: 30 minutes */
  private static readonly STALE_BOT_GAME_MS = 30 * 60 * 1000;
  /** Stale game threshold (any): 15 minutes without Redis state */
  private static readonly STALE_GAME_MS = 15 * 60 * 1000;

  async cleanupStaleBotGames(userId?: string): Promise<number> {
    const threshold = new Date(Date.now() - GameService.STALE_BOT_GAME_MS);

    const where: Record<string, unknown> = {
      isBot: true,
      status: 'active',
    };

    if (userId) {
      where.OR = [{ whiteId: userId }, { blackId: userId }];
    }

    const staleGames = await this.prisma.game.findMany({
      where,
      select: { id: true, createdAt: true, startedAt: true },
    });

    let cleaned = 0;
    for (const game of staleGames) {
      const referenceTime = game.startedAt ?? game.createdAt;
      const hasState = await this.redis.exists(this.stateKey(game.id));
      const isStaleByTime = referenceTime < threshold;

      if (!hasState || isStaleByTime) {
        await this.prisma.game.update({
          where: { id: game.id },
          data: {
            status: 'finished',
            termination: 'abandon',
            finishedAt: new Date(),
          },
        });
        // Clean up Redis state if exists
        if (hasState) {
          await this.redis.del(this.stateKey(game.id));
        }
        cleaned++;
        this.logger.log(`Cleaned up stale bot game ${game.id} (noState=${!hasState}, staleByTime=${isStaleByTime})`);
      }
    }

    return cleaned;
  }

  /**
   * Cleanup ALL stale active games (bot and human).
   * A game is stale if:
   *  - No Redis state exists (server restarted, state lost), OR
   *  - Created/started more than STALE_GAME_MS ago
   */
  async cleanupStaleGames(): Promise<number> {
    const threshold = new Date(Date.now() - GameService.STALE_GAME_MS);

    const staleGames = await this.prisma.game.findMany({
      where: {
        status: 'active',
        OR: [
          { startedAt: { lt: threshold } },
          { startedAt: null, createdAt: { lt: threshold } },
        ],
      },
      select: { id: true, isBot: true },
    });

    let cleaned = 0;
    for (const game of staleGames) {
      const hasState = await this.redis.exists(this.stateKey(game.id));
      if (!hasState) {
        await this.prisma.game.update({
          where: { id: game.id },
          data: { status: 'finished', termination: 'abandon', finishedAt: new Date() },
        });
        cleaned++;
        this.logger.log(`Cleaned up stale game ${game.id} (bot=${game.isBot}, no Redis state)`);
      }
    }

    return cleaned;
  }

  async endBotGameOnDisconnect(userId: string): Promise<string[]> {
    const activeGames = await this.prisma.game.findMany({
      where: {
        isBot: true,
        status: 'active',
        OR: [{ whiteId: userId }, { blackId: userId }],
      },
      select: { id: true, whiteId: true, blackId: true },
    });

    const endedGameIds: string[] = [];
    for (const game of activeGames) {
      // Don't end games with no moves — player may reconnect to another ECS task
      const raw = await this.redis.hgetall(this.stateKey(game.id));
      const moves = raw.moves ? JSON.parse(raw.moves) : [];
      if (moves.length === 0) {
        this.logger.log(`Bot game ${game.id} has no moves, skipping disconnect end`);
        continue;
      }

      const result = userId === game.whiteId ? 'black' : 'white';
      await this.endGame(game.id, result as 'white' | 'black', 'abandon');
      endedGameIds.push(game.id);
      this.logger.log(`Bot game ${game.id} ended on disconnect`);
    }

    return endedGameIds;
  }

  async getPlayerColor(gameId: string, userId: string): Promise<'white' | 'black' | null> {
    const game = await this.prisma.game.findUnique({
      where: { id: gameId },
      select: { whiteId: true, blackId: true },
    });
    if (!game) return null;
    if (game.whiteId === userId) return 'white';
    if (game.blackId === userId) return 'black';
    return null;
  }

  async getAnalysis(gameId: string, userId: string): Promise<{ analysisPgn: string | null }> {
    const record = await this.prisma.gameAnalysis.findUnique({
      where: { gameId_userId: { gameId, userId } },
      select: { analysisPgn: true },
    });
    return { analysisPgn: record?.analysisPgn ?? null };
  }

  async saveAnalysis(gameId: string, userId: string, analysisPgn: string): Promise<void> {
    await this.prisma.gameAnalysis.upsert({
      where: { gameId_userId: { gameId, userId } },
      update: { analysisPgn },
      create: { gameId, userId, analysisPgn },
    });
  }
}
