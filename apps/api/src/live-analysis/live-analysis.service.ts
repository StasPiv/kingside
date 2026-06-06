import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Chess } from 'chess.js';
import { customAlphabet } from 'nanoid';
import {
  type LiveAnalysisListItem,
  type LiveAnalysisMoveEvent,
  type LiveAnalysisOrientation,
  type LiveAnalysisResponse,
  type LiveAnalysisStatePatchPayload,
  type LiveAnalysisSyncSnapshot,
} from '@kingside/shared';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { MetricsService } from '../metrics/metrics.service';
import { CreateLiveAnalysisDto } from './dto/create-live-analysis.dto';
import { TokenBucketLimiter } from './live-analysis-rate-limiter';

/**
 * KS-3732 / ADR-110: сервис live-трансляций анализа партии.
 *
 * Слои данных:
 *   - Postgres (`live_analyses`) — метаданные и аудит. Persistent.
 *   - Redis hash `live_analysis:<id>:state` — текущая позиция
 *     (startingFen, currentFen, currentPly, orientation).
 *   - Redis list `live_analysis:<id>:moves` — UCI-история по порядку.
 *   - Redis integer `live_analysis:<id>:viewers` — счётчик зрителей.
 *   - TTL 24ч на все три Redis-ключа, продлевается на каждый ход
 *     (см. `STATE_TTL_SEC`).
 *
 * Pub/sub — для multi-instance готовности и форвардинга событий в
 * gateway-обработчик (см. ADR §2.1, §2.2):
 *   - `live-analysis:move`   — broadcast хода всем подписанным.
 *   - `live-analysis:sync`   — полный snapshot (на reset / явный sync).
 *   - `live-analysis:closed` — финализация (owner / cleanup-job).
 *
 * Ключевые риски (ADR §2.9), реализованы здесь:
 *   - mutex per-slug на эмитах автора — `slugQueues` chain promise.
 *   - валидация UCI через `chess.js` строго на сервере.
 *   - throttling `lastActivityAt` — не чаще раза в `LAST_ACTIVITY_THROTTLE_MS`
 *     per-slug; промахи копятся в `lastActivityCache`.
 */
@Injectable()
export class LiveAnalysisService {
  private readonly logger = new Logger(LiveAnalysisService.name);

  /** Алфавит nanoid — URL-safe, без легко путающихся 0/O и 1/l. */
  private static readonly SLUG_ALPHABET =
    '23456789abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ';
  private static readonly SLUG_LENGTH = 10;
  private static readonly SLUG_GEN_MAX_ATTEMPTS = 5;

  /** TTL ключей Redis — продлевается на каждый ход. */
  static readonly STATE_TTL_SEC = 24 * 60 * 60;

  /** Окно дросселирования `lastActivityAt` — UPDATE per-slug не чаще
   *  раза в N мс. ADR §2.9.7. */
  static readonly LAST_ACTIVITY_THROTTLE_MS = 10_000;

  static readonly INITIAL_FEN =
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

  static readonly CHANNEL_MOVE = 'live-analysis:move';
  static readonly CHANNEL_SYNC = 'live-analysis:sync';
  static readonly CHANNEL_CLOSED = 'live-analysis:closed';

  /** KS-3733 / ADR §3. Порог неактивности для cleanup-job (мс). */
  static readonly INACTIVITY_THRESHOLD_MS = 30 * 60 * 1000;
  /** KS-3733: ключ Redis-lock'а cleanup-job'а (multi-instance защита). */
  static readonly CLEANUP_LOCK_KEY = 'cleanup:live-analysis:lock';
  /** TTL lock'а — 4 минуты: меньше, чем интервал тика (5 мин),
   *  чтобы при падении инстанса lock не пережил следующий тик. */
  static readonly CLEANUP_LOCK_TTL_SEC = 240;
  /** Сколько кандидатов брать в один тик. Защита от «50k записей за раз». */
  static readonly CLEANUP_BATCH_LIMIT = 500;

  /** KS-3734 / ADR §6. Жёсткий лимит зрителей на трансляцию. */
  static readonly VIEWERS_HARD_CAP = 1000;

  /** KS-3734 / ADR §2.9.15. Token-bucket автора: 30 ходов/мин с burst 10. */
  private readonly authorMoveLimiter = new TokenBucketLimiter(10, 0.5);

  /**
   * KS-3743 / ADR-111 §2.4. Отдельный token-bucket на state-patch:
   * 5 в секунду с пиковым 10. Отдельный от move-лимита — дебаунс
   * фронта (500 мс) уже отсеивает основную часть, бакет — защита от
   * багов клиента (например, патч на каждый keystroke в комментарии).
   */
  private readonly authorStatePatchLimiter = new TokenBucketLimiter(10, 5);

  /**
   * KS-3743 / ADR-111 §2.3. Hard cap длины annotated PGN в state-patch
   * и в reset (256 KB = 262 144 байт). При превышении сервер кидает
   * `BadRequestException('pgn-too-large')` — gateway мапит в
   * `error { code: 'pgn-too-large' }`.
   */
  static readonly STATE_PATCH_PGN_HARD_CAP_BYTES = 256 * 1024;

  private readonly nanoid = customAlphabet(
    LiveAnalysisService.SLUG_ALPHABET,
    LiveAnalysisService.SLUG_LENGTH,
  );

  /** chain-promise per-slug — гарантирует последовательную обработку
   *  ходов от одного автора (ADR §2.9.1). */
  private readonly slugQueues = new Map<string, Promise<unknown>>();

  /** Кеш последних UPDATE `lastActivityAt` per-slug (мс UNIX-time). */
  private readonly lastActivityCache = new Map<string, number>();

  /** Мапа slug → ownerId для быстрой проверки авторства в gateway без
   *  PG-запроса на каждый эмит (ADR §2.6). TTL не нужен — запись
   *  живёт ровно пока трансляция active. */
  private readonly slugToOwnerCache = new Map<string, string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly metrics: MetricsService,
  ) {}

  // ─── REST: CRUD ─────────────────────────────────────────────────────

  /**
   * Создать трансляцию. Slug — nanoid(10) URL-safe; коллизия на
   * UNIQUE-индексе → retry до `SLUG_GEN_MAX_ATTEMPTS` раз.
   *
   * `startingFen` — валидируется через `chess.js`, невалидный → 400.
   * State в Redis заводится сразу, чтобы первый зритель на subscribe
   * получил консистентный snapshot.
   *
   * KS-3759 / ADR-112 §3, §2.8.
   *
   * Расширения:
   *   1. `analysisId` обязателен. Перед INSERT проверяем существование
   *      и принадлежность `Analysis`:
   *         - 404 если запись не найдена;
   *         - 403 если `Analysis.userId !== ownerId`.
   *   2. Идемпотентность. До INSERT ищем уже существующую active по
   *      `(ownerId, analysisId)` — если есть, возвращаем её Response
   *      без создания новой. Так повторный `POST /live-analyses`
   *      из той же вкладки/после перезагрузки даёт тот же slug.
   *   3. Гонка на параллельный INSERT (две вкладки одновременно).
   *      Partial UNIQUE индекс `live_analysis_owner_analysis_active_unique`
   *      (KS-3757) даёт Prisma P2002 на проигравшем потоке. Ловим и
   *      возвращаем существующую запись вместо 500.
   */
  async create(
    ownerId: string,
    dto: CreateLiveAnalysisDto,
    publicBaseUrl: string,
  ): Promise<LiveAnalysisResponse> {
    const startingFen = this.normalizeStartingFen(dto.startingFen);
    const orientation: LiveAnalysisOrientation = dto.orientation ?? 'white';

    // (1) проверка владельца анализа.
    const analysis = await this.prisma.analysis.findUnique({
      where: { id: dto.analysisId },
      select: { id: true, userId: true },
    });
    if (!analysis) {
      throw new NotFoundException(`Analysis "${dto.analysisId}" not found`);
    }
    if (analysis.userId !== ownerId) {
      throw new ForbiddenException(
        'Only the owner of the analysis can broadcast it',
      );
    }

    // (2) идемпотентность: если уже есть active с тем же binding —
    // возвращаем её сразу.
    const existing = await this.findActiveByAnalysisId(
      ownerId,
      dto.analysisId,
      publicBaseUrl,
    );
    if (existing) {
      this.logger.log(
        `Live analysis idempotent return: slug=${existing.slug} owner=${ownerId} analysisId=${dto.analysisId}`,
      );
      return existing;
    }

    // (3) INSERT с обработкой race по partial UNIQUE.
    let id: string;
    try {
      id = await this.tryInsertWithUniqueSlug(
        ownerId,
        dto.title ?? null,
        startingFen,
        dto.analysisId,
      );
    } catch (e) {
      // tryInsertWithUniqueSlug различает коллизии по slug (retry'ит
      // их сам) и пробрасывает P2002 только если это partial UNIQUE
      // на (owner_id, analysis_id). Это значит — concurrent INSERT
      // успел раньше; возвращаем то, что он создал.
      if (this.isUniqueViolation(e)) {
        const concurrent = await this.findActiveByAnalysisId(
          ownerId,
          dto.analysisId,
          publicBaseUrl,
        );
        if (concurrent) {
          this.logger.warn(
            `Live analysis concurrent create: returning existing slug=${concurrent.slug} owner=${ownerId} analysisId=${dto.analysisId}`,
          );
          return concurrent;
        }
      }
      throw e;
    }

    const created = await this.prisma.liveAnalysis.findUniqueOrThrow({
      where: { id },
      include: { owner: { select: { username: true } } },
    });

    await this.initRedisState(id, startingFen, orientation);
    this.slugToOwnerCache.set(created.slug, ownerId);
    this.metrics.incLiveAnalysisActive();

    this.logger.log(
      `Live analysis created: slug=${created.slug} owner=${ownerId} analysisId=${dto.analysisId}`,
    );

    return this.toResponse(created, publicBaseUrl, {
      currentFen: startingFen,
      currentPly: 0,
      orientation,
      viewerCount: 0,
    });
  }

  /**
   * KS-3759 / ADR-112 §3. Поиск активной трансляции по `(ownerId,
   * analysisId)`. Возвращает полностью сформированный `LiveAnalysisResponse`
   * (с актуальным `currentFen`/`viewerCount`/`currentPgn` из Redis)
   * или `null`, если такой нет.
   *
   * Используется в:
   *   - `create()` для идемпотентности и обработки race;
   *   - фронте через REST-эндпоинт (отдельная задача), чтобы автор
   *     перед нажатием «Транслировать» мог узнать, идёт ли уже
   *     трансляция на этот анализ.
   */
  async findActiveByAnalysisId(
    ownerId: string,
    analysisId: string,
    publicBaseUrl: string,
  ): Promise<LiveAnalysisResponse | null> {
    const row = await this.prisma.liveAnalysis.findFirst({
      where: { ownerId, analysisId, status: 'active' },
      include: { owner: { select: { username: true } } },
    });
    if (!row) return null;

    const state = await this.readRedisState(row.id);
    const viewerCount = await this.readViewerCount(row.id);
    return this.toResponse(row, publicBaseUrl, {
      currentFen:
        state?.currentFen ??
        row.startingFen ??
        LiveAnalysisService.INITIAL_FEN,
      currentPly: state?.currentPly ?? 0,
      orientation: state?.orientation ?? 'white',
      viewerCount,
      currentPgn: state?.currentPgn,
      headers: state?.headers,
    });
  }

  /**
   * Snapshot по slug — публичный endpoint. Если трансляция уже closed,
   * фронту нужен read-only финальный state, так что отдаём 404 ровно
   * когда slug неизвестен; для closed возвращаем последнее состояние
   * из БД (currentFen берётся из Redis если ключ ещё жив, иначе
   * startingFen — ходы протухли вместе с TTL).
   */
  async getBySlug(
    slug: string,
    publicBaseUrl: string,
  ): Promise<LiveAnalysisResponse> {
    const found = await this.prisma.liveAnalysis.findUnique({
      where: { slug },
      include: { owner: { select: { username: true } } },
    });
    if (!found) {
      throw new NotFoundException(`Live analysis "${slug}" not found`);
    }

    const state = await this.readRedisState(found.id);
    const viewerCount = await this.readViewerCount(found.id);

    return this.toResponse(found, publicBaseUrl, {
      currentFen: state?.currentFen ?? found.startingFen ?? LiveAnalysisService.INITIAL_FEN,
      currentPly: state?.currentPly ?? 0,
      orientation: state?.orientation ?? 'white',
      viewerCount,
      // KS-3743 / ADR-111: для зрителя, который опрашивает snapshot
      // REST'ом до WS-subscribe, отдаём текущий PGN и headers если
      // автор уже присылал state-patch.
      currentPgn: state?.currentPgn,
      headers: state?.headers,
    });
  }

  /**
   * Список трансляций пользователя — для секции «мои live» в профиле.
   * Сортировка: сначала active (свежие сверху), затем closed
   * (свежие сверху). Лимит 50 — без пагинации MVP.
   */
  async listForOwner(ownerId: string): Promise<LiveAnalysisListItem[]> {
    const rows = await this.prisma.liveAnalysis.findMany({
      where: { ownerId },
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      take: 50,
    });
    return rows.map((row) => ({
      id: row.id,
      slug: row.slug,
      title: row.title,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
      closedAt: row.closedAt ? row.closedAt.toISOString() : null,
      viewerPeak: row.viewerPeak,
      // KS-3758 / ADR-112: binding к Analysis (`null` для исторических
      // записей ADR-110). Бизнес-логика binding и валидация владельца
      // анализа подключаются в KS-3759.
      analysisId: row.analysisId,
    }));
  }

  /**
   * Закрытие трансляции автором (через REST DELETE или WS `close`).
   * Идемпотентно: повторный close уже-closed возвращает текущее
   * состояние без ошибки — это упрощает UX «случайно дёрнули кнопку
   * дважды».
   */
  async closeBySlug(
    slug: string,
    actingUserId: string,
    reason: 'by_owner' | 'inactivity' = 'by_owner',
  ): Promise<{ id: string; alreadyClosed: boolean }> {
    const found = await this.prisma.liveAnalysis.findUnique({
      where: { slug },
      select: { id: true, ownerId: true, status: true },
    });
    if (!found) {
      throw new NotFoundException(`Live analysis "${slug}" not found`);
    }
    if (found.ownerId !== actingUserId) {
      throw new ForbiddenException('Only the owner can close this live analysis');
    }
    if (found.status === 'closed') {
      return { id: found.id, alreadyClosed: true };
    }

    await this.prisma.liveAnalysis.update({
      where: { id: found.id },
      data: { status: 'closed', closedAt: new Date() },
    });
    this.slugToOwnerCache.delete(slug);
    this.lastActivityCache.delete(slug);
    this.authorMoveLimiter.reset(slug);
    this.authorStatePatchLimiter.reset(slug);
    this.metrics.decLiveAnalysisActive();
    await this.purgeRedisState(found.id);

    await this.publish(LiveAnalysisService.CHANNEL_CLOSED, { slug, reason });

    this.logger.log(`Live analysis closed: slug=${slug} reason=${reason}`);
    return { id: found.id, alreadyClosed: false };
  }

  // ─── KS-3733: cleanup-job ──────────────────────────────────────────

  /**
   * Запускается из `LiveAnalysisCleanupScheduler` (cron 5 мин).
   *
   * Redis-lock `cleanup:live-analysis:lock` через `SET NX EX` — только
   * один инстанс api за тик пройдёт ниже, остальные no-op.
   * Возвращает счётчик закрытых трансляций для логов/метрик.
   *
   * Закрывает: `status='active' AND lastActivityAt < NOW() - 30 min`.
   * Для каждой кандидатуры — UPDATE в PG, чистка Redis-ключей,
   * publish `live-analysis:closed { reason: 'inactivity' }`.
   */
  async runCleanupTick(now: Date = new Date()): Promise<{
    locked: boolean;
    scanned: number;
    closed: number;
  }> {
    const lockOwner = `${process.pid}-${Date.now()}`;
    // SET key value NX EX ttl — атомарный acquire.
    const acquired = await this.redis.set(
      LiveAnalysisService.CLEANUP_LOCK_KEY,
      lockOwner,
      'EX',
      LiveAnalysisService.CLEANUP_LOCK_TTL_SEC,
      'NX',
    );
    if (acquired !== 'OK') {
      return { locked: false, scanned: 0, closed: 0 };
    }

    let scanned = 0;
    let closed = 0;
    try {
      const cutoff = new Date(now.getTime() - LiveAnalysisService.INACTIVITY_THRESHOLD_MS);
      const candidates = await this.prisma.liveAnalysis.findMany({
        where: { status: 'active', lastActivityAt: { lt: cutoff } },
        select: { id: true, slug: true },
        take: LiveAnalysisService.CLEANUP_BATCH_LIMIT,
      });
      scanned = candidates.length;

      for (const row of candidates) {
        try {
          await this.prisma.liveAnalysis.update({
            where: { id: row.id },
            data: { status: 'closed', closedAt: now },
          });
          this.slugToOwnerCache.delete(row.slug);
          this.lastActivityCache.delete(row.slug);
          this.authorMoveLimiter.reset(row.slug);
          this.authorStatePatchLimiter.reset(row.slug);
          await this.purgeRedisState(row.id);
          await this.publish(LiveAnalysisService.CHANNEL_CLOSED, {
            slug: row.slug,
            reason: 'inactivity',
          });
          this.metrics.decLiveAnalysisActive();
          this.metrics.incLiveAnalysisCleanupClosed();
          closed += 1;
          this.logger.log(
            `cleanup closed slug=${row.slug} (inactive > ${LiveAnalysisService.INACTIVITY_THRESHOLD_MS}ms)`,
          );
        } catch (e) {
          this.logger.warn(
            `cleanup failed for slug=${row.slug}: ${(e as Error).message}`,
          );
        }
      }
    } finally {
      // Lock-release «if owner» — Lua-скрипт чтобы не снести чужой
      // lock, который мог встать после нашего TTL. Не используем — TTL
      // 4 мин < интервал 5 мин, естественное истечение покрывает.
      // Просто DEL под нашим owner-стампом, защитив от уже-истёкшего:
      try {
        const current = await this.redis.get(LiveAnalysisService.CLEANUP_LOCK_KEY);
        if (current === lockOwner) {
          await this.redis.del(LiveAnalysisService.CLEANUP_LOCK_KEY);
        }
      } catch (e) {
        this.logger.warn(
          `cleanup lock release failed: ${(e as Error).message}`,
        );
      }
    }
    return { locked: true, scanned, closed };
  }

  /**
   * Пересчитать gauge `live_analysis_active_total` из PG. Вызывается
   * из cleanup-scheduler'а раз в тик — это дёшево (один COUNT) и
   * страхует от расхождений при рестартах процесса (in-memory счётчик
   * на старте равен 0, реальное число active в PG — другое).
   */
  async resyncActiveGauge(): Promise<number> {
    const n = await this.prisma.liveAnalysis.count({ where: { status: 'active' } });
    this.metrics.setLiveAnalysisActive(n);
    return n;
  }

  // ─── WS handlers (вызываются из gateway) ───────────────────────────

  /**
   * Snapshot для `subscribe`/`sync`-запроса. Если slug неизвестен или
   * уже closed — кидаем NotFound (gateway трансформирует в error-event).
   */
  async getSyncSnapshot(slug: string): Promise<LiveAnalysisSyncSnapshot> {
    const row = await this.prisma.liveAnalysis.findUnique({
      where: { slug },
      select: { id: true, status: true, startingFen: true },
    });
    if (!row || row.status === 'closed') {
      throw new NotFoundException(`Live analysis "${slug}" not available`);
    }
    const state = await this.readRedisState(row.id);
    const moves = await this.redis.lrange(this.movesKey(row.id), 0, -1);
    return {
      slug,
      startingFen: state?.startingFen ?? row.startingFen ?? LiveAnalysisService.INITIAL_FEN,
      moves,
      currentFen: state?.currentFen ?? row.startingFen ?? LiveAnalysisService.INITIAL_FEN,
      currentPly: state?.currentPly ?? moves.length,
      orientation: state?.orientation ?? 'white',
      // KS-3743 / ADR-111: annotated PGN автора и headers — опциональны
      // (на трансляции, где автор ещё не присылал state-patch, их нет).
      ...(state?.currentPgn !== undefined && { currentPgn: state.currentPgn }),
      ...(state?.headers !== undefined && { headers: state.headers }),
    };
  }

  /**
   * Применить ход автора. Сериализовано per-slug через `runExclusive`
   * (ADR §2.9.1). Возвращает payload, который gateway транслирует через
   * pub/sub (а тот — комнате `live-analysis:<id>`).
   *
   * Ошибки:
   *   - 404 — slug неизвестен или closed.
   *   - 403 — userId не совпадает с ownerId.
   *   - 400 — UCI невалиден или нелегален в текущем FEN.
   */
  async applyMove(
    slug: string,
    actingUserId: string,
    uci: string,
  ): Promise<LiveAnalysisMoveEvent> {
    return this.runExclusive(slug, async () => {
      const meta = await this.assertOwnerAndActive(slug, actingUserId);
      // KS-3734 / ADR §2.9.15: rate-limit автора (token-bucket 30/мин, burst 10).
      if (!this.authorMoveLimiter.tryConsume(slug)) {
        this.metrics.incLiveAnalysisRateLimited('author_moves');
        this.logger.warn(
          `rate-limit drop move slug=${slug} owner=${actingUserId}`,
        );
        throw new BadRequestException('Rate limit exceeded (author moves)');
      }
      const state = await this.readRedisState(meta.id);
      const currentFen =
        state?.currentFen ?? meta.startingFen ?? LiveAnalysisService.INITIAL_FEN;
      const currentPly = state?.currentPly ?? 0;

      const chess = new Chess(currentFen);
      const move = this.tryUciMove(chess, uci);
      if (!move) {
        this.metrics.incLiveAnalysisMoveIllegal();
        throw new BadRequestException(`Illegal UCI move "${uci}"`);
      }
      const newFen = chess.fen();
      const newPly = currentPly + 1;

      const stateKey = this.stateKey(meta.id);
      const movesKey = this.movesKey(meta.id);
      await this.redis
        .multi()
        .hset(stateKey, {
          startingFen: state?.startingFen ?? meta.startingFen ?? LiveAnalysisService.INITIAL_FEN,
          currentFen: newFen,
          currentPly: String(newPly),
          orientation: state?.orientation ?? 'white',
        })
        .rpush(movesKey, uci)
        .expire(stateKey, LiveAnalysisService.STATE_TTL_SEC)
        .expire(movesKey, LiveAnalysisService.STATE_TTL_SEC)
        .exec();

      await this.touchLastActivity(slug, meta.id);

      const payload: LiveAnalysisMoveEvent = {
        slug,
        uci,
        fen: newFen,
        ply: newPly,
      };
      this.metrics.incLiveAnalysisMoveAccepted();
      await this.publish(LiveAnalysisService.CHANNEL_MOVE, payload);
      return payload;
    });
  }

  /**
   * KS-3743 / ADR-111 §2.2, §2.3. Применить state-patch от автора —
   * содержимое окна анализа (annotated PGN, headers, currentPly,
   * orientation).
   *
   * Шаги (внутри `runExclusive` — тот же mutex per-slug, что и `move`,
   * для борьбы с race из ADR-111 §2.8 п.4):
   *   1. assertOwnerAndActive.
   *   2. Hard cap длины PGN ≤ `STATE_PATCH_PGN_HARD_CAP_BYTES`
   *      (256 KB). Превышение → `BadRequestException('pgn-too-large')`.
   *   3. Rate-limit per-slug через `authorStatePatchLimiter`
   *      (5/сек, burst 10). Перебор → `BadRequestException('Rate
   *      limit exceeded (state-patch)')`.
   *   4. Валидация PGN: `chess.loadPgn(pgn)`. Невалидный → `BadRequest
   *      ('Invalid PGN')`.
   *   5. Извлечение `startingFen` (из заголовков SetUp/FEN или
   *      `chess.fen()` если PGN пустой) и main-line UCI-истории
   *      (`chess.history({verbose:true})` → `from+to+promotion`).
   *   6. `currentPly`: использовать переданный (если 0..uci.length),
   *      иначе длина истории. Это даёт автору возможность листать
   *      назад без совершения новых ходов.
   *   7. `currentFen` — пересобираем заново из `startingFen` +
   *      первых `currentPly` UCI (это надёжнее, чем верить переданному).
   *   8. HSET state hash: startingFen, currentFen, currentPly,
   *      orientation, currentPgn, headersJson, lastPatchAt.
   *      DEL :moves; RPUSH :moves все UCI main-line — **критично**
   *      для acceptance KS-3743: «при reconnect зрителя moves-list
   *      совпадает с main-line PGN». ADR-111 §2.7 (3).
   *   9. throttled `touchLastActivity`.
   *  10. `publish` в `live-analysis:sync` полный snapshot — gateway
   *      разошлёт в комнату; отдельного канала state-patch ADR §2.3
   *      не вводит.
   */
  async applyStatePatch(
    slug: string,
    actingUserId: string,
    payload: Omit<LiveAnalysisStatePatchPayload, 'slug'>,
  ): Promise<LiveAnalysisSyncSnapshot> {
    return this.runExclusive(slug, async () => {
      // (1) проверка владельца и статуса. ForbiddenException → метрика
      // reason='forbidden'. NotFoundException (slug нет / closed) к
      // 4 кодам не относится — не учитываем в state-patch метриках.
      let meta;
      try {
        meta = await this.assertOwnerAndActive(slug, actingUserId);
      } catch (e) {
        if (e instanceof ForbiddenException) {
          this.metrics.incLiveAnalysisStatePatchRejected('forbidden');
        }
        throw e;
      }

      // (2) жёсткий лимит длины PGN. JS string.length — UTF-16 code
      // units, что для ASCII-PGN совпадает с байтами; для кириллических
      // комментариев расход вдвое, но на верхнюю границу абуза 256 KB
      // строки в любом случае хватает с запасом.
      if (
        payload.pgn.length > LiveAnalysisService.STATE_PATCH_PGN_HARD_CAP_BYTES
      ) {
        this.metrics.incLiveAnalysisStatePatchRejected('pgn_too_large');
        this.logger.warn(
          `state-patch rejected (pgn too large) slug=${slug} bytes=${payload.pgn.length}`,
        );
        throw new BadRequestException('pgn-too-large');
      }

      // (3) ограничение частоты. Отдельный bucket от move — у них
      // разные пороги темпа.
      if (!this.authorStatePatchLimiter.tryConsume(slug)) {
        this.metrics.incLiveAnalysisStatePatchRejected('rate_limit');
        this.logger.warn(
          `rate-limit drop state-patch slug=${slug} owner=${actingUserId}`,
        );
        throw new BadRequestException('Rate limit exceeded (state-patch)');
      }

      // (4) валидация PGN.
      const chess = new Chess();
      try {
        chess.loadPgn(payload.pgn);
      } catch (e) {
        this.metrics.incLiveAnalysisStatePatchRejected('invalid_pgn');
        this.logger.warn(
          `state-patch invalid PGN slug=${slug}: ${(e as Error).message}`,
        );
        throw new BadRequestException('Invalid PGN');
      }

      // (5) main-line UCI и стартовый FEN из PGN-headers SetUp/FEN.
      const verbose = chess.history({ verbose: true }) as Array<{
        from: string;
        to: string;
        promotion?: string;
        before?: string;
      }>;
      const headersFromPgn = this.extractPgnHeaders(chess);
      const startingFen =
        verbose[0]?.before ??
        // Если ходов нет — chess.fen() это и есть стартовая позиция
        // (либо initial, либо то, что было задано через [SetUp/FEN]).
        chess.fen();
      const uciHistory = verbose.map(
        (m) => `${m.from}${m.to}${m.promotion ?? ''}`,
      );

      // (6) currentPly: переданный приоритетнее, но обязан быть в [0..N].
      let currentPly = uciHistory.length;
      if (
        typeof payload.currentPly === 'number' &&
        Number.isInteger(payload.currentPly) &&
        payload.currentPly >= 0 &&
        payload.currentPly <= uciHistory.length
      ) {
        currentPly = payload.currentPly;
      }

      // (7) currentFen — пересобираем заново независимо от переданного.
      const replay = new Chess(startingFen);
      for (let i = 0; i < currentPly; i++) {
        const uci = uciHistory[i];
        const from = uci.slice(0, 2);
        const to = uci.slice(2, 4);
        const promotion = uci.length === 5 ? uci.slice(4, 5) : undefined;
        replay.move({ from, to, promotion });
      }
      const currentFen = replay.fen();

      const orientation: LiveAnalysisOrientation =
        payload.orientation ??
        (await this.readRedisState(meta.id))?.orientation ??
        'white';

      // headers: предпочитаем явные из payload, иначе извлечённые из PGN.
      const headers = payload.headers ?? headersFromPgn;
      const headersJson =
        headers && Object.keys(headers).length > 0
          ? JSON.stringify(headers)
          : '';

      // (8) HSET state + замена moves-list по main-line.
      const stateKey = this.stateKey(meta.id);
      const movesKey = this.movesKey(meta.id);
      const pipeline = this.redis
        .multi()
        .hset(stateKey, {
          startingFen,
          currentFen,
          currentPly: String(currentPly),
          orientation,
          currentPgn: payload.pgn,
          headersJson,
          lastPatchAt: String(Date.now()),
        })
        .del(movesKey);
      // RPUSH с многими аргументами — ioredis принимает variadic;
      // если main-line пустая (свежий PGN c одной headers-секцией) —
      // RPUSH не зовём, иначе попадёт пустая команда.
      if (uciHistory.length > 0) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (pipeline as any).rpush(movesKey, ...uciHistory);
      }
      pipeline
        .expire(stateKey, LiveAnalysisService.STATE_TTL_SEC)
        .expire(movesKey, LiveAnalysisService.STATE_TTL_SEC);
      await pipeline.exec();

      // (9) throttled lastActivityAt.
      await this.touchLastActivity(slug, meta.id);

      // (10) publish full sync — gateway разошлёт в комнату.
      const snapshot: LiveAnalysisSyncSnapshot = {
        slug,
        startingFen,
        moves: uciHistory,
        currentFen,
        currentPly,
        orientation,
        currentPgn: payload.pgn,
        ...(Object.keys(headers ?? {}).length > 0 && { headers }),
      };
      // KS-3745: counter принятых патчей + bytes_sum по длине payload.
      this.metrics.incLiveAnalysisStatePatchAccepted(payload.pgn.length);
      await this.publish(LiveAnalysisService.CHANNEL_SYNC, snapshot);
      return snapshot;
    });
  }

  /**
   * Извлечь PGN-headers через `chess.header()`. Возвращает копию
   * объекта (мутации не утекут в chess instance).
   */
  private extractPgnHeaders(chess: Chess): Record<string, string> {
    // chess.js 1.4 .header() — `getHeaders` без аргументов.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = (chess as any).getHeaders?.() ?? (chess as any).header?.();
    if (!raw || typeof raw !== 'object') return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === 'string' && v.length > 0) out[k] = v;
    }
    return out;
  }

  /**
   * Полный reset позиции (автор переключился на разбор другой партии).
   * Очищает Redis-историю, перезаписывает state, эмитит свежий sync.
   */
  async applyReset(
    slug: string,
    actingUserId: string,
    fen?: string,
  ): Promise<LiveAnalysisSyncSnapshot> {
    return this.runExclusive(slug, async () => {
      const meta = await this.assertOwnerAndActive(slug, actingUserId);
      const newStartingFen = this.normalizeStartingFen(fen);
      const currentFen = newStartingFen;
      const orientation: LiveAnalysisOrientation =
        (await this.readRedisState(meta.id))?.orientation ?? 'white';

      const stateKey = this.stateKey(meta.id);
      const movesKey = this.movesKey(meta.id);
      await this.redis
        .multi()
        .del(movesKey)
        .hset(stateKey, {
          startingFen: newStartingFen,
          currentFen,
          currentPly: '0',
          orientation,
        })
        .expire(stateKey, LiveAnalysisService.STATE_TTL_SEC)
        .exec();

      await this.touchLastActivity(slug, meta.id, /*force*/ true);

      const snapshot: LiveAnalysisSyncSnapshot = {
        slug,
        startingFen: newStartingFen,
        moves: [],
        currentFen,
        currentPly: 0,
        orientation,
      };
      await this.publish(LiveAnalysisService.CHANNEL_SYNC, snapshot);
      return snapshot;
    });
  }

  /**
   * Попытаться занять место зрителя. Атомарный INCR, и если значение
   * превысило `VIEWERS_HARD_CAP` (ADR §2.9.6 / §6) — откатываем DECR
   * и возвращаем `null`. Gateway трактует `null` как «лимит исчерпан»
   * и шлёт зрителю `error { code: 'rate-limit' }`.
   *
   * Используется gateway-handler'ом `subscribe`. Лимит на трансляцию
   * считается в Redis (multi-instance безопасно): два инстанса не
   * перешагнут capacity, потому что `INCR` атомарен.
   */
  async tryAcquireViewerSlot(slug: string): Promise<number | null> {
    const id = await this.resolveSlugToId(slug);
    if (!id) return null;
    const key = this.viewersKey(id);
    const count = await this.redis.incr(key);
    await this.redis.expire(key, LiveAnalysisService.STATE_TTL_SEC);
    if (count > LiveAnalysisService.VIEWERS_HARD_CAP) {
      // Откатываем INCR, не пускаем зрителя.
      await this.redis.decr(key);
      this.metrics.incLiveAnalysisRateLimited('viewers_cap');
      return null;
    }
    if (count > 0) {
      // viewerPeak обновляем только при росте сверх текущего пика.
      // CAS-style UPDATE через WHERE viewer_peak < count — дёшево и
      // не нуждается в локе.
      await this.prisma.liveAnalysis.updateMany({
        where: { id, viewerPeak: { lt: count } },
        data: { viewerPeak: count },
      });
    }
    this.metrics.incLiveAnalysisViewers();
    return count;
  }

  /** @deprecated KS-3734: используйте `tryAcquireViewerSlot`. Оставлен
   *  для обратной совместимости тестов KS-3732. */
  async incrementViewer(slug: string): Promise<number> {
    const n = await this.tryAcquireViewerSlot(slug);
    return n ?? 0;
  }

  async decrementViewer(slug: string): Promise<number> {
    const id = await this.resolveSlugToId(slug);
    if (!id) return 0;
    const key = this.viewersKey(id);
    const count = await this.redis.decr(key);
    this.metrics.decLiveAnalysisViewers();
    // Защита от ухода в минус — gateway мог двойной disconnect получить.
    if (count < 0) {
      await this.redis.set(key, '0', 'EX', LiveAnalysisService.STATE_TTL_SEC);
      return 0;
    }
    return count;
  }

  // ─── KS-3734: лимит подключений с IP ───────────────────────────────

  /** Максимум одновременных WS-подключений с одного IP. ADR §6. */
  static readonly IP_CONNS_HARD_CAP = 10;

  private ipConnsKey(ip: string): string {
    return `live-analysis:ip:${ip}:conns`;
  }

  /**
   * Попытаться занять слот WS-подключения для IP. Возвращает `true`,
   * если можно подключиться; `false` — превышен лимит (gateway тогда
   * сразу `disconnect`). Атомарный INCR, при превышении — откат DECR.
   */
  async tryAcquireIpSlot(ip: string): Promise<boolean> {
    const key = this.ipConnsKey(ip);
    const count = await this.redis.incr(key);
    // TTL — час: на случай если процесс упадёт между INCR и release-ом
    // в handleDisconnect, счётчик не повиснет навсегда.
    await this.redis.expire(key, 3600);
    if (count > LiveAnalysisService.IP_CONNS_HARD_CAP) {
      await this.redis.decr(key);
      this.metrics.incLiveAnalysisRateLimited('ip_conns');
      this.logger.warn(`rate-limit drop WS connection ip=${ip} (cap exceeded)`);
      return false;
    }
    return true;
  }

  /** Освободить слот подключения для IP (handleDisconnect). */
  async releaseIpSlot(ip: string): Promise<void> {
    const key = this.ipConnsKey(ip);
    const n = await this.redis.decr(key);
    if (n < 0) {
      await this.redis.set(key, '0', 'EX', 3600);
    }
  }

  // ─── Owner / slug-resolution ───────────────────────────────────────

  /**
   * Проверить, что `userId` — owner у указанного slug. Кеш на 30с
   * избыточен для in-memory Map, но мы держим запись пока трансляция
   * active (см. `slugToOwnerCache`). Если cache miss — поднимаем из PG.
   */
  async isOwner(slug: string, userId: string): Promise<boolean> {
    const cached = this.slugToOwnerCache.get(slug);
    if (cached) return cached === userId;
    const row = await this.prisma.liveAnalysis.findUnique({
      where: { slug },
      select: { ownerId: true, status: true },
    });
    if (!row || row.status === 'closed') return false;
    this.slugToOwnerCache.set(slug, row.ownerId);
    return row.ownerId === userId;
  }

  /** Резолв slug → id с in-memory cache (только active). */
  async resolveSlugToId(slug: string): Promise<string | null> {
    const row = await this.prisma.liveAnalysis.findUnique({
      where: { slug },
      select: { id: true, status: true },
    });
    if (!row || row.status === 'closed') return null;
    return row.id;
  }

  // ─── Internals ─────────────────────────────────────────────────────

  /**
   * Сериализованная обработка операций per-slug. chain-promise — самый
   * лёгкий примитив для NodeJS event-loop'а, без внешних библиотек.
   */
  private async runExclusive<T>(slug: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.slugQueues.get(slug) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    // Сохраняем promise в Map так, чтобы очистить запись, когда цепочка
    // полностью закроется. Без чистки Map монотонно растёт.
    this.slugQueues.set(slug, next);
    next.catch(() => {}).finally(() => {
      if (this.slugQueues.get(slug) === next) {
        this.slugQueues.delete(slug);
      }
    });
    return next;
  }

  /**
   * INSERT с retry на коллизию UNIQUE(slug). Возвращает id.
   *
   * KS-3759 / ADR-112: добавлен `analysisId` (обязательный binding).
   * P2002 различается по `meta.target`/`meta.indexName`:
   *   - совпадение `slug` — статистически невозможная коллизия, retry
   *     до `SLUG_GEN_MAX_ATTEMPTS`;
   *   - совпадение partial UNIQUE `live_analysis_owner_analysis_active_unique`
   *     — concurrent INSERT от другой вкладки/инстанса; пробрасываем
   *     наверх, чтобы `create()` подменил на existing.
   */
  private async tryInsertWithUniqueSlug(
    ownerId: string,
    title: string | null,
    startingFen: string,
    analysisId: string,
  ): Promise<string> {
    for (let attempt = 0; attempt < LiveAnalysisService.SLUG_GEN_MAX_ATTEMPTS; attempt++) {
      const slug = this.nanoid();
      try {
        const created = await this.prisma.liveAnalysis.create({
          data: {
            ownerId,
            slug,
            title,
            // null → стандартная позиция, чтобы не дублировать константу
            // в БД когда автор не задавал явный FEN.
            startingFen: startingFen === LiveAnalysisService.INITIAL_FEN ? null : startingFen,
            status: 'active',
            analysisId,
          },
          select: { id: true },
        });
        return created.id;
      } catch (e) {
        if (this.isSlugUniqueViolation(e)) {
          if (attempt < LiveAnalysisService.SLUG_GEN_MAX_ATTEMPTS - 1) {
            this.logger.warn(`Slug collision on attempt ${attempt + 1}: ${slug}`);
            continue;
          }
          throw new BadRequestException('Failed to generate unique slug');
        }
        // Partial UNIQUE (analysis-binding) или другая ошибка —
        // пробрасываем; `create()` решит, нужно ли подменять existing.
        throw e;
      }
    }
    throw new BadRequestException('Failed to generate unique slug');
  }

  private isUniqueViolation(e: unknown): boolean {
    return (
      typeof e === 'object' &&
      e !== null &&
      // PrismaClientKnownRequestError.code
      (e as { code?: string }).code === 'P2002'
    );
  }

  /**
   * KS-3759: специально для slug-коллизии. У Prisma в `meta.target`
   * (массив колонок) или `meta.indexName` приходит указатель на
   * нарушенный индекс. Slug-коллизия маркируется наличием `slug` в
   * target. Partial UNIQUE по `(owner_id, analysis_id)` сюда не
   * подпадёт — он различается по другим колонкам / по индекс-имени.
   */
  private isSlugUniqueViolation(e: unknown): boolean {
    if (!this.isUniqueViolation(e)) return false;
    const meta = (e as { meta?: { target?: unknown; indexName?: unknown } })
      .meta;
    if (!meta) return false;
    const target = meta.target;
    if (Array.isArray(target)) {
      return target.some(
        (t) => typeof t === 'string' && t.toLowerCase().includes('slug'),
      );
    }
    if (typeof target === 'string') {
      return target.toLowerCase().includes('slug');
    }
    if (typeof meta.indexName === 'string') {
      return meta.indexName.toLowerCase().includes('slug');
    }
    return false;
  }

  /** Безопасное применение UCI через chess.js. `null` если нелегально. */
  private tryUciMove(chess: Chess, uci: string): unknown | null {
    if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) return null;
    const from = uci.slice(0, 2);
    const to = uci.slice(2, 4);
    const promotion = uci.length === 5 ? uci.slice(4, 5) : undefined;
    try {
      return chess.move({ from, to, promotion });
    } catch {
      return null;
    }
  }

  /** Проверить slug на legal-FEN — иначе 400. Пустой → стандартная. */
  private normalizeStartingFen(fen: string | undefined | null): string {
    if (!fen) return LiveAnalysisService.INITIAL_FEN;
    try {
      // chess.js ctor бросает на невалидном FEN.
      const chess = new Chess(fen);
      return chess.fen();
    } catch {
      throw new BadRequestException('Invalid starting FEN');
    }
  }

  private async initRedisState(
    id: string,
    startingFen: string,
    orientation: LiveAnalysisOrientation,
  ): Promise<void> {
    const stateKey = this.stateKey(id);
    await this.redis
      .multi()
      .del(this.movesKey(id))
      .del(this.viewersKey(id))
      .hset(stateKey, {
        startingFen,
        currentFen: startingFen,
        currentPly: '0',
        orientation,
      })
      .expire(stateKey, LiveAnalysisService.STATE_TTL_SEC)
      .exec();
  }

  private async readRedisState(id: string): Promise<
    | {
        startingFen: string;
        currentFen: string;
        currentPly: number;
        orientation: LiveAnalysisOrientation;
        /** KS-3743 / ADR-111: annotated PGN последнего state-patch (опц.). */
        currentPgn?: string;
        /** KS-3743 / ADR-111: распарсенный JSON `headersJson` (опц.). */
        headers?: Record<string, string>;
      }
    | null
  > {
    const raw = await this.redis.hgetall(this.stateKey(id));
    if (!raw || !raw.currentFen) return null;
    let headers: Record<string, string> | undefined;
    if (raw.headersJson) {
      try {
        const parsed = JSON.parse(raw.headersJson);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          headers = parsed as Record<string, string>;
        }
      } catch {
        // Битый JSON в hash — игнорируем, фронт всё равно читает headers из PGN.
      }
    }
    return {
      startingFen: raw.startingFen ?? LiveAnalysisService.INITIAL_FEN,
      currentFen: raw.currentFen,
      currentPly: Number(raw.currentPly ?? '0') || 0,
      orientation: (raw.orientation as LiveAnalysisOrientation) ?? 'white',
      currentPgn: raw.currentPgn && raw.currentPgn.length > 0 ? raw.currentPgn : undefined,
      headers,
    };
  }

  private async readViewerCount(id: string): Promise<number> {
    const raw = await this.redis.get(this.viewersKey(id));
    const n = Number(raw ?? '0');
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  /**
   * Throttled UPDATE `lastActivityAt`. Гарантирует, что в PG не уйдёт
   * больше одного UPDATE per-slug в `LAST_ACTIVITY_THROTTLE_MS` (10s).
   * При `force=true` (reset/close) — UPDATE безусловный.
   */
  private async touchLastActivity(
    slug: string,
    id: string,
    force = false,
  ): Promise<void> {
    const now = Date.now();
    const last = this.lastActivityCache.get(slug) ?? 0;
    if (!force && now - last < LiveAnalysisService.LAST_ACTIVITY_THROTTLE_MS) {
      return;
    }
    this.lastActivityCache.set(slug, now);
    await this.prisma.liveAnalysis
      .update({
        where: { id },
        data: { lastActivityAt: new Date(now) },
      })
      .catch((e) => {
        // Не падаем по этой ошибке — UPDATE дросселирован и можно
        // догнать в следующий тик. Логируем для наблюдаемости.
        this.logger.warn(
          `lastActivityAt UPDATE failed for slug=${slug}: ${(e as Error).message}`,
        );
      });
  }

  private async assertOwnerAndActive(
    slug: string,
    actingUserId: string,
  ): Promise<{ id: string; ownerId: string; startingFen: string | null }> {
    const row = await this.prisma.liveAnalysis.findUnique({
      where: { slug },
      select: { id: true, ownerId: true, status: true, startingFen: true },
    });
    if (!row || row.status === 'closed') {
      throw new NotFoundException(`Live analysis "${slug}" not available`);
    }
    if (row.ownerId !== actingUserId) {
      throw new ForbiddenException('Only the owner can act on this live analysis');
    }
    this.slugToOwnerCache.set(slug, row.ownerId);
    return { id: row.id, ownerId: row.ownerId, startingFen: row.startingFen };
  }

  private async publish(channel: string, payload: unknown): Promise<void> {
    try {
      await this.redis.publish(channel, JSON.stringify(payload));
    } catch (e) {
      this.logger.warn(`publish ${channel} failed: ${(e as Error).message}`);
    }
  }

  private toResponse(
    row: {
      id: string;
      slug: string;
      ownerId: string;
      title: string | null;
      startingFen: string | null;
      status: 'active' | 'closed';
      createdAt: Date;
      closedAt: Date | null;
      owner: { username: string | null };
      // KS-3758 / ADR-112: nullable, заполняется бизнес-логикой
      // KS-3759 при `create` (после проверки `Analysis.userId === ownerId`).
      analysisId: string | null;
    },
    publicBaseUrl: string,
    extras: {
      currentFen: string;
      currentPly: number;
      orientation: LiveAnalysisOrientation;
      viewerCount: number;
      /** KS-3743 / ADR-111: опц., если автор уже присылал state-patch. */
      currentPgn?: string;
      headers?: Record<string, string>;
    },
  ): LiveAnalysisResponse {
    return {
      id: row.id,
      slug: row.slug,
      url: `${publicBaseUrl.replace(/\/$/, '')}/live/${row.slug}`,
      ownerId: row.ownerId,
      ownerUsername: row.owner.username,
      title: row.title,
      startingFen: row.startingFen,
      currentFen: extras.currentFen,
      currentPly: extras.currentPly,
      orientation: extras.orientation,
      status: row.status,
      viewerCount: extras.viewerCount,
      createdAt: row.createdAt.toISOString(),
      closedAt: row.closedAt ? row.closedAt.toISOString() : null,
      // KS-3758 / ADR-112: binding к Analysis.
      analysisId: row.analysisId,
      ...(extras.currentPgn !== undefined && { currentPgn: extras.currentPgn }),
      ...(extras.headers !== undefined && { headers: extras.headers }),
    };
  }

  // Redis key naming — `live_analysis:<id>:<suffix>`, см. ADR §2.1.
  private stateKey(id: string): string {
    return `live_analysis:${id}:state`;
  }
  private movesKey(id: string): string {
    return `live_analysis:${id}:moves`;
  }
  private viewersKey(id: string): string {
    return `live_analysis:${id}:viewers`;
  }

  /** KS-3733: очистить state/moves/viewers ключи трансляции. */
  private async purgeRedisState(id: string): Promise<void> {
    await this.redis
      .multi()
      .del(this.stateKey(id))
      .del(this.movesKey(id))
      .del(this.viewersKey(id))
      .exec();
  }
}
