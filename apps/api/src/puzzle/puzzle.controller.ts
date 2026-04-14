import { AuthenticatedRequest } from '../common/authenticated-request';
import {
  Body,
  Controller,
  DefaultValuePipe,
  Delete,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { OptionalJwtGuard } from '../auth/optional-jwt.guard';
import { PuzzleService } from './puzzle.service';
import { PrismaService } from '../prisma/prisma.service';
import { SubmitAttemptDto } from './dto/submit-attempt.dto';
import { FindPuzzlesDto } from './dto/find-puzzles.dto';

@Controller('puzzles')
export class PuzzleController {
  constructor(
    private readonly puzzleService: PuzzleService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * GET /puzzles — search puzzles by theme and difficulty.
   */
  @Get()
  findPuzzles(@Query() dto: FindPuzzlesDto) {
    return this.puzzleService.findPuzzles({
      themes: dto.themes,
      ratingMin: dto.ratingMin,
      ratingMax: dto.ratingMax,
      limit: dto.limit,
    });
  }

  /**
   * GET /puzzles/themes
   */
  @Get('themes')
  getThemes() {
    return this.puzzleService.getThemes();
  }

  @UseGuards(OptionalJwtGuard)
  @Get('next')
  getNextPuzzle(
    @Request() req: AuthenticatedRequest,
    @Query('excludeId') excludeId?: string,
    @Query() dto?: FindPuzzlesDto,
  ) {
    return this.puzzleService.getNextPuzzle(req.user?.id ?? null, excludeId, {
      themes: dto?.themes,
      ratingMin: dto?.ratingMin,
      ratingMax: dto?.ratingMax,
    });
  }

  @UseGuards(OptionalJwtGuard)
  @Get('next/:theme')
  getNextPuzzleByTheme(
    @Request() req: AuthenticatedRequest,
    @Param('theme') theme: string,
    @Query('excludeId') excludeId?: string,
  ) {
    return this.puzzleService.getNextPuzzleByTheme(req.user?.id ?? null, theme, excludeId);
  }

  @UseGuards(JwtAuthGuard)
  @Get('stats/me')
  getMyStats(@Request() req: AuthenticatedRequest) {
    return this.puzzleService.getStats(req.user.id);
  }

  @UseGuards(JwtAuthGuard)
  @Get('stats/rating-history')
  getRatingHistory(
    @Request() req: AuthenticatedRequest,
    @Query('days', new DefaultValuePipe(30), ParseIntPipe) days: number,
  ) {
    return this.puzzleService.getRatingHistory(req.user.id, Math.min(days, 365));
  }

  @UseGuards(JwtAuthGuard)
  @Get('stats/themes')
  getThemeStats(@Request() req: AuthenticatedRequest) {
    return this.puzzleService.getThemeStats(req.user.id);
  }

  @UseGuards(JwtAuthGuard)
  @Get('attempts')
  getAttempts(
    @Request() req: AuthenticatedRequest,
    @Query('take', new DefaultValuePipe(20), ParseIntPipe) take: number,
    @Query('skip', new DefaultValuePipe(0), ParseIntPipe) skip: number,
  ) {
    return this.puzzleService.getUserAttempts(req.user.id, take, skip);
  }

  /**
   * GET /puzzles/browse — list puzzles with filters (generated).
   */
  @UseGuards(OptionalJwtGuard)
  @Get('browse')
  async browse(
    @Request() req: AuthenticatedRequest,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset: number,
    @Query('sort') sort?: string,
    @Query('order') order?: string,
    @Query('mine') mine?: string,
    @Query('themes') themes?: string,
    @Query('ratingMin') ratingMinStr?: string,
    @Query('ratingMax') ratingMaxStr?: string,
    @Query('hideSolved') hideSolved?: string,
  ) {
    const userId = req.user?.id;
    const take = Math.min(50, limit);

    const allowedSort: Record<string, string> = { rating: 'rating', createdAt: 'created_at' };
    const sortCol = allowedSort[sort ?? ''] ?? 'created_at';
    const sortDir = order === 'asc' ? 'ASC' : 'DESC';

    const conditions: string[] = ["p.source = 'generated'"];
    const params: (string | number)[] = [];
    let idx = 1;

    // Visibility
    if (mine === 'true' && userId) {
      conditions.push(`p.created_by = $${idx}::uuid`);
      params.push(userId);
      idx++;
    } else if (userId) {
      conditions.push(`(p.created_by = $${idx}::uuid OR p.is_public = true)`);
      params.push(userId);
      idx++;
    } else {
      conditions.push('p.is_public = true');
    }

    if (themes) {
      for (const t of themes.split(',')) {
        conditions.push(`p.themes LIKE $${idx}`);
        params.push(`%${t.trim()}%`);
        idx++;
      }
    }
    if (ratingMinStr) { conditions.push(`p.rating >= $${idx}`); params.push(parseInt(ratingMinStr, 10)); idx++; }
    if (ratingMaxStr) { conditions.push(`p.rating <= $${idx}`); params.push(parseInt(ratingMaxStr, 10)); idx++; }

    // hideSolved: exclude all attempted puzzles (solved and failed)
    if (hideSolved === 'true' && userId) {
      conditions.push(`NOT EXISTS (SELECT 1 FROM puzzle_attempts pa WHERE pa.puzzle_id = p.id AND pa.user_id = $${idx}::uuid)`);
      params.push(userId);
      idx++;
    }

    const whereClause = conditions.join(' AND ');

    // solvedStatus subquery
    const solvedStatusSelect = userId
      ? `, CASE
          WHEN EXISTS (SELECT 1 FROM puzzle_attempts pa WHERE pa.puzzle_id = p.id AND pa.user_id = $${idx}::uuid AND pa.solved = true) THEN 'solved'
          WHEN EXISTS (SELECT 1 FROM puzzle_attempts pa WHERE pa.puzzle_id = p.id AND pa.user_id = $${idx}::uuid) THEN 'failed'
          ELSE NULL
        END AS solved_status`
      : ', NULL AS solved_status';
    if (userId) { params.push(userId); idx++; }

    const limitParam = `$${idx}`;
    params.push(take);
    idx++;
    const offsetParam = `$${idx}`;
    params.push(offset);

    const dataQuery = `SELECT p.id, p.fen, p.moves, p.rating, p.themes, p.source_type, p.is_public, p.created_by, p.created_at${solvedStatusSelect}
      FROM puzzles p WHERE ${whereClause} ORDER BY p.${sortCol} ${sortDir} LIMIT ${limitParam} OFFSET ${offsetParam}`;
    const countQuery = `SELECT COUNT(*)::int as total FROM puzzles p WHERE ${whereClause}`;

    const [data, countResult] = await Promise.all([
      this.prisma.$queryRawUnsafe<Array<any>>(dataQuery, ...params),
      this.prisma.$queryRawUnsafe<[{ total: number }]>(countQuery, ...params.slice(0, -2)),
    ]);

    return {
      data: data.map((p: any) => ({
        id: p.id, fen: p.fen, moves: p.moves, rating: p.rating,
        themes: p.themes, sourceType: p.source_type, isPublic: p.is_public,
        createdBy: p.created_by, createdAt: p.created_at?.toISOString?.() ?? p.created_at,
        solvedStatus: p.solved_status ?? null,
      })),
      total: countResult[0]?.total ?? 0,
    };
  }

  /**
   * POST /puzzles/batch — save generated puzzles.
   */
  @UseGuards(JwtAuthGuard)
  @Post('batch')
  async batch(
    @Body() body: { puzzles: Array<{ fen: string; moves: string; rating: number; gap: number; themes: string; sourceType: string; sourceId?: string | null; sourceMoveNum?: number; sourceMetadata?: Record<string, string>; acceptedMoves?: string }> },
    @Request() req: AuthenticatedRequest,
  ) {
    const puzzles = body.puzzles ?? [];
    if (puzzles.length === 0) return { count: 0 };

    const { randomUUID } = await import('crypto');
    const created = await this.prisma.puzzle.createMany({
      data: puzzles.slice(0, 200).map((p) => ({
        id: randomUUID(),
        fen: p.fen, moves: p.moves, rating: p.rating, gap: p.gap, themes: p.themes,
        source: 'generated', sourceType: p.sourceType || 'pgn_import',
        sourceId: p.sourceId || null, sourceMoveNum: p.sourceMoveNum ?? 0,
        sourceMetadata: p.sourceMetadata ? JSON.stringify(p.sourceMetadata) : null,
        acceptedMoves: p.acceptedMoves || null, depth: 14,
        createdBy: req.user.id, isPublic: true,
      })),
      skipDuplicates: true,
    });
    return { count: created.count };
  }

  /**
   * PATCH /puzzles/publish-all
   */
  @UseGuards(JwtAuthGuard)
  @Patch('publish-all')
  async publishAll(@Request() req: AuthenticatedRequest) {
    const result = await this.prisma.puzzle.updateMany({
      where: { createdBy: req.user.id, source: 'generated' },
      data: { isPublic: true },
    });
    return { updated: result.count };
  }

  /**
   * PATCH /puzzles/:id — update puzzle (isPublic).
   */
  @UseGuards(JwtAuthGuard)
  @Patch(':id')
  async updateOne(
    @Param('id') id: string,
    @Request() req: AuthenticatedRequest,
    @Body() body: { isPublic?: boolean },
  ) {
    const puzzle = await this.prisma.puzzle.findUnique({ where: { id } });
    if (!puzzle) throw new NotFoundException('Puzzle not found');
    if (puzzle.createdBy !== req.user.id) throw new ForbiddenException();

    const updated = await this.prisma.puzzle.update({
      where: { id },
      data: { isPublic: body.isPublic ?? puzzle.isPublic },
    });
    return { id: updated.id, isPublic: updated.isPublic, rating: updated.rating };
  }

  /**
   * DELETE /puzzles/all — delete all own generated puzzles.
   */
  @UseGuards(JwtAuthGuard)
  @Delete('all')
  async deleteAll(@Request() req: AuthenticatedRequest) {
    // Delete attempts first (no cascade), then puzzles
    const puzzles = await this.prisma.puzzle.findMany({
      where: { createdBy: req.user.id, source: 'generated' },
      select: { id: true },
    });
    const ids = puzzles.map((p) => p.id);
    if (ids.length > 0) {
      await this.prisma.puzzleAttempt.deleteMany({ where: { puzzleId: { in: ids } } });
    }
    const result = await this.prisma.puzzle.deleteMany({
      where: { createdBy: req.user.id, source: 'generated' },
    });
    return { deleted: result.count };
  }

  /**
   * DELETE /puzzles/:id
   */
  @UseGuards(JwtAuthGuard)
  @Delete(':id')
  async deleteOne(
    @Param('id') id: string,
    @Request() req: AuthenticatedRequest,
  ) {
    const puzzle = await this.prisma.puzzle.findUnique({ where: { id } });
    if (!puzzle || puzzle.createdBy !== req.user.id) return { deleted: 0 };
    await this.prisma.puzzle.delete({ where: { id } });
    return { deleted: 1 };
  }

  @Get(':id')
  getPuzzle(@Param('id') id: string) {
    return this.puzzleService.getPuzzle(id);
  }

  @UseGuards(JwtAuthGuard)
  @Post(':id/attempt')
  submitAttemptSingular(
    @Request() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: SubmitAttemptDto,
  ) {
    return this.puzzleService.submitAttempt(
      req.user.id, id, dto.result === 'solved', dto.timeMs, dto.userMoves, dto.hintsUsed,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Post(':id/attempts')
  submitAttempt(
    @Request() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: SubmitAttemptDto,
  ) {
    return this.puzzleService.submitAttempt(
      req.user.id,
      id,
      dto.result === 'solved',
      dto.timeMs,
      dto.userMoves,
      dto.hintsUsed,
    );
  }
}
