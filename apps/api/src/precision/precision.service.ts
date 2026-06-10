/**
 * KS-2718 / ADR-056 §5 B5–B6. Precision-метрики Уровня А и детали
 * одной попытки для PostGameReview.
 *
 * Таблицы (KS-2717):
 *   - `puzzle_attempts` — один к одному с `precision_attempts`.
 *   - `precision_attempts` — агрегаты PVE-попытки.
 *   - `precision_attempt_moves` — per-move детали.
 */
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type {
  PrecisionAttemptDetail,
  PrecisionAttemptsListResponse,
  PrecisionBreakdownsResponse,
  PrecisionStatsResponse,
  PrecisionTrendsResponse,
  PrecisionMoveInput,
} from '@kingside/shared';
import {
  classifyMove,
  computePrecisionScore,
  computeVerdictKey,
} from '@kingside/shared';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import type { CreateTestFixtureAttemptDto } from './dto/test-fixture.dto';

const SCOPE_COUNTS_CACHE_TTL_SEC = 60;
const SCOPE_COUNTS_CACHE_PREFIX = 'precision:scope-counts:';
// KS-3358 / ADR-080 §4.3: cache для theme-counts. Ключ зависит
// от всех фильтров (scope+objective+hideSolved+rating), 60s TTL.
const THEME_COUNTS_CACHE_TTL_SEC = 60;
const THEME_COUNTS_CACHE_PREFIX = 'precision:theme-counts:';

/**
 * KS-3352 fix. `Puzzle.rating` хранится как INT4 (PostgreSQL `integer`,
 * range ±2^31). Раньше для «бесконечного окна» в `pickNext` использовался
 * `Number.MAX_SAFE_INTEGER` (~9·10^15) — Prisma binding падал с
 * `ConversionError`. Реальный диапазон Lichess-рейтингов 600-3500;
 * 0..4000 покрывает с запасом и помещается в INT4.
 */
const RATING_INT4_MIN = 0;
const RATING_INT4_MAX = 4000;

@Injectable()
export class PrecisionService {
  private readonly logger = new Logger(PrecisionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  /**
   * KS-3344 / ADR-079 §3.4 / §4.1. Авто-подбор следующей precision-
   * задачи по рейтинг-окну Glicko-1.
   *
   * Алгоритм (ADR §2.3):
   *  1. target = `user_precision_ratings.rating ?? 1500` (для гостя 1500).
   *  2. window = 150 → 300 → 500 → 1000 → ∞ (расширяется до первой
   *     непустой выборки).
   *  3. Фильтры:
   *     - `source = 'generated'`,
   *     - scope-маппинг (server/drafts/published; ADR §2.1),
   *     - `themes && [objective]` (если objective ≠ 'all'),
   *     - `hideSolved = true` (default; исключаем уже решённые),
   *     - `rating BETWEEN target-window AND target+window`.
   *  4. Random pick: `ORDER BY random() LIMIT 1`.
   *  5. Если slider override → `overrideRatingMin/Max` вместо
   *     автоалгоритма (одно окно, без расширения).
   *
   * Возвращает `{ puzzleId, rating, ratingDelta }` или null (с
   * reason='no_puzzles_available' на controller'е).
   */
  async pickNext(
    userId: string | null,
    filters: {
      scope: 'server' | 'drafts' | 'published';
      objective?: 'all' | 'convertAdvantage' | 'saveEquality';
      overrideRatingMin?: number;
      overrideRatingMax?: number;
      hideSolved?: boolean;
      // KS-3357 / ADR-080: theme-фильтр. Backend гарантирует
      // что значения уже отвалидированы against whitelist (controller).
      themesAnd?: string[];
      themesOr?: string[];
      // KS-3661 / ADR-106 §2.6. Серверный фильтр precision-каталога
      // по weak-choice prob. Семантика и валидация — на controller'е
      // (см. PrecisionController.pickNext). Здесь только использование.
      minMaiaWeakChoiceProb?: number;
      // KS-3670 / ADR-106 §2.6. Верхняя граница диапазона weak-choice
      // prob (под двусторонний ползунок KS-3665). Семантика 1:1 с
      // нижней границей: undefined / >= 1 → без фильтра; иначе
      // добавляем `lte`. Валидация диапазона — на controller'е.
      maxMaiaWeakChoiceProb?: number;
    },
  ): Promise<
    | {
        puzzleId: string;
        rating: number;
        ratingDelta: number;
        // KS-3663 / ADR-106 §2.5. Поля Maia-разметки нужны фронту
        // для индикатора сложности (KS-3660 / KS-3662). Null — пазл
        // ещё не размечен либо размечен под отменённую формулу
        // (`maia_metric_version != 1`).
        maiaWeakChoiceProb: number | null;
        maiaMetricVersion: number | null;
        maiaTop1Elo: number | null;
      }
    | { puzzleId: null; reason: 'no_puzzles_for_themes' }
    | null
  > {
    // 1. target rating.
    let target = 1500;
    if (userId) {
      const row = await this.prisma.userPrecisionRating.findUnique({
        where: { userId },
        select: { rating: true },
      });
      if (row) target = row.rating;
    } else {
      // Гость: ADR §5 fixed 1200. Лёгкие задачи на старте.
      target = 1200;
    }

    // 2. scope-маппинг. Гостю — только server (даже если фронт
    // прислал другое; ADR §5 «гостю показываем только scope=server»).
    const effectiveScope =
      userId ? filters.scope : ('server' as 'server' | 'drafts' | 'published');
    const scopeWhere = this.buildScopeWhere(effectiveScope, userId);
    if (!scopeWhere) {
      return null; // невалидная комбинация (например, гость с drafts).
    }

    const hideSolved = filters.hideSolved !== false; // default true
    const useOverride =
      filters.overrideRatingMin !== undefined ||
      filters.overrideRatingMax !== undefined;

    // 3. Окна — массив; при override один элемент.
    //
    // KS-3352 fix: `Number.MAX_SAFE_INTEGER` (2^53) бросал Prisma
    // `ConversionError("Unable to fit integer value into INT4")` —
    // `Puzzle.rating` хранится как INT4 (range ±2^31). Заменили на
    // безопасные INT4-границы реального диапазона Lichess-рейтингов
    // (RATING_INT4_MIN/MAX). Последнее окно «∞» = весь корпус.
    const windowsOrSingle = useOverride
      ? [
          {
            min: filters.overrideRatingMin ?? RATING_INT4_MIN,
            max: filters.overrideRatingMax ?? RATING_INT4_MAX,
          },
        ]
      : [150, 300, 500, 1000, null].map((w) =>
          w === null
            ? { min: RATING_INT4_MIN, max: RATING_INT4_MAX }
            : { min: target - w, max: target + w },
        );

    const themesAnd = filters.themesAnd ?? [];
    const themesOr = filters.themesOr ?? [];

    // 4. Итерируем по окнам до первой непустой выборки.
    for (const win of windowsOrSingle) {
      const picked = await this.tryPickInWindow(
        userId,
        scopeWhere,
        win.min,
        win.max,
        filters.objective,
        hideSolved,
        themesAnd,
        themesOr,
        filters.minMaiaWeakChoiceProb,
        filters.maxMaiaWeakChoiceProb,
      );
      if (picked) {
        return {
          puzzleId: picked.id,
          rating: picked.rating ?? 1500,
          ratingDelta: (picked.rating ?? 1500) - target,
          // KS-3663 / ADR-106 §2.5. Прокидываем maia-поля для
          // индикатора сложности на фронте (KS-3660/KS-3662).
          maiaWeakChoiceProb: picked.maiaWeakChoiceProb ?? null,
          maiaMetricVersion: picked.maiaMetricVersion ?? null,
          maiaTop1Elo: picked.maiaTop1Elo ?? null,
        };
      }
    }
    // KS-3357 / ADR-080 §3.3: если фильтр по темам активен И даже при
    // бесконечном окне ничего нет — разделяем 404 reason.
    if (themesAnd.length > 0 || themesOr.length > 0) {
      return { puzzleId: null, reason: 'no_puzzles_for_themes' };
    }
    return null;
  }

  /**
   * Scope-маппинг → Prisma where-фрагмент (createdBy + isPublic).
   * Гостю drafts/published невалидны → возвращает null.
   */
  private buildScopeWhere(
    scope: 'server' | 'drafts' | 'published',
    userId: string | null,
  ): { isPublic: boolean; createdByMatch: 'self' | 'other' | 'any' } | null {
    if (scope === 'server') {
      return {
        isPublic: true,
        createdByMatch: userId ? 'other' : 'any',
      };
    }
    if (!userId) return null;
    if (scope === 'drafts') {
      return { isPublic: false, createdByMatch: 'self' };
    }
    // published
    return { isPublic: true, createdByMatch: 'self' };
  }

  /**
   * Один проход выборки с фиксированным rating-окном.
   * `ORDER BY random() LIMIT 1` — простой подход; на больших объёмах
   * (миллионы puzzle'ов) дороговат, но Postgres делает it'ё
   * приемлемо при индексе по rating + partition по фильтрам.
   * Альтернатива (TABLESAMPLE / offset-trick) — оптимизация на M2.
   */
  private async tryPickInWindow(
    userId: string | null,
    scopeWhere: {
      isPublic: boolean;
      createdByMatch: 'self' | 'other' | 'any';
    },
    ratingMin: number,
    ratingMax: number,
    objective: 'all' | 'convertAdvantage' | 'saveEquality' | undefined,
    hideSolved: boolean,
    themesAnd: string[] = [],
    themesOr: string[] = [],
    minMaiaWeakChoiceProb?: number,
    // KS-3670 / ADR-106 §2.6. Верхняя граница диапазона.
    maxMaiaWeakChoiceProb?: number,
  ): Promise<{
    id: string;
    rating: number | null;
    // KS-3663 / ADR-106 §2.5. Прокидываем поля Maia-разметки наверх
    // в pickNext → controller → DTO для индикатора сложности.
    maiaWeakChoiceProb: number | null;
    maiaMetricVersion: number | null;
    maiaTop1Elo: number | null;
  } | null> {
    const where: Record<string, unknown> = {
      source: 'generated',
      isPublic: scopeWhere.isPublic,
      rating: { gte: ratingMin, lte: ratingMax },
    };
    // KS-3661 / KS-3670 / ADR-106 §2.6. Серверный фильтр по Maia
    // weak-choice prob. Симметричные правила:
    //   min: undefined / 0 → без gte; > 0 → gte=min.
    //   max: undefined / >= 1 → без lte; < 1 → lte=max.
    // Хотя бы одна граница активна — добавляем `maia_metric_version=1`
    // (иначе строки, размеченные под отменённую формулу, прошли бы
    // в выборку). 1:1 с KS-3656/KS-3670 на /puzzles/browse. Валидация
    // диапазона — на controller'е; здесь полагаемся на pre-validated input.
    const maiaProbRange: { gte?: number; lte?: number } = {};
    if (minMaiaWeakChoiceProb !== undefined && minMaiaWeakChoiceProb > 0) {
      maiaProbRange.gte = minMaiaWeakChoiceProb;
    }
    if (maxMaiaWeakChoiceProb !== undefined && maxMaiaWeakChoiceProb < 1) {
      maiaProbRange.lte = maxMaiaWeakChoiceProb;
    }
    if (
      maiaProbRange.gte !== undefined ||
      maiaProbRange.lte !== undefined
    ) {
      where.maiaWeakChoiceProb = maiaProbRange;
      where.maiaMetricVersion = 1;
    }
    if (scopeWhere.createdByMatch === 'self') {
      where.createdBy = userId;
    } else if (scopeWhere.createdByMatch === 'other' && userId) {
      // KS-3352 follow-up: SQL NULL semantics. Prisma переводит
      // `createdBy: { not: X }` в `created_by != X`, что для NULL
      // даёт NULL (не TRUE) — все legacy puzzle с `created_by IS
      // NULL` отсеивались. Нужен explicit OR с null branch.
      where.OR = [
        { createdBy: null },
        { createdBy: { not: userId } },
      ];
    }
    // KS-3357 fix: `Puzzle.themes` — String (TEXT, CSV), не string[].
    // Prisma `{ has }` для строк бросает; используем `{ contains }`
    // (SQL ILIKE). objective + themesAnd → AND-цепочка через массив
    // `AND: [{ themes: contains... }, ...]`. themesOr → объединяем в
    // OR-выражение Prisma.
    const themeAndFilters: Array<{
      themes: { contains: string };
    }> = [];
    if (objective && objective !== 'all') {
      themeAndFilters.push({ themes: { contains: objective } });
    }
    for (const t of themesAnd) {
      themeAndFilters.push({ themes: { contains: t } });
    }
    if (themeAndFilters.length > 0) {
      const existingAnd = (where.AND as object[] | undefined) ?? [];
      where.AND = [...existingAnd, ...themeAndFilters];
    }
    if (themesOr.length > 0) {
      // themesOr внутри OR. Если уже есть `where.OR` (NULL-aware
      // createdBy) — нужен AND-блок чтобы не смешать с null-branch.
      const orThemes = themesOr.map((t) => ({
        themes: { contains: t },
      }));
      // Перекладываем существующий where.OR в AND-блок,
      // а where.OR ставим на themesOr-список.
      // Это сохраняет AND (createdBy NULL OR != me) AND (theme1 OR theme2 OR ...).
      if (where.OR) {
        const existingAnd = (where.AND as object[] | undefined) ?? [];
        where.AND = [
          ...existingAnd,
          { OR: where.OR },
          { OR: orThemes },
        ];
        delete where.OR;
      } else {
        where.OR = orThemes;
      }
    }
    if (hideSolved && userId) {
      where.attempts = { none: { userId } };
    }
    // Pick через raw SQL — Prisma не умеет ORDER BY random().
    // Используем простой findFirst + случайный skip как fallback,
    // если raw недоступен — но Postgres ORDER BY random() читаем:
    // pull count + offset random — slower на хороших объёмах.
    // Делаем findMany с take=50 и JS random pick (компромисс
    // «нет full-scan, но и не идеально равномерно по выборке»).
    const candidates = await this.prisma.puzzle.findMany({
      where: where as never,
      select: {
        id: true,
        rating: true,
        // KS-3663 / ADR-106 §2.5. Поля Maia нужны фронту для
        // индикатора сложности (KS-3660/KS-3662). До KS-3663
        // select их не запрашивал — DTO `/precision/next` шёл
        // без них, фронт получал undefined и не рисовал блок.
        maiaWeakChoiceProb: true,
        maiaMetricVersion: true,
        maiaTop1Elo: true,
      },
      take: 50,
    });
    if (candidates.length === 0) return null;
    const pick = candidates[Math.floor(Math.random() * candidates.length)];
    return pick;
  }

  /**
   * KS-3358 / ADR-080 §4.3. Counter per-theme для bottom-sheet'а
   * фильтра тем. Возвращает count'ы по `PRECISION_RELEVANT_THEMES`
   * под текущие фильтры (scope + objective + hideSolved +
   * rating-range), БЕЗ учёта самого theme-фильтра.
   *
   * SQL — один aggregate через `unnest(string_to_array(themes,' '))`
   * + LATERAL JOIN + GROUP BY. На проде audit показал 5.4ms на 1595
   * puzzles → 7025 unnest rows → 19 уникальных тем. p95 ≤ 10ms;
   * cache 60s покрывает повторные открытия sheet'а.
   *
   * Гость → принудительно scope=server, без hideSolved (нет attempts).
   */
  async getThemeCounts(
    userId: string | null,
    filters: {
      scope: 'server' | 'drafts' | 'published';
      objective?: 'all' | 'convertAdvantage' | 'saveEquality';
      hideSolved?: boolean;
      ratingMin?: number;
      ratingMax?: number;
    },
  ): Promise<{ counts: Record<string, number> }> {
    // Гость — drafts/published нет, принудительно server.
    const effectiveScope = userId ? filters.scope : 'server';

    // Cache key — детерминированный JSON-сериализатор всех фильтров.
    const cacheKey = `${THEME_COUNTS_CACHE_PREFIX}${userId ?? 'guest'}:${JSON.stringify({
      scope: effectiveScope,
      objective: filters.objective ?? null,
      hideSolved: filters.hideSolved !== false,
      ratingMin: filters.ratingMin ?? null,
      ratingMax: filters.ratingMax ?? null,
    })}`;
    try {
      const cached = await this.redis.get(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (parsed && typeof parsed.counts === 'object') {
          return parsed;
        }
      }
    } catch (err) {
      this.logger.warn(
        `[getThemeCounts] redis get failed for ${cacheKey}: ${(err as Error).message}`,
      );
    }

    // Whitelist (импорт здесь чтобы не загружать модуль если cache hit).
    const { PRECISION_RELEVANT_THEMES } = await import('@kingside/shared');

    // Сборка WHERE для базовой выборки (фильтры до theme-агрегата).
    const conditions: string[] = [
      `solution_mode = 'play-vs-engine'`, // precision-only
    ];
    const params: (string | number | string[])[] = [];
    let idx = 1;
    const next = (): string => `$${idx++}`;

    // Scope-маппинг (ADR-079 §2.1):
    //   server    — is_public=true AND (created_by IS NULL OR != userId)
    //   drafts    — is_public=false AND created_by = userId
    //   published — is_public=true AND created_by = userId
    if (effectiveScope === 'drafts' && userId) {
      conditions.push(`is_public = false`);
      conditions.push(`created_by = ${next()}::uuid`);
      params.push(userId);
    } else if (effectiveScope === 'published' && userId) {
      conditions.push(`is_public = true`);
      conditions.push(`created_by = ${next()}::uuid`);
      params.push(userId);
    } else {
      // server (default + guest)
      conditions.push(`is_public = true`);
      if (userId) {
        const ph = next();
        conditions.push(`(created_by IS NULL OR created_by != ${ph}::uuid)`);
        params.push(userId);
      }
    }

    // Objective: themes LIKE '%objective%' (одна тема обязательна).
    if (filters.objective && filters.objective !== 'all') {
      const ph = next();
      conditions.push(`themes LIKE ${ph}`);
      params.push(`%${filters.objective}%`);
    }

    // hideSolved через NOT EXISTS (joined puzzle_attempts).
    let hideSolvedClause = '';
    if ((filters.hideSolved !== false) && userId) {
      const ph = next();
      hideSolvedClause = `AND NOT EXISTS (
        SELECT 1 FROM puzzle_attempts pa
         WHERE pa.puzzle_id = puzzles.id AND pa.user_id = ${ph}::uuid
      )`;
      params.push(userId);
    }

    // Rating range.
    if (filters.ratingMin !== undefined) {
      conditions.push(`rating >= ${next()}`);
      params.push(filters.ratingMin);
    }
    if (filters.ratingMax !== undefined) {
      conditions.push(`rating <= ${next()}`);
      params.push(filters.ratingMax);
    }

    // Whitelist для GROUP BY filter.
    const whitelistPh = next();
    params.push(PRECISION_RELEVANT_THEMES as unknown as string[]);

    const sql = `
      SELECT theme, COUNT(*)::int AS cnt
      FROM puzzles,
        LATERAL unnest(string_to_array(themes, ' ')) AS theme
      WHERE ${conditions.join(' AND ')}
        ${hideSolvedClause}
        AND theme = ANY(${whitelistPh}::text[])
      GROUP BY theme
    `;

    const rows = await this.prisma.$queryRawUnsafe<
      Array<{ theme: string; cnt: number }>
    >(sql, ...params);

    const counts: Record<string, number> = {};
    for (const r of rows) counts[r.theme] = Number(r.cnt);

    const result = { counts };
    try {
      await this.redis.set(
        cacheKey,
        JSON.stringify(result),
        'EX',
        THEME_COUNTS_CACHE_TTL_SEC,
      );
    } catch (err) {
      this.logger.warn(
        `[getThemeCounts] redis set failed for ${cacheKey}: ${(err as Error).message}`,
      );
    }
    return result;
  }

  /**
   * KS-3346 / ADR-079 §3.5 / §4.4. Precision-рейтинг текущего user'а.
   *
   * Гостю — 401 на уровне controller (`JwtAuthGuard`). Для нового
   * user'а без записи возвращаем default `{ rating: 1500, deviation:
   * 350, attempts: 0, lastAttemptAt: null }`.
   */
  async getMyRating(userId: string): Promise<{
    rating: number;
    deviation: number;
    attempts: number;
    lastAttemptAt: string | null;
  }> {
    const row = await this.prisma.userPrecisionRating.findUnique({
      where: { userId },
    });
    if (!row) {
      return {
        rating: 1500,
        deviation: 350,
        attempts: 0,
        lastAttemptAt: null,
      };
    }
    return {
      rating: row.rating,
      deviation: row.deviation,
      attempts: row.attempts,
      lastAttemptAt: row.lastAttemptAt?.toISOString() ?? null,
    };
  }

  /**
   * KS-3345 / ADR-079 §3.3 / §4.2. Счётчики precision-пазлов для
   * pill'ов chips-bar [Серверные] / [Мои черновики] / [Мои опубликованные].
   *
   * Маппинг scope → фильтры (см. ADR §2.1):
   *   - server    = source='generated' AND is_public=true AND created_by != userId
   *   - drafts    = source='generated' AND is_public=false AND created_by = userId
   *   - published = source='generated' AND is_public=true AND created_by = userId
   *
   * Cache: 60s per-user, ключ `precision:scope-counts:<userId>`.
   * Гость (userId=null) — возвращает только `server` count (drafts/
   * published = 0 и пилюлы скрыты на фронте).
   *
   * Replica-safe: ключ user-specific, без write race-conditions.
   */
  async getScopeCounts(
    userId: string | null,
  ): Promise<{ server: number; drafts: number; published: number }> {
    // Гость: drafts/published тривиально 0; server считаем (он публичный).
    if (!userId) {
      const server = await this.prisma.puzzle.count({
        where: { source: 'generated', isPublic: true },
      });
      return { server, drafts: 0, published: 0 };
    }

    const cacheKey = `${SCOPE_COUNTS_CACHE_PREFIX}${userId}`;
    try {
      const cached = await this.redis.get(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (
          parsed &&
          typeof parsed.server === 'number' &&
          typeof parsed.drafts === 'number' &&
          typeof parsed.published === 'number'
        ) {
          return parsed;
        }
      }
    } catch (err) {
      this.logger.warn(
        `[getScopeCounts] redis get failed for ${cacheKey}: ${(err as Error).message}`,
      );
    }

    // Три COUNT'а параллельно. На большой puzzle-таблице count'ы
    // тяжёлые — но cache на 60s покрывает 99% нагрузки. Если станет
    // bottleneck — переход на approximate-count или materialized view.
    const [server, drafts, published] = await Promise.all([
      this.prisma.puzzle.count({
        where: {
          source: 'generated',
          isPublic: true,
          // KS-3352 follow-up: SQL NULL semantics. Просто
          // `{ not: userId }` транслируется в `created_by != X`,
          // что для NULL даёт NULL (не TRUE) — все 1530 legacy
          // puzzle с `created_by IS NULL` отсеивались. Нужен
          // explicit OR с null branch.
          OR: [{ createdBy: null }, { createdBy: { not: userId } }],
        },
      }),
      this.prisma.puzzle.count({
        where: {
          source: 'generated',
          isPublic: false,
          createdBy: userId,
        },
      }),
      this.prisma.puzzle.count({
        where: {
          source: 'generated',
          isPublic: true,
          createdBy: userId,
        },
      }),
    ]);
    const result = { server, drafts, published };
    try {
      await this.redis.set(
        cacheKey,
        JSON.stringify(result),
        'EX',
        SCOPE_COUNTS_CACHE_TTL_SEC,
      );
    } catch (err) {
      this.logger.warn(
        `[getScopeCounts] redis set failed for ${cacheKey}: ${(err as Error).message}`,
      );
    }
    return result;
  }

  /**
   * Уровень А (ADR-056 §2.1): top-блок `/precision` страницы.
   * `since` — опц. ISO-date для фильтрации «за период».
   */
  async getStatsForUser(
    userId: string,
    since?: Date,
  ): Promise<PrecisionStatsResponse> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Базовый фильтр: PVE-attempts текущего пользователя.
    // Через relation puzzle.solutionMode='play-vs-engine' (KS-2716/B1
    // подтвердил что relation-фильтр работает корректно).
    const baseFilter: {
      userId: string;
      puzzle: { is: { solutionMode: 'play-vs-engine' } };
      createdAt?: { gte?: Date };
    } = {
      userId,
      puzzle: { is: { solutionMode: 'play-vs-engine' } },
    };
    if (since) {
      baseFilter.createdAt = { gte: since };
    }

    // Counters по puzzle_attempts.
    const [totalAttempts, preservedCount, todayAttempts, todayPreserved] =
      await Promise.all([
        this.prisma.puzzleAttempt.count({ where: baseFilter }),
        this.prisma.puzzleAttempt.count({
          where: { ...baseFilter, solved: true },
        }),
        this.prisma.puzzleAttempt.count({
          where: {
            userId,
            puzzle: { is: { solutionMode: 'play-vs-engine' } },
            createdAt: { gte: today },
          },
        }),
        this.prisma.puzzleAttempt.count({
          where: {
            userId,
            puzzle: { is: { solutionMode: 'play-vs-engine' } },
            createdAt: { gte: today },
            solved: true,
          },
        }),
      ]);

    const lostCount = Math.max(0, totalAttempts - preservedCount);
    const preservedRate =
      totalAttempts > 0 ? preservedCount / totalAttempts : 0;

    // Аггрегаты по precision_attempts: AVG(accuracy), AVG(wdlLeak/halfMoves),
    // AVG(firstMistakePly).
    //
    // Связь PrecisionAttempt → PuzzleAttempt 1:1 через attemptId. Чтобы
    // фильтровать по userId + since + solutionMode (PVE), идём через
    // relation `attempt`.
    const precisionFilter: {
      attempt: {
        userId: string;
        puzzle: { is: { solutionMode: 'play-vs-engine' } };
        createdAt?: { gte: Date };
      };
    } = {
      attempt: {
        userId,
        puzzle: { is: { solutionMode: 'play-vs-engine' } },
      },
    };
    if (since) {
      precisionFilter.attempt.createdAt = { gte: since };
    }

    const [
      accuracyAgg,
      leakRows,
      firstMistakeAgg,
      // KS-3000: avgScore / avgScorePct + распределение по звёздам.
      scoreAgg,
      scoreGroups,
    ] = await Promise.all([
      this.prisma.precisionAttempt.aggregate({
        where: precisionFilter,
        _avg: { accuracyPercent: true },
      }),
      // wdlLeakSum / halfMovesPlayed — нужно посчитать как ratio, не
      // SUM/SUM (иначе попытки с разной длиной зазвешиваются по
      // длине). По ADR-056 §2.1 формула — `Σ(wdlBefore-wdlAfter) /
      // totalUserMoves`. Это эквивалентно AVG(leakSum/halfMovesPlayed)
      // взвешенному по halfMovesPlayed; для простоты усредняем
      // плоским `AVG`, метрика — оценочная.
      this.prisma.precisionAttempt.findMany({
        where: { ...precisionFilter, halfMovesPlayed: { gt: 0 } },
        select: { wdlLeakSum: true, halfMovesPlayed: true },
      }),
      this.prisma.precisionAttempt.aggregate({
        where: { ...precisionFilter, firstMistakePly: { not: null } },
        _avg: { firstMistakePly: true },
      }),
      // KS-3000 / ADR-065 §6.5: AVG среди attempts со score!=null
      // (legacy без WDL/cp проигнорированы — это правильно: NULL не
      // искажает среднее).
      this.prisma.precisionAttempt.aggregate({
        where: { ...precisionFilter, score: { not: null } },
        _avg: { score: true, scorePct: true },
      }),
      // KS-3000: распределение по звёздам через groupBy. Индекс
      // `precision_attempts_score_idx` (KS-2998) ускоряет COUNT(*).
      this.prisma.precisionAttempt.groupBy({
        by: ['score'],
        where: { ...precisionFilter, score: { not: null } },
        _count: { score: true },
      }),
    ]);

    let avgWdlLeakPerMove = 0;
    if (leakRows.length > 0) {
      let totalLeak = 0;
      let totalMoves = 0;
      for (const r of leakRows) {
        totalLeak += r.wdlLeakSum;
        totalMoves += r.halfMovesPlayed;
      }
      avgWdlLeakPerMove = totalMoves > 0 ? totalLeak / totalMoves : 0;
    }

    // KS-3000: scoreDistribution. groupBy({score}) даёт массив
    // `{score: 1..5 | null, _count: {score: N}}`; разворачиваем в
    // объект stars1..stars5. NULL-группа исключена фильтром выше.
    const scoreDistribution = {
      stars1: 0,
      stars2: 0,
      stars3: 0,
      stars4: 0,
      stars5: 0,
    };
    for (const g of scoreGroups) {
      if (g.score === null || g.score === undefined) continue;
      const key = `stars${g.score}` as keyof typeof scoreDistribution;
      if (key in scoreDistribution) scoreDistribution[key] = g._count.score;
    }

    return {
      totalAttempts,
      preservedCount,
      lostCount,
      preservedRate,
      avgAccuracyPercent: accuracyAgg._avg.accuracyPercent ?? 0,
      avgWdlLeakPerMove,
      avgHalfMovesUntilFirstMistake:
        firstMistakeAgg._avg.firstMistakePly ?? null,
      todayAttempts,
      todayPreserved,
      // KS-3000 / ADR-065 §6.5.
      avgScore: scoreAgg._avg.score ?? null,
      avgScorePct: scoreAgg._avg.scorePct ?? null,
      scoreDistribution,
    };
  }

  /**
   * KS-2724: список PVE-попыток текущего пользователя для блока
   * «История попыток» на /precision. Возвращает агрегаты Уровня А
   * каждой попытки (accuracyPercent, classCounts, endReason); per-move
   * детали тянутся отдельно через `getAttemptDetail`.
   *
   * Сортировка — последние первыми (`createdAt DESC`).
   */
  async listAttemptsForUser(
    userId: string,
    limit: number,
    offset: number,
  ): Promise<PrecisionAttemptsListResponse> {
    // KS-2737: убрали фильтр `precisionAttempt: isNot: null`. Раньше
    // attempts без записи в `precision_attempts` (legacy/PVE без
    // moves[]-snapshot из фронта) не попадали в список — пользователь
    // видел пустую историю даже при наличии puzzle_attempts. Теперь
    // показываем все PVE-attempts; если нет precisionAttempt-snapshot,
    // возвращаем дефолтные агрегаты (accuracy=0, classCounts=0,
    // endReason='legacy'). Фронт может отрендерить такой item с
    // меткой «без детального разбора».
    const baseFilter = {
      userId,
      puzzle: { is: { solutionMode: 'play-vs-engine' as const } },
    };

    const [rows, total] = await Promise.all([
      this.prisma.puzzleAttempt.findMany({
        where: baseFilter,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
        include: {
          puzzle: { select: { id: true, fen: true } },
          precisionAttempt: true,
        },
      }),
      this.prisma.puzzleAttempt.count({ where: baseFilter }),
    ]);

    const items = rows.map((r) => {
      const pa = r.precisionAttempt;
      if (pa) {
        // KS-3341 / ADR-079 §3.5 / ADR-082 §7 F1. Precision-рейтинг
        // в строке списка для UI-колонки ±delta. Все три поля
        // синхронно null если попытка skipped в PrecisionRatingService
        // (гость / hidden-test / self-created). Float в БД — для UI
        // округляем до int (rating везде отображается целым).
        const ratingBefore =
          pa.ratingBefore == null ? null : Math.round(pa.ratingBefore);
        const ratingAfter =
          pa.ratingAfter == null ? null : Math.round(pa.ratingAfter);
        const ratingDelta =
          ratingBefore == null || ratingAfter == null
            ? null
            : ratingAfter - ratingBefore;
        return {
          attemptId: r.id,
          puzzleId: r.puzzleId,
          puzzleFen: r.puzzle.fen,
          attemptedAt: r.createdAt.toISOString(),
          solved: r.solved,
          endReason: pa.endReason,
          halfMovesPlayed: pa.halfMovesPlayed,
          accuracyPercent: pa.accuracyPercent,
          classCounts: {
            best: pa.bestMovesCount,
            good: pa.goodMovesCount,
            inaccuracy: pa.inaccuraciesCount,
            mistake: pa.mistakesCount,
            blunder: pa.blundersCount,
          },
          // KS-3000 / ADR-065 §6.1. 5★-оценка; null для legacy.
          score: pa.score,
          // KS-3077 / ADR-065 §6.1. Процент той же WDL/cp-шкалы;
          // фронт показывает его на карточке вместо accuracyPercent
          // (синхрон со звёздами и detail-страницей).
          scorePct: pa.scorePct,
          // KS-3246. Ось «цель пазла достигнута».
          objectiveAchieved: pa.objectiveAchieved,
          // KS-3246 / KS-3248. Verdict-key для плашки.
          verdictKey: computeVerdictKey(
            pa.score as 1 | 2 | 3 | 4 | 5 | null,
            pa.objectiveAchieved,
          ),
          ratingBefore,
          ratingAfter,
          ratingDelta,
        };
      }
      // Legacy/без moves[]-snapshot — дефолтные агрегаты.
      return {
        attemptId: r.id,
        puzzleId: r.puzzleId,
        puzzleFen: r.puzzle.fen,
        attemptedAt: r.createdAt.toISOString(),
        solved: r.solved,
        endReason: 'legacy',
        halfMovesPlayed: 0,
        accuracyPercent: 0,
        classCounts: {
          best: 0,
          good: 0,
          inaccuracy: 0,
          mistake: 0,
          blunder: 0,
        },
        score: null,
        scorePct: null,
        objectiveAchieved: null,
        verdictKey: null,
        // KS-3341: legacy/без precisionAttempt — рейтинг не считался.
        ratingBefore: null,
        ratingAfter: null,
        ratingDelta: null,
      };
    });

    return { items, total };
  }

  /**
   * Уровень Б (ADR-056 §2.2): детали одной PVE-попытки.
   *
   * Доступ: только владелец attempt'а или админ. 404 если attempt
   * не существует или это не PVE.
   */
  async getAttemptDetail(
    attemptId: string,
    requestingUserId: string,
    isAdmin: boolean,
  ): Promise<PrecisionAttemptDetail> {
    const attempt = await this.prisma.puzzleAttempt.findUnique({
      where: { id: attemptId },
      include: {
        precisionAttempt: { include: { moves: { orderBy: { ply: 'asc' } } } },
        puzzle: { select: { id: true, solutionMode: true } },
      },
    });

    if (!attempt || !attempt.precisionAttempt) {
      throw new NotFoundException(`Precision attempt ${attemptId} not found`);
    }
    if (attempt.puzzle.solutionMode !== 'play-vs-engine') {
      throw new NotFoundException(
        `Attempt ${attemptId} is not a play-vs-engine attempt`,
      );
    }
    if (!isAdmin && attempt.userId !== requestingUserId) {
      throw new ForbiddenException(
        'You do not have access to this precision attempt',
      );
    }

    const pa = attempt.precisionAttempt;
    return {
      attemptId: attempt.id,
      puzzleId: attempt.puzzleId,
      attemptedAt: attempt.createdAt.toISOString(),
      solved: attempt.solved,
      endReason: pa.endReason,
      halfMovesPlayed: pa.halfMovesPlayed,
      halfMovesTarget: pa.halfMovesTarget,
      accuracyPercent: pa.accuracyPercent,
      classCounts: {
        best: pa.bestMovesCount,
        good: pa.goodMovesCount,
        inaccuracy: pa.inaccuraciesCount,
        mistake: pa.mistakesCount,
        blunder: pa.blundersCount,
      },
      wdlAtStart: pa.wdlAtStartSigned,
      wdlAtEnd: pa.wdlAtEndSigned,
      wdlLeakSum: pa.wdlLeakSum,
      firstMistakePly: pa.firstMistakePly,
      // KS-3000 / ADR-065 §6.1.
      score: pa.score,
      scorePct: pa.scorePct,
      // KS-3246. Goal-achieved + verdict для плашки (KS-3248).
      objectiveAchieved: pa.objectiveAchieved,
      verdictKey: computeVerdictKey(
        pa.score as 1 | 2 | 3 | 4 | 5 | null,
        pa.objectiveAchieved,
      ),
      moves: pa.moves.map((m) => ({
        ply: m.ply,
        fenBefore: m.fenBefore,
        playedUci: m.playedUci,
        bestUci: m.bestUci,
        // KS-2754. Отдаём полное W/D/L distribution per-mille (как
        // лежит в БД), а не свёрнутый скаляр — фронт показывает W/D/L%.
        // null если хотя бы одна компонента не записана (legacy /
        // fallback-движок без UCI_ShowWDL).
        wdlBefore: wdlTripleOrNull(m.wdlBeforeW, m.wdlBeforeD, m.wdlBeforeL),
        wdlAfter: wdlTripleOrNull(m.wdlAfterW, m.wdlAfterD, m.wdlAfterL),
        depth: m.depth,
        classification: m.classification as PrecisionAttemptDetail['moves'][number]['classification'],
        // KS-2754. UCI engine-ответа на этот user-ход; кладёт фронт
        // при сохранении attempt'а. null для последнего user-полухода
        // партии и для legacy-attempt'ов (до KS-2754).
        engineUci: m.engineUci,
      })),
    };
  }

  // ── KS-2727: Уровень В — trends + breakdowns ────────────────────

  /**
   * KS-2727 B7.1. Тренд точности и удержания по бакетам времени.
   * Группировка по `date_trunc(bucket, created_at)`. Пустые бакеты
   * не возвращаются — фронт сам нарисует «дни без попыток».
   */
  async getTrendsForUser(
    userId: string,
    options: {
      bucket: 'day' | 'week' | 'month';
      since?: Date;
      until?: Date;
    },
  ): Promise<PrecisionTrendsResponse> {
    const bucket = options.bucket;
    const sinceMs = options.since?.toISOString() ?? null;
    const untilMs = options.until?.toISOString() ?? null;

    // Прямой SQL: date_trunc + JOIN. Параметризованные значения
    // подставляются через Prisma.sql — защита от SQL-injection.
    const rows = await this.prisma.$queryRawUnsafe<
      Array<{
        bucket_start: Date;
        attempts: bigint;
        preserved: bigint;
        avg_accuracy: number | null;
        sum_leak: number | null;
        sum_half_moves: bigint;
        // KS-3000: AVG идёт только по строкам со score!=null (PG AVG
        // автоматически игнорирует NULL — это нужное поведение).
        avg_score: number | null;
        avg_score_pct: number | null;
        // KS-3376 / ADR-082 §4.2 §7 B1. SUM(rating_after − rating_before)
        // по попыткам с непустыми рейтингами. NULL — если все попытки
        // в бакете без рейтинга. PG SUM игнорирует NULL автоматически;
        // (rating_after − rating_before) даёт NULL если ЛЮБОЙ из
        // операндов NULL (rating пишется паре, поэтому либо оба, либо
        // ни одного — guard via skip-логика в PrecisionRatingService).
        rating_delta: number | null;
        // KS-3376. rating_after последней (по created_at DESC) попытки
        // бакета с непустым рейтингом. Получаем через
        // array_agg(... ORDER BY created_at DESC) FILTER (WHERE ... IS
        // NOT NULL) — компактный one-pass без window function.
        // Возвращается float; в TS округляем до int.
        rating_end: number | null;
      }>
    >(
      `
      SELECT
        date_trunc($2::text, pa.created_at) AS bucket_start,
        COUNT(*)::bigint                   AS attempts,
        SUM(CASE WHEN pa.solved THEN 1 ELSE 0 END)::bigint AS preserved,
        AVG(prec.accuracy_percent)::float  AS avg_accuracy,
        SUM(prec.wdl_leak_sum)::float      AS sum_leak,
        SUM(prec.half_moves_played)::bigint AS sum_half_moves,
        AVG(prec.score)::float             AS avg_score,
        AVG(prec.score_pct)::float         AS avg_score_pct,
        SUM(prec.rating_after - prec.rating_before)::float AS rating_delta,
        (
          array_agg(prec.rating_after ORDER BY pa.created_at DESC)
            FILTER (WHERE prec.rating_after IS NOT NULL)
        )[1]::float AS rating_end
      FROM puzzle_attempts pa
      JOIN puzzles p ON p.id = pa.puzzle_id
      JOIN precision_attempts prec ON prec.attempt_id = pa.id
      WHERE pa.user_id = $1::uuid
        AND p.solution_mode = 'play-vs-engine'
        ${sinceMs ? 'AND pa.created_at >= $3::timestamp' : ''}
        ${untilMs ? `AND pa.created_at <= $${sinceMs ? 4 : 3}::timestamp` : ''}
      GROUP BY bucket_start
      ORDER BY bucket_start ASC
      `,
      ...[userId, bucket, sinceMs, untilMs].filter((v) => v !== null),
    );

    return {
      bucket,
      points: rows.map((r) => ({
        bucketStart: r.bucket_start.toISOString(),
        attempts: Number(r.attempts),
        preserved: Number(r.preserved),
        avgAccuracyPercent: r.avg_accuracy ?? 0,
        avgWdlLeakPerMove:
          Number(r.sum_half_moves) > 0
            ? (r.sum_leak ?? 0) / Number(r.sum_half_moves)
            : 0,
        // KS-3000 / ADR-065 §6.5. null если в бакете все score=null.
        avgScore: r.avg_score,
        avgScorePct: r.avg_score_pct,
        // KS-3376 / ADR-082 §4.2. Округляем до int для тренд-графика:
        // precision-рейтинг — целое число в UI (Glicko-1 формула
        // возвращает float, но мы отображаем как int).
        ratingEnd: r.rating_end == null ? null : Math.round(r.rating_end),
        ratingDelta:
          r.rating_delta == null ? null : Math.round(r.rating_delta),
      })),
    };
  }

  /**
   * KS-2727 B7.2. Разбивка по фазе игры (по числу фигур в FEN
   * первого хода попытки) и по темам пазла.
   */
  async getBreakdownsForUser(
    userId: string,
    since?: Date,
  ): Promise<PrecisionBreakdownsResponse> {
    const sinceMs = since?.toISOString() ?? null;

    // ── byPhase: считаем фазу по FEN первого хода каждой попытки ───
    // Грузим (attemptId, fen первого ply, accuracyPercent). PG SQL не
    // парсит FEN, поэтому делаем JS-группировку на пачке.
    const movesRows = await this.prisma.$queryRawUnsafe<
      Array<{ accuracy: number; first_fen: string }>
    >(
      `
      SELECT
        prec.accuracy_percent::float AS accuracy,
        first_move.fen_before        AS first_fen
      FROM puzzle_attempts pa
      JOIN puzzles p ON p.id = pa.puzzle_id
      JOIN precision_attempts prec ON prec.attempt_id = pa.id
      JOIN LATERAL (
        SELECT fen_before
        FROM precision_attempt_moves m
        WHERE m.attempt_id = pa.id
        ORDER BY m.ply ASC
        LIMIT 1
      ) AS first_move ON TRUE
      WHERE pa.user_id = $1::uuid
        AND p.solution_mode = 'play-vs-engine'
        ${sinceMs ? 'AND pa.created_at >= $2::timestamp' : ''}
      `,
      ...[userId, sinceMs].filter((v) => v !== null),
    );

    const phaseAcc = new Map<
      'opening' | 'middlegame' | 'endgame',
      { sum: number; n: number }
    >();
    for (const r of movesRows) {
      const phase = classifyPhaseByFen(r.first_fen);
      if (!phase) continue;
      const acc = phaseAcc.get(phase) ?? { sum: 0, n: 0 };
      acc.sum += r.accuracy;
      acc.n += 1;
      phaseAcc.set(phase, acc);
    }
    const byPhase: PrecisionBreakdownsResponse['byPhase'] = (
      ['opening', 'middlegame', 'endgame'] as const
    ).map((phase) => {
      const a = phaseAcc.get(phase) ?? { sum: 0, n: 0 };
      return {
        phase,
        attempts: a.n,
        avgAccuracyPercent: a.n > 0 ? a.sum / a.n : 0,
      };
    });

    // ── byTheme: UNNEST string_to_array(themes, ' ') ───────────────
    const themeRows = await this.prisma.$queryRawUnsafe<
      Array<{ theme: string; attempts: bigint; avg_accuracy: number | null }>
    >(
      `
      SELECT
        theme,
        COUNT(*)::bigint           AS attempts,
        AVG(prec.accuracy_percent)::float AS avg_accuracy
      FROM puzzle_attempts pa
      JOIN puzzles p ON p.id = pa.puzzle_id
      JOIN precision_attempts prec ON prec.attempt_id = pa.id,
           UNNEST(string_to_array(p.themes, ' ')) AS theme
      WHERE pa.user_id = $1::uuid
        AND p.solution_mode = 'play-vs-engine'
        AND theme <> ''
        AND theme NOT IN ('playVsEngine')
        ${sinceMs ? 'AND pa.created_at >= $2::timestamp' : ''}
      GROUP BY theme
      ORDER BY (100 - COALESCE(AVG(prec.accuracy_percent)::float, 0)) DESC,
               COUNT(*) DESC
      LIMIT 10
      `,
      ...[userId, sinceMs].filter((v) => v !== null),
    );

    const byTheme: PrecisionBreakdownsResponse['byTheme'] = themeRows.map(
      (r) => ({
        theme: r.theme,
        attempts: Number(r.attempts),
        avgAccuracyPercent: r.avg_accuracy ?? 0,
        weakness: 100 - (r.avg_accuracy ?? 0),
      }),
    );

    return { byPhase, byTheme };
  }

  // ── KS-3029: dev-only fixture для e2e (KS-3007) ──────────────────

  /**
   * KS-3029. Создаёт precision-attempt с произвольными moves БЕЗ
   * chess.js валидации — для e2e KS-3007 (5★ сценарии ADR-065 §4.3).
   *
   * Доступ ограничен `DevOnlyGuard` на контроллере (NODE_ENV !=
   * production). На проде endpoint вернёт 404 ещё до вызова сервиса.
   *
   * Алгоритм:
   *  1. Если `puzzleId` не задан — берём первый PVE-пазл из БД.
   *  2. Для каждого move: classifyMove(WDL/isBestMove).
   *  3. Считаем counts, accuracyPercent, firstMistakePly, wdlLeakSum.
   *  4. computePrecisionScore → score, scorePct.
   *  5. Транзакция: PuzzleAttempt + PrecisionAttempt + Moves.
   *  6. Возврат `{attemptId, score, scorePct}`.
   */
  async createTestFixtureAttempt(args: {
    userId: string;
    body: CreateTestFixtureAttemptDto;
  }): Promise<{
    attemptId: string;
    score: number | null;
    scorePct: number | null;
  }> {
    const moves = args.body.moves ?? [];
    if (moves.length === 0) {
      throw new BadRequestException('moves[] must be non-empty');
    }

    let puzzleId = args.body.puzzleId;
    if (!puzzleId) {
      const puzzle = await this.prisma.puzzle.findFirst({
        where: { solutionMode: 'play-vs-engine' },
        select: { id: true },
      });
      if (!puzzle) {
        throw new BadRequestException(
          'No PVE puzzle in DB to attach fixture attempt. Pass puzzleId explicitly.',
        );
      }
      puzzleId = puzzle.id;
    }

    // Классификация + входы для score.
    const classified = moves.map((m) => {
      const isBestMove = m.playedUci === m.bestUci;
      const klass = classifyMove({
        wdlBefore: m.wdlBefore ?? null,
        wdlAfter: m.wdlAfter ?? null,
        isBestMove,
      });
      return { m, klass };
    });

    const counts = {
      best: 0,
      good: 0,
      inaccuracy: 0,
      mistake: 0,
      blunder: 0,
    };
    let firstMistakePly: number | null = null;
    let wdlLeakSum = 0;
    for (const c of classified) {
      counts[c.klass]++;
      if (
        firstMistakePly == null &&
        (c.klass === 'mistake' || c.klass === 'blunder')
      ) {
        firstMistakePly = c.m.ply;
      }
      const wb = c.m.wdlBefore;
      const wa = c.m.wdlAfter;
      if (wb && wa) {
        const eBefore = (wb.w + wb.d / 2) / 1000;
        const eAfter = (wa.w + wa.d / 2) / 1000;
        wdlLeakSum += Math.max(0, eBefore - eAfter);
      }
    }
    const total = classified.length;
    const accuracyPercent =
      total > 0 ? ((counts.best + counts.good) / total) * 100 : 0;

    const scoreInputs: PrecisionMoveInput[] = classified.map(({ m, klass }) => ({
      wdlBefore: m.wdlBefore ?? null,
      wdlAfter: m.wdlAfter ?? null,
      classification: klass,
    }));
    const scoreResult = computePrecisionScore(scoreInputs);

    // WDL_signed start/end для PrecisionAttempt (упрощённо).
    const first = moves[0];
    const last = moves[moves.length - 1];
    const wdlSigned = (w: { w: number; d: number; l: number } | null | undefined) =>
      w ? (w.w - w.l) / 1000 : 0;
    const wdlAtStartSigned = wdlSigned(first.wdlBefore);
    const wdlAtEndSigned = wdlSigned(last.wdlAfter);

    const endReason = args.body.endReason ?? 'win';
    const solved = args.body.solved ?? true;

    const attemptId = await this.prisma.$transaction(async (tx) => {
      const created = await tx.puzzleAttempt.create({
        data: {
          puzzleId: puzzleId!,
          userId: args.userId,
          solved,
          timeMs: 0,
          ratingBefore: 0,
          ratingAfter: 0,
          userMoves: null,
          hintsUsed: 0,
        },
        select: { id: true },
      });

      await tx.precisionAttempt.create({
        data: {
          attemptId: created.id,
          wdlAtStartSigned,
          wdlAtEndSigned,
          halfMovesPlayed: total,
          halfMovesTarget: total,
          accuracyPercent,
          bestMovesCount: counts.best,
          goodMovesCount: counts.good,
          inaccuraciesCount: counts.inaccuracy,
          mistakesCount: counts.mistake,
          blundersCount: counts.blunder,
          firstMistakePly,
          wdlLeakSum,
          endReason,
          score: scoreResult.stars,
          scorePct: scoreResult.scorePct,
        },
      });

      if (classified.length > 0) {
        await tx.precisionAttemptMove.createMany({
          data: classified.map(({ m, klass }) => ({
            attemptId: created.id,
            ply: m.ply,
            fenBefore: m.fenBefore ?? '',
            playedUci: m.playedUci,
            bestUci: m.bestUci,
            wdlBeforeW: m.wdlBefore?.w ?? null,
            wdlBeforeD: m.wdlBefore?.d ?? null,
            wdlBeforeL: m.wdlBefore?.l ?? null,
            wdlAfterW: m.wdlAfter?.w ?? null,
            wdlAfterD: m.wdlAfter?.d ?? null,
            wdlAfterL: m.wdlAfter?.l ?? null,
            depth: m.depth ?? null,
            classification: klass,
          })),
        });
      }

      return created.id;
    });

    this.logger.log(
      `KS-3029 test fixture: user=${args.userId} puzzle=${puzzleId} ` +
        `moves=${total} score=${scoreResult.stars} scorePct=${scoreResult.scorePct?.toFixed(1)}`,
    );

    return {
      attemptId,
      score: scoreResult.stars,
      scorePct: scoreResult.scorePct,
    };
  }
}

/**
 * KS-2727: эвристика фазы по FEN. По числу не-королевских фигур
 * (всех major/minor/pawn у обеих сторон):
 *   ≥28 → opening; 14..27 → middlegame; ≤13 → endgame.
 *
 * Эталонная начальная позиция = 32 фигуры; чем меньше материала,
 * тем дальше игра. Король не считаем (всегда есть).
 */
export function classifyPhaseByFen(
  fen: string,
): 'opening' | 'middlegame' | 'endgame' | null {
  const board = fen.split(/\s+/)[0];
  if (!board) return null;
  let count = 0;
  for (const ch of board) {
    if (/[prnbqPRNBQ]/.test(ch)) count++;
  }
  if (count >= 28) return 'opening';
  if (count >= 14) return 'middlegame';
  return 'endgame';
}

/**
 * KS-2754. Собирает W/D/L per-mille distribution из трёх колонок БД.
 * Возвращает `null`, если хотя бы одна компонента не записана
 * (legacy attempt'ы либо attempt с fallback-движком без UCI_ShowWDL).
 */
function wdlTripleOrNull(
  w: number | null,
  d: number | null,
  l: number | null,
): { w: number; d: number; l: number } | null {
  if (w == null || d == null || l == null) return null;
  return { w, d, l };
}
