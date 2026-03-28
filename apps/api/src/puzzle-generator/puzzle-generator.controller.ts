import {
  Body,
  Controller,
  Delete,
  Get,
  Post,
  Param,
  Query,
  Request,
  UseGuards,
  ParseUUIDPipe,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthenticatedRequest } from '../common/authenticated-request';
import { PuzzleGeneratorService } from './puzzle-generator.service';
import { PrismaService } from '../prisma/prisma.service';
import { GlickoRatingService } from './glicko-rating.service';
import { NotFoundException } from '@nestjs/common';

@Controller('puzzles/generated')
export class PuzzleGeneratorController {
  constructor(
    private readonly generator: PuzzleGeneratorService,
    private readonly prisma: PrismaService,
    private readonly glicko: GlickoRatingService,
  ) {}

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
    @Body() body: { puzzles: Array<{ fen: string; moves: string; rating: number; gap: number; themes: string; sourceType: string; sourceId?: string | null; sourceMoveNum?: number; sourceMetadata?: Record<string, string> }> },
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
        depth: 14,
        createdBy: req.user.id,
      })),
      skipDuplicates: true,
    });

    return { count: created.count };
  }

  /**
   * GET /api/puzzles/generated — list generated puzzles with filters.
   */
  @Get()
  async list(
    @Query('themes') themes?: string,
    @Query('ratingMin') ratingMinStr?: string,
    @Query('ratingMax') ratingMaxStr?: string,
    @Query('source') source?: string, // my_games, all
    @Query('limit') limitStr?: string,
    @Query('offset') offsetStr?: string,
    @Query('sort') sort?: string,
    @Query('order') order?: string,
  ) {
    const limit = Math.min(50, parseInt(limitStr ?? '20', 10) || 20);
    const offset = parseInt(offsetStr ?? '0', 10) || 0;

    const allowedSort = ['rating', 'createdAt'] as const;
    const sortField = allowedSort.includes(sort as typeof allowedSort[number])
      ? (sort as typeof allowedSort[number])
      : 'createdAt';
    const sortOrder: 'asc' | 'desc' = order === 'asc' ? 'asc' : 'desc';

    const where: Record<string, unknown> = {};

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
        createdAt: p.createdAt.toISOString(),
      })),
      total,
    };
  }

  /**
   * GET /api/puzzles/generated/next — random generated puzzle with filters.
   */
  @Get('next')
  async next(
    @Query('themes') themes?: string,
    @Query('ratingMin') ratingMinStr?: string,
    @Query('ratingMax') ratingMaxStr?: string,
  ) {
    const where: Record<string, unknown> = {};

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
