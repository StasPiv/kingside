import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  NotFoundException,
  Patch,
  Post,
  Param,
  Query,
  Request,
  UseGuards,
  ParseUUIDPipe,
} from '@nestjs/common';
import { Chess } from 'chess.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { OptionalJwtGuard } from '../auth/optional-jwt.guard';
import { AuthenticatedRequest } from '../common/authenticated-request';
import { PuzzleGeneratorService } from './puzzle-generator.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { GlickoRatingService } from './glicko-rating.service';
import { GenerateFromPgnDto } from './dto/generate-from-pgn.dto';

@Controller('puzzles/generated')
export class PuzzleGeneratorController {
  constructor(
    private readonly generator: PuzzleGeneratorService,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly glicko: GlickoRatingService,
  ) {}

  /**
   * POST /api/puzzles/generated/generate-pgn — queue PGN for puzzle generation.
   */
  @UseGuards(JwtAuthGuard)
  @Post('generate-pgn')
  async generateFromPgn(
    @Body() dto: GenerateFromPgnDto,
  ) {
    // Validate PGN with chess.js
    const chess = new Chess();
    try {
      chess.loadPgn(dto.pgn);
    } catch {
      throw new BadRequestException('Invalid PGN: failed to parse');
    }

    const history = chess.history();
    if (history.length < 20) {
      throw new BadRequestException(`PGN too short: ${history.length} moves (minimum 20)`);
    }

    // Push to puzzle-gen queue
    const message = JSON.stringify({
      type: 'pgn',
      pgn: dto.pgn,
      whiteRating: dto.whiteRating ?? 1500,
      blackRating: dto.blackRating ?? 1500,
    });
    await this.redis.lpush('puzzle-gen:queue', message);

    return { status: 'queued', moves: history.length };
  }

  /**
   * POST /api/puzzles/generate — start puzzle generation from a game.
   */
  @UseGuards(JwtAuthGuard)
  @Post('generate')
  async generate(
    @Request() req: AuthenticatedRequest,
    @Query('sourceType') sourceType = 'game',
    @Query('sourceId') sourceId?: string,
    @Query('depth') depthStr?: string,
  ) {
    const depth = depthStr ? Math.min(24, Math.max(8, parseInt(depthStr, 10))) : 18;

    if (sourceType === 'game' && sourceId) {
      const result = await this.generator.generateFromGame(sourceId, req.user.id, depth);
      return result;
    }

    return { error: 'sourceType=game and sourceId required' };
  }

  /**
   * POST /api/puzzles/generated/batch — save multiple generated puzzles.
   */
  @UseGuards(JwtAuthGuard)
  @Post('batch')
  async batch(
    @Body() body: { puzzles: Array<{ fen: string; moves: string; rating: number; gap: number; themes: string; sourceType: string; sourceId?: string | null; sourceMoveNum?: number; sourceMetadata?: Record<string, string>; acceptedMoves?: string }> },
    @Request() req: AuthenticatedRequest,
  ) {
    const puzzles = body.puzzles ?? [];
    if (puzzles.length === 0) return { count: 0 };

    const created = await this.prisma.generatedPuzzle.createMany({
      data: puzzles.slice(0, 200).map((p) => ({
        fen: p.fen,
        moves: p.moves,
        rating: p.rating,
        gap: p.gap,
        themes: p.themes,
        sourceType: p.sourceType || 'pgn_import',
        sourceId: p.sourceId || null,
        sourceMoveNum: p.sourceMoveNum ?? 0,
        sourceMetadata: p.sourceMetadata ? JSON.stringify(p.sourceMetadata) : null,
        acceptedMoves: p.acceptedMoves || null,
        depth: 14,
        createdBy: req.user.id,
      })),
      skipDuplicates: true,
    });

    return { count: created.count };
  }

  /**
   * GET /api/puzzles/generated — list generated puzzles with filters.
   * mine=true → only own puzzles. Otherwise own + public. Guest → public only.
   */
  @UseGuards(OptionalJwtGuard)
  @Get()
  async list(
    @Request() req: AuthenticatedRequest,
    @Query('themes') themes?: string,
    @Query('ratingMin') ratingMinStr?: string,
    @Query('ratingMax') ratingMaxStr?: string,
    @Query('source') source?: string,
    @Query('mine') mine?: string,
    @Query('limit') limitStr?: string,
    @Query('offset') offsetStr?: string,
    @Query('sort') sort?: string,
    @Query('order') order?: string,
  ) {
    const userId = req.user?.id;
    const limit = Math.min(50, parseInt(limitStr ?? '20', 10) || 20);
    const offset = parseInt(offsetStr ?? '0', 10) || 0;

    const allowedSort = ['rating', 'createdAt'] as const;
    const sortField = allowedSort.includes(sort as typeof allowedSort[number])
      ? (sort as typeof allowedSort[number])
      : 'createdAt';
    const sortOrder: 'asc' | 'desc' = order === 'asc' ? 'asc' : 'desc';

    const where: Record<string, unknown> = {};

    // Visibility filter
    if (mine === 'true' && userId) {
      where.createdBy = userId;
    } else if (userId) {
      where.OR = [{ createdBy: userId }, { isPublic: true }];
    } else {
      where.isPublic = true;
    }

    if (themes) {
      const themeList = themes.split(',');
      if (where.AND) {
        (where.AND as unknown[]).push(...themeList.map((t) => ({ themes: { contains: t.trim() } })));
      } else {
        where.AND = themeList.map((t) => ({ themes: { contains: t.trim() } }));
      }
    }

    if (ratingMinStr || ratingMaxStr) {
      const rating: Record<string, number> = {};
      if (ratingMinStr) rating.gte = parseInt(ratingMinStr, 10);
      if (ratingMaxStr) rating.lte = parseInt(ratingMaxStr, 10);
      where.rating = rating;
    }

    if (source === 'my_games') {
      where.sourceType = 'game';
    }

    const [data, total] = await Promise.all([
      this.prisma.generatedPuzzle.findMany({
        where,
        take: limit,
        skip: offset,
        orderBy: { [sortField]: sortOrder },
      }),
      this.prisma.generatedPuzzle.count({ where }),
    ]);

    return {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      data: data.map((p: any) => ({
        id: p.id,
        fen: p.fen,
        moves: p.moves.split(' '),
        rating: p.rating,
        gap: p.gap,
        themes: p.themes.split(' ').filter(Boolean),
        sourceType: p.sourceType,
        sourceId: p.sourceId,
        sourceMoveNum: p.sourceMoveNum,
        sourceMetadata: p.sourceMetadata ? JSON.parse(p.sourceMetadata) : null,
        acceptedMoves: p.acceptedMoves ?? null,
        isPublic: p.isPublic,
        createdBy: p.createdBy,
        createdAt: p.createdAt.toISOString(),
      })),
      total,
    };
  }

  /**
   * GET /api/puzzles/generated/next — random generated puzzle with filters.
   * mine=true → only own. Otherwise own + public. Guest → public only.
   */
  @UseGuards(OptionalJwtGuard)
  @Get('next')
  async next(
    @Request() req: AuthenticatedRequest,
    @Query('themes') themes?: string,
    @Query('ratingMin') ratingMinStr?: string,
    @Query('ratingMax') ratingMaxStr?: string,
    @Query('mine') mine?: string,
  ) {
    const userId = req.user?.id;
    const where: Record<string, unknown> = {};

    // Visibility filter
    if (mine === 'true' && userId) {
      where.createdBy = userId;
    } else if (userId) {
      where.OR = [{ createdBy: userId }, { isPublic: true }];
    } else {
      where.isPublic = true;
    }

    if (themes) {
      const themeList = themes.split(',');
      where.AND = themeList.map((t) => ({ themes: { contains: t.trim() } }));
    }

    if (ratingMinStr || ratingMaxStr) {
      const rating: Record<string, number> = {};
      if (ratingMinStr) rating.gte = parseInt(ratingMinStr, 10);
      if (ratingMaxStr) rating.lte = parseInt(ratingMaxStr, 10);
      where.rating = rating;
    }

    const count = await this.prisma.generatedPuzzle.count({ where });
    if (count === 0) return null;

    const skip = Math.floor(Math.random() * count);
    const puzzle = await this.prisma.generatedPuzzle.findFirst({ where, skip });
    if (!puzzle) return null;

    return {
      id: puzzle.id,
      fen: puzzle.fen,
      moves: puzzle.moves.split(' '),
      rating: puzzle.rating,
      gap: puzzle.gap,
      themes: puzzle.themes.split(' ').filter(Boolean),
      sourceType: puzzle.sourceType,
      sourceId: puzzle.sourceId,
      sourceMetadata: puzzle.sourceMetadata ? JSON.parse(puzzle.sourceMetadata) : null,
      acceptedMoves: puzzle.acceptedMoves ?? null,
      isPublic: puzzle.isPublic,
    };
  }

  /**
   * PATCH /api/puzzles/generated/publish-all — publish all own puzzles.
   */
  @UseGuards(JwtAuthGuard)
  @Patch('publish-all')
  async publishAll(@Request() req: AuthenticatedRequest) {
    const result = await this.prisma.generatedPuzzle.updateMany({
      where: { createdBy: req.user.id },
      data: { isPublic: true },
    });
    return { updated: result.count };
  }

  /**
   * PATCH /api/puzzles/generated/:id — update puzzle (isPublic).
   */
  @UseGuards(JwtAuthGuard)
  @Patch(':id')
  async updateOne(
    @Param('id', ParseUUIDPipe) id: string,
    @Request() req: AuthenticatedRequest,
    @Body() body: { isPublic?: boolean },
  ) {
    const puzzle = await this.prisma.generatedPuzzle.findUnique({ where: { id } });
    if (!puzzle) throw new NotFoundException('Puzzle not found');
    if (puzzle.createdBy !== req.user.id) throw new ForbiddenException();

    const updated = await this.prisma.generatedPuzzle.update({
      where: { id },
      data: { isPublic: body.isPublic ?? puzzle.isPublic },
    });

    return {
      id: updated.id,
      isPublic: updated.isPublic,
      rating: updated.rating,
    };
  }

  /**
   * DELETE /api/puzzles/generated/all — delete all own generated puzzles.
   */
  @UseGuards(JwtAuthGuard)
  @Delete('all')
  async deleteAll(@Request() req: AuthenticatedRequest) {
    const result = await this.prisma.generatedPuzzle.deleteMany({
      where: { createdBy: req.user.id },
    });
    return { deleted: result.count };
  }

  /**
   * DELETE /api/puzzles/generated/:id — delete one own puzzle.
   */
  @UseGuards(JwtAuthGuard)
  @Delete(':id')
  async deleteOne(
    @Param('id', ParseUUIDPipe) id: string,
    @Request() req: AuthenticatedRequest,
  ) {
    const puzzle = await this.prisma.generatedPuzzle.findUnique({ where: { id } });
    if (!puzzle || puzzle.createdBy !== req.user.id) {
      return { deleted: 0 };
    }
    await this.prisma.generatedPuzzle.delete({ where: { id } });
    return { deleted: 1 };
  }

  /**
   * GET /api/puzzles/generated/:id
   */
  @Get(':id')
  async getOne(@Param('id', ParseUUIDPipe) id: string) {
    const puzzle = await this.prisma.generatedPuzzle.findUnique({ where: { id } });
    if (!puzzle) return null;

    return {
      id: puzzle.id,
      fen: puzzle.fen,
      moves: puzzle.moves.split(' '),
      rating: puzzle.rating,
      gap: puzzle.gap,
      themes: puzzle.themes.split(' ').filter(Boolean),
      sourceType: puzzle.sourceType,
      sourceId: puzzle.sourceId,
      sourceMoveNum: puzzle.sourceMoveNum,
      sourceMetadata: puzzle.sourceMetadata ? JSON.parse(puzzle.sourceMetadata) : null,
      acceptedMoves: puzzle.acceptedMoves ?? null,
      depth: puzzle.depth,
      createdAt: puzzle.createdAt.toISOString(),
    };
  }

  /**
   * POST /api/puzzles/generated/:id/attempt
   * Submit attempt: Glicko-1 for puzzle + Elo K=32 for player.
   */
  @UseGuards(JwtAuthGuard)
  @Post(':id/attempt')
  async submitAttempt(
    @Param('id', ParseUUIDPipe) id: string,
    @Request() req: AuthenticatedRequest,
    @Body() body: { solved: boolean; timeMs: number },
  ) {
    const puzzle = await this.prisma.generatedPuzzle.findUnique({ where: { id } });
    if (!puzzle) throw new NotFoundException('Puzzle not found');

    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: req.user.id },
      select: { ratingPuzzle: true },
    });

    const puzzleRatingBefore = puzzle.rating;
    const userRatingBefore = user.ratingPuzzle;

    // Glicko-1 for puzzle
    const { newRating: puzzleRatingAfter, newRD: puzzleRDAfter } =
      this.glicko.updatePuzzleRating(puzzle.rating, puzzle.ratingDev, user.ratingPuzzle, body.solved);

    // Elo K=32 for player
    const userRatingAfter = this.glicko.updatePlayerRating(user.ratingPuzzle, puzzle.rating, body.solved);

    // Save all in transaction
    await this.prisma.$transaction([
      this.prisma.generatedPuzzleAttempt.create({
        data: {
          puzzleId: id,
          userId: req.user.id,
          solved: body.solved,
          timeMs: body.timeMs,
          userRatingBefore,
          userRatingAfter,
          puzzleRatingBefore,
          puzzleRatingAfter,
        },
      }),
      this.prisma.generatedPuzzle.update({
        where: { id },
        data: {
          rating: puzzleRatingAfter,
          ratingDev: puzzleRDAfter,
          nbPlays: { increment: 1 },
        },
      }),
      this.prisma.user.update({
        where: { id: req.user.id },
        data: { ratingPuzzle: userRatingAfter },
      }),
    ]);

    return {
      userRatingBefore,
      userRatingAfter,
      puzzleRatingBefore,
      puzzleRatingAfter,
      puzzleRDAfter,
    };
  }
}
