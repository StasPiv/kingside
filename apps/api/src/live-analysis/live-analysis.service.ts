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
  type LiveAnalysisSyncSnapshot,
} from '@kingside/shared';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { CreateLiveAnalysisDto } from './dto/create-live-analysis.dto';

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
  ) {}

  // ─── REST: CRUD ─────────────────────────────────────────────────────

  /**
   * Создать трансляцию. Slug — nanoid(10) URL-safe; коллизия на
   * UNIQUE-индексе → retry до `SLUG_GEN_MAX_ATTEMPTS` раз.
   *
   * `startingFen` — валидируется через `chess.js`, невалидный → 400.
   * State в Redis заводится сразу, чтобы первый зритель на subscribe
   * получил консистентный snapshot.
   */
  async create(
    ownerId: string,
    dto: CreateLiveAnalysisDto,
    publicBaseUrl: string,
  ): Promise<LiveAnalysisResponse> {
    const startingFen = this.normalizeStartingFen(dto.startingFen);
    const orientation: LiveAnalysisOrientation = dto.orientation ?? 'white';

    const id = await this.tryInsertWithUniqueSlug(
      ownerId,
      dto.title ?? null,
      startingFen,
    );
    const created = await this.prisma.liveAnalysis.findUniqueOrThrow({
      where: { id },
      include: { owner: { select: { username: true } } },
    });

    await this.initRedisState(id, startingFen, orientation);
    this.slugToOwnerCache.set(created.slug, ownerId);

    this.logger.log(
      `Live analysis created: slug=${created.slug} owner=${ownerId}`,
    );

    return this.toResponse(created, publicBaseUrl, {
      currentFen: startingFen,
      currentPly: 0,
      orientation,
      viewerCount: 0,
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

    await this.publish(LiveAnalysisService.CHANNEL_CLOSED, { slug, reason });

    this.logger.log(`Live analysis closed: slug=${slug} reason=${reason}`);
    return { id: found.id, alreadyClosed: false };
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
      const state = await this.readRedisState(meta.id);
      const currentFen =
        state?.currentFen ?? meta.startingFen ?? LiveAnalysisService.INITIAL_FEN;
      const currentPly = state?.currentPly ?? 0;

      const chess = new Chess(currentFen);
      const move = this.tryUciMove(chess, uci);
      if (!move) {
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
      await this.publish(LiveAnalysisService.CHANNEL_MOVE, payload);
      return payload;
    });
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

  /** Viewer-счётчик: атомарный INCR + обновление viewerPeak в PG. */
  async incrementViewer(slug: string): Promise<number> {
    const id = await this.resolveSlugToId(slug);
    if (!id) return 0;
    const key = this.viewersKey(id);
    const count = await this.redis.incr(key);
    await this.redis.expire(key, LiveAnalysisService.STATE_TTL_SEC);
    if (count > 0) {
      // viewerPeak обновляем только при росте сверх текущего пика.
      // CAS-style UPDATE через WHERE viewer_peak < count — дёшево и
      // не нуждается в локе.
      await this.prisma.liveAnalysis.updateMany({
        where: { id, viewerPeak: { lt: count } },
        data: { viewerPeak: count },
      });
    }
    return count;
  }

  async decrementViewer(slug: string): Promise<number> {
    const id = await this.resolveSlugToId(slug);
    if (!id) return 0;
    const key = this.viewersKey(id);
    const count = await this.redis.decr(key);
    // Защита от ухода в минус — gateway мог двойной disconnect получить.
    if (count < 0) {
      await this.redis.set(key, '0', 'EX', LiveAnalysisService.STATE_TTL_SEC);
      return 0;
    }
    return count;
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

  /** INSERT с retry на коллизию UNIQUE(slug). Возвращает id. */
  private async tryInsertWithUniqueSlug(
    ownerId: string,
    title: string | null,
    startingFen: string,
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
          },
          select: { id: true },
        });
        return created.id;
      } catch (e) {
        // Prisma P2002 — unique constraint violation. По statistically
        // невозможной коллизии 10⁻¹⁴ retry'имся, остальные ошибки
        // пробрасываем.
        if (this.isUniqueViolation(e) && attempt < LiveAnalysisService.SLUG_GEN_MAX_ATTEMPTS - 1) {
          this.logger.warn(`Slug collision on attempt ${attempt + 1}: ${slug}`);
          continue;
        }
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
      }
    | null
  > {
    const raw = await this.redis.hgetall(this.stateKey(id));
    if (!raw || !raw.currentFen) return null;
    return {
      startingFen: raw.startingFen ?? LiveAnalysisService.INITIAL_FEN,
      currentFen: raw.currentFen,
      currentPly: Number(raw.currentPly ?? '0') || 0,
      orientation: (raw.orientation as LiveAnalysisOrientation) ?? 'white',
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
    },
    publicBaseUrl: string,
    extras: {
      currentFen: string;
      currentPly: number;
      orientation: LiveAnalysisOrientation;
      viewerCount: number;
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
}
