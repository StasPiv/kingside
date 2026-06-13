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
  Optional,
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
// KS-4088: dev-прокси каталога задач на прод-API (блокер KS-4065).
import { PuzzleProxyService } from './puzzle-proxy.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { SubmitAttemptDto } from './dto/submit-attempt.dto';
import { FindPuzzlesDto } from './dto/find-puzzles.dto';
import { BatchPuzzlesDto } from './dto/batch-puzzle.dto';
import {
  decodePuzzleCursor,
  encodePuzzleCursor,
} from './puzzle-cursor-codec';
import { buildBrowseFilterSql } from './puzzle-browse-filter';
import { McpTool } from '../mcp/decorators';

/**
 * KS-3893. Парсер `EXPLAIN (FORMAT JSON)` от PostgreSQL: возвращает
 * `Plan.Plan Rows` (planner-estimate числа строк) или `null`, если
 * структура неожиданная. Prisma `$queryRawUnsafe` отдаёт значение
 * колонки `QUERY PLAN` как уже распарсенный массив (jsonb-driver),
 * но защищаемся и от строки на случай legacy-режимов.
 */
function extractPlanRowsEstimate(
  rows: Array<{ 'QUERY PLAN': unknown }>,
): number | null {
  if (rows.length === 0) return null;
  let plan: unknown = rows[0]['QUERY PLAN'];
  if (typeof plan === 'string') {
    try {
      plan = JSON.parse(plan);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(plan) || plan.length === 0) return null;
  const root = plan[0];
  if (!root || typeof root !== 'object') return null;
  const nested = (root as { Plan?: unknown }).Plan;
  if (!nested || typeof nested !== 'object') return null;
  const planRows = (nested as { 'Plan Rows'?: unknown })['Plan Rows'];
  if (typeof planRows !== 'number' || !Number.isFinite(planRows)) return null;
  return Math.max(0, Math.round(planRows));
}

@Controller('puzzles')
export class PuzzleController {
  // KS-3919: точный COUNT и Redis-кеш total в `/puzzles/browse`
  // полностью убраны. На проде под фильтром `themes + hideSolved +
  // source=lichess` фоновый COUNT занимал ~57 секунд (Bitmap Heap
  // Scan на 58 489 страниц для проверки `is_public AND source='lichess'`).
  // Приблизительная оценка от планировщика PostgreSQL через
  // `EXPLAIN (FORMAT JSON)` (см. `/puzzles/browse/count`) даёт
  // результат за единицы миллисекунд с погрешностью ±5-20%, чего
  // достаточно для UI-счётчика «Найдено: ~N». `RedisService` в
  // конструкторе оставлен — нужен для DI-теста модуля и других
  // потенциальных потребителей.

  constructor(
    private readonly puzzleService: PuzzleService,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    // KS-4088 (блокер KS-4065): dev-прокси каталога на прод-API.
    // @Optional — юнит-тесты конструируют контроллер напрямую без DI
    // (3 аргумента). В рантайме Nest всегда внедряет сервис из модуля;
    // в тестах он undefined и все proxy-ветки уходят в локальный путь.
    @Optional() private readonly puzzleProxy?: PuzzleProxyService,
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
    // KS-3353 / ADR-079. Для scope=server (chips-bar Precision):
    // явный «не мои» фильтр. mine=false исторически означал «мои +
    // публичные» (см. ниже OR-блок) — теперь фронт может передать
    // excludeMine=true и получить ТОЛЬКО публичные не-мои.
    // NULL-aware: legacy puzzle с created_by IS NULL включаются.
    @Query('excludeMine') excludeMineParam?: string,
    // KS-3357 / ADR-080 §4.1. Расширенный theme-фильтр.
    // - themesAnd[]: все темы обязательны (legacy AND-семантика).
    // - themesOr[]:  хотя бы одна тема (multi-select из bottom-sheet).
    // Backend серверной валидацией отсекает темы вне whitelist'а
    // PRECISION_RELEVANT_THEMES (защита от LIKE-инъекций).
    @Query('themesAnd') themesAndParam?: string | string[],
    @Query('themesOr') themesOrParam?: string | string[],
    // KS-3656 / ADR-106 §2.6. Серверный фильтр precision-каталога по
    // вероятности Maia сыграть плохо. Когда задан и > 0:
    //   WHERE maia_weak_choice_prob >= $threshold
    //     AND maia_metric_version = 1
    // (вторая часть отсеивает строки, не размеченные под актуальную
    // версию формулы). null / undefined / 0 — без фильтра. Диапазон
    // валидируется ниже как 0..1; вне — BadRequestException. Заменяет
    // клиентский фильтр KS-3642 (ползунок UI KS-3654 → API KS-3657).
    @Query('minMaiaWeakChoiceProb') minMaiaWeakChoiceProbStr?: string,
    // KS-3670 / ADR-106 §2.6. Парный параметр под двусторонний
    // ползунок KS-3665: верхняя граница диапазона. Семантика:
    //   undefined / >= 1 → без фильтра;
    //   0 ≤ v < 1 → WHERE maia_weak_choice_prob <= $max
    //               AND maia_metric_version = 1;
    //   вне [0, 1] либо не число → BadRequestException 400.
    // При наличии и min, и max получаем `BETWEEN $min AND $max`.
    @Query('maxMaiaWeakChoiceProb') maxMaiaWeakChoiceProbStr?: string,
  ): Promise<{
    data: Record<string, unknown>[];
    nextCursor: string | null;
    total: number | null;
  }> {
    // KS-4088 (блокер KS-4065): на dev локальная puzzle-БД содержит лишь
    // 3 задачи lichess. При заданном PUZZLE_SERVICE_URL отдаём прод-каталог
    // целиком (богатый список + рабочий nextCursor для бесконечной прокрутки).
    //
    // KS-4066 fix: НЕ форвардим user-scoped запросы. `mine=true` —
    // личный каталог пользователя (черновики + опубликованные); эти
    // пазлы локальные и на проде их нет → форвард ломал «Мои черновики»/
    // «Мои опубликованные» («Не удалось загрузить пазлы»). Такие запросы
    // обслуживаем ЛОКАЛЬНО; на прод уходит только общий серверный каталог.
    if (this.puzzleProxy?.enabled && mine !== 'true') {
      return this.puzzleProxy.forward((req as { url: string }).url) as Promise<{
        data: Record<string, unknown>[];
        nextCursor: string | null;
        total: number | null;
      }>;
    }

    const userId = req.user?.id ?? null;
    const take = Math.min(50, Math.max(1, limit));

    // KS-3893: вся нормализация/валидация фильтров вынесена в
    // `buildBrowseFilterSql` — переиспользуется в `/puzzles/browse/count`.
    const filter = buildBrowseFilterSql({
      userId,
      mine,
      themes,
      ratingMin: ratingMinStr,
      ratingMax: ratingMaxStr,
      hideSolved,
      source: sourceParam,
      visibility: visibilityParam,
      excludeMine: excludeMineParam,
      blundererEloMin: blundererEloMinStr,
      blundererEloMax: blundererEloMaxStr,
      themesAnd: themesAndParam,
      themesOr: themesOrParam,
      minMaiaWeakChoiceProb: minMaiaWeakChoiceProbStr,
      maxMaiaWeakChoiceProb: maxMaiaWeakChoiceProbStr,
    });
    const conditions = [...filter.conditions];
    const params: (string | number)[] = [...filter.params];
    let idx = filter.nextParamIndex;
    const next = (): string => `$${idx++}`;
    const blundererEloExpr = filter.blundererEloExpr;

    // KS-2560 keyset cursor: `(created_at, id) < (cursor.c, cursor.i)`.
    // Декодируем cursor; если невалидный — игнорируем (первая страница).
    // KS-3919: snapshot фильтров для count удалён — точный COUNT в
    // `/puzzles/browse` больше не выполняется ни синхронно, ни в фоне.
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
    // KS-3663 / ADR-106 §2.5. Добавлены p.maia_weak_choice_prob,
    // p.maia_metric_version, p.maia_top1_elo — фронт индикатора
    // сложности (KS-3660/KS-3662) их ожидает в DTO. До KS-3663
    // эти поля не выбирались SQL'ем, и /puzzles/browse возвращал
    // строки без них (хотя в БД для 11685 пазлов значения есть
    // после прогона KS-3643).
    const dataQuery = `SELECT p.id, p.fen, p.moves, p.rating, p.themes, p.source, p.source_type, p.source_id, p.source_metadata, p.source_move_num, p.game_url, p.solution_mode, p.is_public, p.created_by, p.created_at, p.maia_weak_choice_prob, p.maia_metric_version, p.maia_top1_elo, ${blundererEloExpr} AS blunderer_elo${solvedStatusSelect}
      FROM puzzles p
      WHERE ${whereClause}
      ORDER BY p.created_at DESC, p.id DESC
      LIMIT ${limitPh}`;

    // KS-3666 / ADR-106. Точный счётчик «Найдено: N» в UI каталога.
    // Считается на snapshot conditions/params до cursor — total
    // стабилен при переходе на следующую страницу.
    //
    // KS-3891. Регрессия: на проде countQuery без курсора + фильтр
    // `source='lichess'` + NOT EXISTS на puzzle_attempts давал
    // Parallel Seq Scan на ~6M строк (~10 секунд). Решение:
    //   1. Count считается ТОЛЬКО на первой странице (cursor=undefined),
    //      т.к. он стабилен при переходе на следующие страницы —
    //      фронт уже знает значение.
    //   2. Результат кешируется в Redis с TTL 5 минут per
    //      (нормализованные фильтры + userId). Stale-окно для UI-
    //      счётчика приемлемо; lichess-пазлы заливаются батчами.
    //   3. На последующих страницах total не передаётся в SQL —
    //      возвращаем `null` (фронт должен сохранить значение с
    //      первой страницы).
    const dataRowsPromise = this.prisma.$queryRawUnsafe<
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
        // KS-3663 / ADR-106 §2.5.
        maia_weak_choice_prob: number | null;
        maia_metric_version: number | null;
        maia_top1_elo: number | null;
        blunderer_elo: number | null;
        solved_status: string | null;
      }>
    >(dataQuery, ...params);

    // KS-3919. `total` в `/puzzles/browse` всегда `null`. Раньше
    // (KS-3893) на cache miss запускался фоновый COUNT с записью в
    // Redis, но на проде под фильтром `themes + hideSolved + source=lichess`
    // он занимал ~57 секунд — тащит 58 000 heap-страниц для проверки
    // `is_public AND source='lichess'`. Точного числа в каталоге задач
    // больше не считаем; UI получает приблизительную оценку через
    // отдельный `GET /puzzles/browse/count` (EXPLAIN FORMAT JSON,
    // см. `estimateBrowseTotal`).
    const rows = await dataRowsPromise;
    const total: number | null = null;

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
        // KS-3663 / ADR-106 §2.5. Maia-поля для индикатора сложности
        // (KS-3660/KS-3662). null — пазл не размечен либо размечен под
        // отменённую формулу (maiaMetricVersion != 1).
        maiaWeakChoiceProb: p.maia_weak_choice_prob ?? null,
        maiaMetricVersion: p.maia_metric_version ?? null,
        maiaTop1Elo: p.maia_top1_elo ?? null,
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
      // KS-3666. Общее число подходящих пазлов под текущие фильтры
      // (БЕЗ учёта курсора — стабилен между страницами). Фронт
      // KS-3672 отображает «Найдено: N» вместо «N+».
      //
      // KS-3893: на cache miss теперь `null` (фоновый COUNT в Redis
      // не блокирует ответ). Фронт получает точное число отдельным
      // вызовом `/puzzles/browse/count`.
      total,
    };
  }

  /**
   * GET /puzzles/browse/count — приблизительный счётчик подходящих под
   * фильтры задач (KS-3919).
   *
   * Реализация — `EXPLAIN (FORMAT JSON) SELECT COUNT(*)…`, парсим
   * `Plan.Plan Rows` (оценка планировщика без выполнения запроса).
   * Время — единицы миллисекунд. Округление до сотен (1234 → 1200);
   * для значений <100 — точное (чтобы UI не показывал «~0» / «~50»
   * на узком фильтре).
   *
   * История: до KS-3919 endpoint поддерживал параметр `approx` и точный
   * путь через Redis-кеш + COUNT. Точный COUNT под `themes + hideSolved
   * + source=lichess` занимал на проде ~57 секунд (Bitmap Heap Scan на
   * 58 000 страниц для проверки `is_public AND source='lichess'`), тогда
   * как UI-счётчик «Найдено: ~N» прекрасно работает на приблизительной
   * оценке. Точный путь убран, параметр `approx` тоже — endpoint
   * всегда возвращает приблизительный результат.
   *
   * Контракт ответа: `{ total: number, approximate: true }`. Поле
   * `approximate` оставлено для совместимости с frontend KS-3894:
   * приходит всегда `true`.
   *
   * Фильтр-параметры идентичны `/puzzles/browse`, кроме пагинационных
   * (`limit`, `cursor`).
   */
  @UseGuards(OptionalJwtGuard)
  @Get('browse/count')
  async browseCount(
    @Request() req: AuthenticatedRequest,
    @Query('mine') mine?: string,
    @Query('themes') themes?: string,
    @Query('ratingMin') ratingMinStr?: string,
    @Query('ratingMax') ratingMaxStr?: string,
    @Query('hideSolved') hideSolved?: string,
    @Query('source') sourceParam?: string,
    @Query('visibility') visibilityParam?: string,
    @Query('blundererEloMin') blundererEloMinStr?: string,
    @Query('blundererEloMax') blundererEloMaxStr?: string,
    @Query('excludeMine') excludeMineParam?: string,
    @Query('themesAnd') themesAndParam?: string | string[],
    @Query('themesOr') themesOrParam?: string | string[],
    @Query('minMaiaWeakChoiceProb') minMaiaWeakChoiceProbStr?: string,
    @Query('maxMaiaWeakChoiceProb') maxMaiaWeakChoiceProbStr?: string,
  ): Promise<{ total: number; approximate: true }> {
    // KS-4088: согласованно с browse — счётчик «Найдено: N» берём с прода.
    // KS-4066 fix: user-scoped счётчики (mine=true — черновики/мои/
    // опубликованные) считаем ЛОКАЛЬНО, на прод уходит только общий
    // серверный каталог (иначе chips-bar «Мои черновики: N» брал бы с прода).
    if (this.puzzleProxy?.enabled && mine !== 'true') {
      return this.puzzleProxy.forward(
        (req as { url: string }).url,
      ) as Promise<{ total: number; approximate: true }>;
    }

    const userId = req.user?.id ?? null;
    const filter = buildBrowseFilterSql({
      userId,
      mine,
      themes,
      ratingMin: ratingMinStr,
      ratingMax: ratingMaxStr,
      hideSolved,
      source: sourceParam,
      visibility: visibilityParam,
      excludeMine: excludeMineParam,
      blundererEloMin: blundererEloMinStr,
      blundererEloMax: blundererEloMaxStr,
      themesAnd: themesAndParam,
      themesOr: themesOrParam,
      minMaiaWeakChoiceProb: minMaiaWeakChoiceProbStr,
      maxMaiaWeakChoiceProb: maxMaiaWeakChoiceProbStr,
    });

    // KS-3919: всегда `EXPLAIN (FORMAT JSON)` без fallback'а на точный
    // COUNT. Если EXPLAIN по какой-либо причине упадёт (неподдерживаемая
    // версия PG, отсутствуют права), `estimateBrowseTotal` бросает
    // исключение — оно превращается в 500 Nest-ом. Это правильное
    // поведение: молчаливый fallback скрывал бы реальные проблемы
    // конфигурации БД, а точный путь мы удалили.
    const estimate = await this.estimateBrowseTotal(
      filter.conditions,
      filter.params,
    );
    return { total: estimate, approximate: true };
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
      // KS-3141: gap опционален (legacy cp-метрика, может отсутствовать
      // у новых WDL-пазлов и быть отрицательным у legacy).
      fen: p.fen, moves: p.moves, rating: p.rating, gap: p.gap ?? null, themes: p.themes,
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
    // KS-4088: на dev задача может жить только на проде — отдаём её оттуда.
    if (this.puzzleProxy?.enabled) {
      return this.puzzleProxy.getPuzzle(id);
    }
    return this.puzzleService.getPuzzle(id);
  }

  @UseGuards(JwtAuthGuard)
  @Post(':id/attempt')
  async submitAttemptSingular(
    @Request() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: SubmitAttemptDto,
  ) {
    // KS-4088: задача каталога может прийти с прода и отсутствовать в
    // локальной БД — материализуем её перед грейдингом (FK + проверка
    // хода по fen/moves). Попытка пишется ЛОКАЛЬНО → статистика и дневник
    // ошибок наполняются на наших таблицах.
    if (this.puzzleProxy?.enabled) {
      await this.puzzleProxy.ensureLocalPuzzle(id);
    }
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
  async submitAttempt(
    @Request() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: SubmitAttemptDto,
  ) {
    // KS-4088: см. submitAttemptSingular — материализуем прод-задачу локально.
    if (this.puzzleProxy?.enabled) {
      await this.puzzleProxy.ensureLocalPuzzle(id);
    }
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

  /**
   * KS-3893 / KS-3919. Approximate count через `EXPLAIN (FORMAT JSON)`
   * — даёт оценку планировщика за единицы миллисекунд без выполнения
   * самого запроса. Результат округляется до сотен (1234 → 1200);
   * для значений <100 — точное значение (иначе UI показывал бы
   * «~0» / «~50» на очень узком фильтре).
   *
   * `Plan."Plan Rows"` — стандартное поле `EXPLAIN FORMAT JSON`
   * (PostgreSQL docs `60.5. Sample Output`). Доступно с PG 9.x;
   * на проде PG 16.
   *
   * KS-3919: точный COUNT через Redis-кеш удалён, оценка планировщика
   * стала единственным источником значения для `/puzzles/browse/count`.
   * Если EXPLAIN отказался отдавать `Plan.Plan Rows` — бросаем
   * исключение, Nest вернёт 500: это правильное поведение, любой
   * fallback на точный путь скрывал бы реальные проблемы конфигурации
   * БД, а точного пути больше нет.
   */
  private async estimateBrowseTotal(
    filterConditions: string[],
    filterParams: unknown[],
  ): Promise<number> {
    const countWhere = filterConditions.join(' AND ');
    const explainQuery = `EXPLAIN (FORMAT JSON) SELECT COUNT(*)::int AS total FROM puzzles p WHERE ${countWhere}`;
    const rows = await this.prisma.$queryRawUnsafe<
      Array<{ 'QUERY PLAN': unknown }>
    >(explainQuery, ...filterParams);
    const planRows = extractPlanRowsEstimate(rows);
    if (planRows === null) {
      throw new Error('EXPLAIN FORMAT JSON: Plan.Plan Rows not found');
    }
    if (planRows < 100) return planRows;
    return Math.round(planRows / 100) * 100;
  }
}
