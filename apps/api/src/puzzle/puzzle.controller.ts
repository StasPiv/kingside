import { AuthenticatedRequest } from '../common/authenticated-request';
import {
  BadRequestException,
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
import { BatchPuzzlesDto } from './dto/batch-puzzle.dto';
import {
  decodePuzzleCursor,
  encodePuzzleCursor,
} from './puzzle-cursor-codec';
import { McpTool } from '../mcp/decorators';

@Controller('puzzles')
export class PuzzleController {
  constructor(
    private readonly puzzleService: PuzzleService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * GET /puzzles — search puzzles by theme and difficulty.
   */
  @McpTool({
    name: 'puzzles__find',
    description:
      'Поиск шахматных задач по теме и диапазону рейтинга. Возвращает ' +
      'список задач (FEN + метаданные); решения и попытки — отдельными ' +
      'эндпоинтами по id.',
    defaultLimit: 10,
    maxLimit: 50,
    excludeFields: ['[].solution', '[].moves'],
  })
  @Get()
  findPuzzles(@Query() dto: FindPuzzlesDto) {
    return this.puzzleService.findPuzzles({
      themes: dto.themes,
      ratingMin: dto.ratingMin,
      ratingMax: dto.ratingMax,
      limit: dto.limit,
      solutionMode: dto.solutionMode,
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
    // KS-3032: `includeAttempted` приходит строкой через query
    // (`'true' | 'false' | '1' | '0'`); приводим к boolean. Default —
    // false (для PVE строго исключаем посещённые задачи).
    const includeAttempted =
      dto?.includeAttempted === 'true' || dto?.includeAttempted === '1';
    return this.puzzleService.getNextPuzzle(req.user?.id ?? null, excludeId, {
      themes: dto?.themes,
      ratingMin: dto?.ratingMin,
      ratingMax: dto?.ratingMax,
      solutionMode: dto?.solutionMode,
      includeAttempted,
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

  @McpTool({
    name: 'puzzles__attempts',
    description:
      'История попыток пользователя по задачам: правильность, время, ' +
      'изменение рейтинга. Без полей решения/ходов.',
    defaultLimit: 20,
    maxLimit: 100,
    excludeFields: ['[].puzzle.solution', '[].puzzle.moves'],
  })
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
   * GET /puzzles/browse — keyset-курсорная пагинация (KS-2560).
   *
   * История:
   *  - KS-2556: hard-coded `p.source='generated'` убран, добавлен
   *    optional `?source=`.
   *  - KS-2557: cap-стратегия total (LIMIT 1001) — облегчила COUNT,
   *    но всё ещё offset-пагинация.
   *  - KS-2560: переход на курсор по образцу `archive-service`
   *    (см. `cursor-codec.ts`). COUNT(*) удалён полностью —
   *    бесконечная прокрутка на фронте не нуждается в total.
   *
   * Сорт: `created_at DESC, id DESC` (id — tie-breaker для
   * стабильности при равных timestamps; покрывается индексом
   * `puzzles_created_at_idx`).
   *
   * Cursor: `base64url(JSON({c: ISO-date, i: id}))`. Без курсора —
   * первая страница. Возвращаем `nextCursor` если есть N+1-ая строка.
   *
   * Фильтры:
   *  - `?ratingMin=&ratingMax=` (диапазон).
   *  - `?themes=fork,pin` (ANY-of через OR — пазл подходит если
   *    содержит хоть один из перечисленных тегов).
   *  - `?source=lichess|generated` (whitelist).
   *
   * Visibility (KS-2582, ADR-050 §3 #3):
   *  - anon или `mine=false`: ВСЕГДА `is_public=true`. Параметр
   *    `visibility` игнорируется — не утекаем чужие drafts.
   *  - `mine=true` + `visibility=all` (default): свои public + свои
   *    draft (старое поведение `mine=true`).
   *  - `mine=true` + `visibility=public`: только свои `is_public=true`.
   *  - `mine=true` + `visibility=draft`: только свои `is_public=false`.
   *  - `visibility=draft` БЕЗ `mine=true` → 400 (явная ошибка, чтобы
   *    клиент не ждал drafts там, где их в принципе быть не может).
   *  - `visibility` вне whitelist → 400.
   */
  @McpTool({
    name: 'puzzles__browse',
    description:
      'Браузер шахматных задач с keyset-курсором, фильтрами по темам/' +
      'рейтингу/источнику/blunderer-ELO. Возвращает список + ' +
      '`nextCursor` для следующей страницы.',
    defaultLimit: 20,
    maxLimit: 50,
    excludeFields: ['[].solution', '[].moves'],
  })
  @UseGuards(OptionalJwtGuard)
  @Get('browse')
  async browse(
    @Request() req: AuthenticatedRequest,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('cursor') cursor?: string,
    @Query('mine') mine?: string,
    @Query('themes') themes?: string,
    @Query('ratingMin') ratingMinStr?: string,
    @Query('ratingMax') ratingMaxStr?: string,
    @Query('hideSolved') hideSolved?: string,
    @Query('source') sourceParam?: string,
    @Query('visibility') visibilityParam?: string,
    // KS-2761. Фильтр сложности через ELO зевнувшего игрока.
    // Зевнувшая сторона = side-to-move в `source_metadata.fenBeforeBlunder`
    // ('w' → whiteElo, 'b' → blackElo). Источник рейтингов — live JOIN
    // на `archive_games_remote` (postgres_fdw, см. KS-2760).
    //
    // Legacy пазлы без `fenBeforeBlunder` или без `source_id` в archive:
    // `blundererElo = NULL`. При заданном фильтре такие пазлы
    // отсеиваются автоматически (NULL >= N = false).
    @Query('blundererEloMin') blundererEloMinStr?: string,
    @Query('blundererEloMax') blundererEloMaxStr?: string,
  ) {
    const userId = req.user?.id;
    const take = Math.min(50, Math.max(1, limit));

    // KS-2556 whitelist `source`.
    const ALLOWED_SOURCES = new Set(['lichess', 'generated']);
    const sourceFilter =
      sourceParam && ALLOWED_SOURCES.has(sourceParam) ? sourceParam : null;

    // KS-2582 whitelist `visibility`. Default — 'all' (для mine=true)
    // или игнор (для mine=false / anon — там всегда public).
    const ALLOWED_VISIBILITY = new Set(['public', 'draft', 'all']);
    if (visibilityParam !== undefined && !ALLOWED_VISIBILITY.has(visibilityParam)) {
      throw new BadRequestException(
        `visibility must be one of: public, draft, all (got '${visibilityParam}')`,
      );
    }
    const visibility = visibilityParam ?? 'all';
    // Запрос draft'ов имеет смысл только в контексте «свои» —
    // и только для авторизованного пользователя.
    if (visibility === 'draft' && (mine !== 'true' || !userId)) {
      throw new BadRequestException(
        "visibility='draft' requires authenticated mine=true (drafts are private)",
      );
    }

    const conditions: string[] = [];
    const params: (string | number)[] = [];
    let idx = 1;
    const next = (): string => `$${idx++}`;

    if (sourceFilter !== null) {
      conditions.push(`p.source = ${next()}`);
      params.push(sourceFilter);
    }

    if (mine === 'true' && userId) {
      conditions.push(`p.created_by = ${next()}::uuid`);
      params.push(userId);
      // KS-2582: дополнительно фильтруем по is_public когда нужно.
      // visibility='all' (default для mine=true) — без доп. фильтра,
      // отдаём и public, и draft (старое поведение mine=true).
      if (visibility === 'public') {
        conditions.push('p.is_public = true');
      } else if (visibility === 'draft') {
        conditions.push('p.is_public = false');
      }
    } else if (userId) {
      const placeholder = next();
      conditions.push(`(p.created_by = ${placeholder}::uuid OR p.is_public = true)`);
      params.push(userId);
    } else {
      conditions.push('p.is_public = true');
    }

    if (themes) {
      // KS-2560 ANY-of: пазл проходит, если в `themes` есть хоть один
      // из перечисленных тегов. Делаем OR-цепочку через LIKE.
      const themeList = themes
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
      if (themeList.length > 0) {
        const orParts = themeList.map((t) => {
          const ph = next();
          params.push(`%${t}%`);
          return `p.themes LIKE ${ph}`;
        });
        conditions.push(`(${orParts.join(' OR ')})`);
      }
    }

    if (ratingMinStr) {
      conditions.push(`p.rating >= ${next()}`);
      params.push(parseInt(ratingMinStr, 10));
    }
    if (ratingMaxStr) {
      conditions.push(`p.rating <= ${next()}`);
      params.push(parseInt(ratingMaxStr, 10));
    }

    // KS-2762. Фильтр по ELO зевнувшего: CASE по side-to-move из
    // `source_metadata.fenBeforeBlunder` ('w'→source_white_elo,
    // 'b'→source_black_elo). Денормализованные `source_*_elo` в
    // `puzzles` (заполняет tactic-worker) — без FDW JOIN, локальные
    // колонки. Выражение используется и в SELECT (response.blundererElo),
    // и при наличии фильтра — в WHERE.
    const blundererEloExpr = `CASE
      WHEN split_part((p.source_metadata::jsonb)->>'fenBeforeBlunder', ' ', 2) = 'w' THEN p.source_white_elo
      WHEN split_part((p.source_metadata::jsonb)->>'fenBeforeBlunder', ' ', 2) = 'b' THEN p.source_black_elo
      ELSE NULL
    END`;
    if (blundererEloMinStr) {
      const v = parseInt(blundererEloMinStr, 10);
      if (Number.isFinite(v)) {
        conditions.push(`${blundererEloExpr} >= ${next()}`);
        params.push(v);
      }
    }
    if (blundererEloMaxStr) {
      const v = parseInt(blundererEloMaxStr, 10);
      if (Number.isFinite(v)) {
        conditions.push(`${blundererEloExpr} <= ${next()}`);
        params.push(v);
      }
    }

    if (hideSolved === 'true' && userId) {
      const ph = next();
      conditions.push(
        `NOT EXISTS (SELECT 1 FROM puzzle_attempts pa WHERE pa.puzzle_id = p.id AND pa.user_id = ${ph}::uuid)`,
      );
      params.push(userId);
    }

    // KS-2560 keyset cursor: `(created_at, id) < (cursor.c, cursor.i)`.
    // Декодируем cursor; если невалидный — игнорируем (первая страница).
    const decoded = decodePuzzleCursor(cursor);
    if (decoded) {
      const phC = next();
      const phI = next();
      conditions.push(
        `(p.created_at < ${phC}::timestamp OR (p.created_at = ${phC}::timestamp AND p.id < ${phI}))`,
      );
      params.push(decoded.c, decoded.i);
    }

    // solvedStatus subquery (login only).
    let solvedStatusSelect = ', NULL AS solved_status';
    if (userId) {
      const ph = next();
      solvedStatusSelect = `, CASE
          WHEN EXISTS (SELECT 1 FROM puzzle_attempts pa WHERE pa.puzzle_id = p.id AND pa.user_id = ${ph}::uuid AND pa.solved = true) THEN 'solved'
          WHEN EXISTS (SELECT 1 FROM puzzle_attempts pa WHERE pa.puzzle_id = p.id AND pa.user_id = ${ph}::uuid) THEN 'failed'
          ELSE NULL
        END AS solved_status`;
      params.push(userId);
    }

    const whereClause = conditions.join(' AND ');

    // KS-2560: запрашиваем `take + 1` чтобы понять есть ли nextCursor.
    const limitPh = next();
    params.push(take + 1);

    // KS-2754. sourceMetadata/sourceMoveNum/sourceId/gameUrl/solutionMode
    // — UI карточки на /precision нужно показать blunderUci и sourceGame.
    //
    // KS-2762. FDW LEFT JOIN на archive_games_remote убран — рейтинги
    // живут локально в `puzzles.source_white_elo` / `source_black_elo`
    // (заполняет tactic-worker). Это снимает ~8 сек на проде (см.
    // devops EXPLAIN ANALYZE 2026-05-11 на KS-2761).
    const dataQuery = `SELECT p.id, p.fen, p.moves, p.rating, p.themes, p.source, p.source_type, p.source_id, p.source_metadata, p.source_move_num, p.game_url, p.solution_mode, p.is_public, p.created_by, p.created_at, ${blundererEloExpr} AS blunderer_elo${solvedStatusSelect}
      FROM puzzles p
      WHERE ${whereClause}
      ORDER BY p.created_at DESC, p.id DESC
      LIMIT ${limitPh}`;

    const rows = await this.prisma.$queryRawUnsafe<
      Array<{
        id: string;
        fen: string;
        moves: string;
        rating: number;
        themes: string;
        source: string;
        source_type: string | null;
        source_id: string | null;
        source_metadata: string | null;
        source_move_num: number | null;
        game_url: string | null;
        solution_mode: string | null;
        is_public: boolean;
        created_by: string | null;
        created_at: Date | string;
        blunderer_elo: number | null;
        solved_status: string | null;
      }>
    >(dataQuery, ...params);

    const hasMore = rows.length > take;
    const slice = hasMore ? rows.slice(0, take) : rows;
    const last = hasMore ? rows[take - 1] : null;
    const nextCursor =
      last && hasMore
        ? encodePuzzleCursor({
            c:
              last.created_at instanceof Date
                ? last.created_at.toISOString()
                : new Date(last.created_at).toISOString(),
            i: last.id,
          })
        : null;

    return {
      data: slice.map((p) => ({
        id: p.id,
        fen: p.fen,
        moves: p.moves,
        rating: p.rating,
        themes: p.themes,
        source: p.source,
        sourceType: p.source_type,
        isPublic: p.is_public,
        createdBy: p.created_by,
        createdAt:
          p.created_at instanceof Date
            ? p.created_at.toISOString()
            : new Date(p.created_at).toISOString(),
        solvedStatus: p.solved_status ?? null,
        // KS-2761. ELO зевнувшего из FDW JOIN на archive_games.
        // null для lichess/legacy (нет source_id в archive_games) и для
        // пазлов без fenBeforeBlunder.
        blundererElo: p.blunderer_elo,
        // KS-2754. playVsEngine.blunderMove = UCI зевка; sourceGame =
        // {white, black, event, date, ...}; sourceMoveNum = номер хода
        // в исходной партии. Все три поля опциональны — отсутствуют
        // для legacy-пазлов или forced-line.
        ...this.puzzleService.buildBrowseEnrichments({
          id: p.id,
          solution_mode: p.solution_mode,
          source_metadata: p.source_metadata,
          source_type: p.source_type,
          source_id: p.source_id,
          game_url: p.game_url,
          source_move_num: p.source_move_num,
        }),
      })),
      nextCursor,
    };
  }

  /**
   * POST /puzzles/batch — save generated puzzles.
   *
   * KS-2580 (ADR-050 §3 #1): per-puzzle опц. поле `isPublic` (default
   * `false` — draft). `solutionMode` теперь фиксирован для всех
   * generated-пазлов (`'play-vs-engine'`) — KS-2659.
   *
   * KS-2659: до фикса дефолтное `solutionMode='forced-line'` оставлось
   * в БД, если фронт не передавал явное значение (KS-2584 клиентский
   * WDL-генератор иногда не выставлял поле). Это давало data-mismatch
   * на `/precision` (frontend ожидал PVE-runner). Серверный инвариант:
   * любой пазл, попадающий через `POST /puzzles/batch`, имеет
   * `source='generated'` (см. ниже) и поэтому ОБЯЗАН быть PVE.
   * Игнорируем `p.solutionMode` от клиента — авторитет серверный.
   */
  @UseGuards(JwtAuthGuard)
  @Post('batch')
  async batch(
    @Body() body: BatchPuzzlesDto,
    @Request() req: AuthenticatedRequest,
  ) {
    const puzzles = body.puzzles ?? [];
    if (puzzles.length === 0) return { count: 0, created: [] };

    const { randomUUID } = await import('crypto');

    // KS-2959. Сначала генерируем id'ы локально, чтобы потом
    // отдать клиенту `{id, fen}` без дополнительного round-trip и
    // без race-fallback по fen (две вкладки могут создать draft с
    // одинаковым FEN — поиск по fen становится неоднозначным).
    const rows = puzzles.slice(0, 200).map((p) => ({
      id: randomUUID(),
      fen: p.fen, moves: p.moves, rating: p.rating, gap: p.gap, themes: p.themes,
      source: 'generated', sourceType: p.sourceType || 'pgn_import',
      sourceId: p.sourceId || null, sourceMoveNum: p.sourceMoveNum ?? 0,
      sourceMetadata: p.sourceMetadata ? JSON.stringify(p.sourceMetadata) : null,
      acceptedMoves: p.acceptedMoves || null, depth: 14,
      createdBy: req.user.id,
      // KS-2580: default false (draft); фронт передаёт `true` для
      // immediate-publish.
      isPublic: p.isPublic ?? false,
      // KS-2659: server-side инвариант. `source='generated'` ⇒
      // `solutionMode='play-vs-engine'` (ADR-050 §3 #1). Любое
      // значение от клиента игнорируем — это закрывает источник
      // `forced-line`-записей в БД для generated.
      solutionMode: 'play-vs-engine',
    }));

    const result = await this.prisma.puzzle.createMany({
      data: rows,
      skipDuplicates: true,
    });

    // KS-2959. `createMany` не отдаёт строки, плюс `skipDuplicates: true`
    // может отсеять часть записей по unique-констрейнтам. Делаем SELECT
    // по своим заранее сгенерированным id'ам — это даёт точное множество
    // реально вставленных строк (id'ы рандомные, конфликт по PK
    // невозможен; дубликаты отсеиваются только по другим unique-ключам).
    const ids = rows.map((r) => r.id);
    const inserted = await this.prisma.puzzle.findMany({
      where: { id: { in: ids } },
      select: { id: true },
    });
    const insertedIds = new Set(inserted.map((r) => r.id));

    // Сохраняем порядок исходного `puzzles[]`: проходим по `rows`,
    // оставляем только реально вставленные. Позиция `created[i]`
    // соответствует i-той позиции входа (с пропусками для дубликатов).
    const created = rows
      .filter((r) => insertedIds.has(r.id))
      .map((r) => ({ id: r.id, fen: r.fen }));

    return { count: result.count, created };
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
   *
   * KS-2675: явный pre-delete `puzzle_attempts` больше не нужен — FK
   * `puzzle_attempts.puzzle_id_fkey` теперь ON DELETE CASCADE
   * (миграция `20260509190000_ks2675_puzzle_cascade`). Аналогично
   * каскадятся `puzzle_rush_session_puzzles` и `daily_puzzles`;
   * `user_mistakes.puzzle_id` обнуляется (SET NULL).
   */
  @UseGuards(JwtAuthGuard)
  @Delete('all')
  async deleteAll(@Request() req: AuthenticatedRequest) {
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
      req.user.id,
      id,
      dto.result === 'solved',
      dto.timeMs,
      dto.userMoves,
      dto.hintsUsed,
      {
        halfMovesPlayed: dto.halfMovesPlayed,
        finalWdl: dto.finalWdl,
        initialWdl: dto.initialWdl,
        reason: dto.reason,
        moves: dto.moves,
      },
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
      {
        halfMovesPlayed: dto.halfMovesPlayed,
        finalWdl: dto.finalWdl,
        initialWdl: dto.initialWdl,
        reason: dto.reason,
        moves: dto.moves,
      },
    );
  }
}
