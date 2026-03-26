import {
  Body,
  Controller,
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

@Controller('puzzles/generated')
export class PuzzleGeneratorController {
  constructor(
    private readonly generator: PuzzleGeneratorService,
    private readonly prisma: PrismaService,
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
    @Body() body: { puzzles: Array<{ fen: string; moves: string; rating: number; gap: number; themes: string; sourceType: string; sourceId?: string | null; sourceMoveNum?: number }> },
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
  ) {
    const limit = Math.min(50, parseInt(limitStr ?? '20', 10) || 20);
    const offset = parseInt(offsetStr ?? '0', 10) || 0;

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
        orderBy: { createdAt: 'desc' },
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
    };
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
      depth: puzzle.depth,
      createdAt: puzzle.createdAt.toISOString(),
    };
  }
}
