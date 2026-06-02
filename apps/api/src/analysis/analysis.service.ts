import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { CreateAnalysisDto } from './dto/create-analysis.dto';
import { DuplicateAnnotatedDto } from './dto/duplicate-annotated.dto';
import { UpdateAnalysisDto } from './dto/update-analysis.dto';

/**
 * KS-3263. Метаданные партии из источника (broadcast/archive) для
 * заполнения нового анализа без передачи PGN от фронта.
 */
interface ResolvedSourceGame {
  pgn: string;
  white?: string | null;
  black?: string | null;
  whiteElo?: number | null;
  blackElo?: number | null;
  result?: string | null;
}

@Injectable()
export class AnalysisService implements OnModuleInit {
  private readonly logger = new Logger(AnalysisService.name);

  constructor(private readonly prisma: PrismaService) {}

  // KS-3059: backfill — одноразовая миграция метаданных PGN для старых
  // записей. На каждом холодном старте перебирает stale записи (могут
  // быть 50-200 на проде → ~1-3с). Не критично для отклика api: записи
  // без метаданных штатно работают, findAll/findOne не зависят от
  // присутствия `headline/event/...`. Fire-and-forget — не блокирует
  // startup. При следующем рестарте оставшиеся stale записи догрузятся.
  onModuleInit(): void {
    setImmediate(() => {
      this.backfillMetadata().catch((err) => {
        this.logger.warn(
          `backfillMetadata async failed: ${(err as Error).message}`,
        );
      });
    });
  }

  /**
   * Backfill metadata fields for existing analyses that have PGN but no metadata.
   * Runs once at startup.
   */
  private async backfillMetadata(): Promise<void> {
    const stale = await this.prisma.analysis.findMany({
      where: {
        pgn: { not: null },
        white: null,
        event: null,
        headline: null,
      },
      select: { id: true, pgn: true },
    });

    if (stale.length === 0) return;

    this.logger.log(`Backfilling metadata for ${stale.length} analyses...`);

    for (const row of stale) {
      const meta = this.extractMetadata(row.pgn ?? undefined);
      const headline = this.buildHeadline(row.pgn ?? undefined);
      await this.prisma.analysis.update({
        where: { id: row.id },
        data: {
          headline,
          opening: meta.opening ?? null,
          event: meta.event ?? null,
          site: meta.site ?? null,
          pgnDate: meta.pgnDate ?? null,
          round: meta.round ?? null,
          white: meta.white ?? null,
          black: meta.black ?? null,
          whiteElo: meta.whiteElo ?? null,
          blackElo: meta.blackElo ?? null,
          result: meta.result ?? null,
        },
      });
    }

    this.logger.log(`Backfill complete: ${stale.length} analyses updated`);
  }

  /**
   * Extract opening name from PGN headers.
   * Looks for [Opening "..."] tag.
   */
  private extractOpening(pgn?: string): string | null {
    if (!pgn) return null;
    const match = pgn.match(/\[Opening\s+"([^"]+)"\]/);
    return match ? match[1] : null;
  }

  /**
   * Extract a PGN header value by key.
   */
  private extractHeader(pgn: string, key: string): string | null {
    const re = new RegExp(`\\[${key}\\s+"([^"]*)"\\]`);
    const m = pgn.match(re);
    return m ? m[1] : null;
  }

  /**
   * Build headline from PGN headers.
   * e.g. "Fischer (2785) 1-0 Spassky (2660)"
   * Falls back to null if no player info found.
   */
  private buildHeadline(pgn?: string): string | null {
    if (!pgn) return null;

    const white = this.extractHeader(pgn, 'White');
    const black = this.extractHeader(pgn, 'Black');
    if (!white && !black) return null;

    const whiteElo = this.extractHeader(pgn, 'WhiteElo');
    const blackElo = this.extractHeader(pgn, 'BlackElo');
    const result = this.extractHeader(pgn, 'Result');

    const wPart = white
      ? whiteElo && whiteElo !== '?' ? `${white} (${whiteElo})` : white
      : '?';
    const bPart = black
      ? blackElo && blackElo !== '?' ? `${black} (${blackElo})` : black
      : '?';
    const rPart = result && result !== '*' ? result : 'vs';

    return `${wPart} ${rPart} ${bPart}`;
  }

  /**
   * Extract all standard PGN metadata fields.
   */
  private extractMetadata(pgn?: string) {
    if (!pgn) return {};
    return {
      white: this.extractHeader(pgn, 'White'),
      black: this.extractHeader(pgn, 'Black'),
      whiteElo: this.extractHeader(pgn, 'WhiteElo'),
      blackElo: this.extractHeader(pgn, 'BlackElo'),
      result: this.extractHeader(pgn, 'Result'),
      event: this.extractHeader(pgn, 'Event'),
      site: this.extractHeader(pgn, 'Site'),
      pgnDate: this.extractHeader(pgn, 'Date'),
      round: this.extractHeader(pgn, 'Round'),
      opening: this.extractOpening(pgn),
    };
  }

  /**
   * Generate default title: "New analysis YYYY-MM-DD HH:mm:ss"
   */
  private defaultTitle(date: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    const yyyy = date.getFullYear();
    const mm = pad(date.getMonth() + 1);
    const dd = pad(date.getDate());
    const hh = pad(date.getHours());
    const min = pad(date.getMinutes());
    const ss = pad(date.getSeconds());
    return `New analysis ${yyyy}-${mm}-${dd} ${hh}:${min}:${ss}`;
  }

  /**
   * KS-3261. Преференциальный source_hash (для записи в БД): первый
   * непустой из приоритетной цепочки lichess → archive → pgn-headers.
   *
   * KS-3262: для lookup'а отдельная функция `computeAllSourceHashes`,
   * которая возвращает ВСЕ возможные хеши одновременно — нужно матчить
   * legacy-записи с pgn-hash против нового lichess-hash при повторном
   * открытии той же партии (см. описание в `computeAllSourceHashes`).
   */
  static computeSourceHash(input: {
    lichessGameId?: string | null;
    archiveGameId?: string | null;
    pgn?: string | null;
  }): string | null {
    return AnalysisService.computeAllSourceHashes(input).preferred;
  }

  /**
   * KS-3262. Возвращает все возможные source_hash'и для текущего
   * запроса + preferred (для записи). Зачем все:
   *
   * Сценарий, который сломался в KS-3262 prod:
   *   Шаг 1. Фронт делает POST /analyses БЕЗ `lichessGameId` (старый
   *          callsite). Backend вычисляет `source_hash='pgn:<sha256>'`
   *          → создаёт запись A.
   *   Шаг 2. Пользователь добавляет вариант — PATCH обновляет pgn.
   *   Шаг 3. Фронт повторно открывает партию, теперь С `lichessGameId`.
   *          Backend вычисляет `source_hash='lichess:<id>'`.
   *          findFirst по `lichess:...` → не находит запись A (у неё
   *          `pgn:...`) → создаёт новую B, вариант теряется в UX.
   *
   * Фикс: lookup ищет ЛЮБОЙ из applicable хешей. Если найдена legacy-
   * запись с `pgn:`-hash, а в текущем запросе пришёл `lichessGameId` —
   * сервис делает upgrade: обновляет колонки `source_hash` на
   * lichess-вариант + `lichess_game_id` (backfill). Следующий lookup
   * найдёт её уже по preferred-хешу.
   *
   * Возвращает массив `applicable` (только не-null, дедуплицированный)
   * и `preferred` (то что пишется в новую запись или после upgrade'а).
   */
  static computeAllSourceHashes(input: {
    lichessGameId?: string | null;
    archiveGameId?: string | null;
    pgn?: string | null;
  }): { applicable: string[]; preferred: string | null } {
    const hashes: string[] = [];
    let preferred: string | null = null;

    if (input.lichessGameId) {
      const h = `lichess:${input.lichessGameId}`;
      hashes.push(h);
      preferred ??= h;
    }
    if (input.archiveGameId) {
      const h = `archive:${input.archiveGameId}`;
      hashes.push(h);
      preferred ??= h;
    }
    if (input.pgn) {
      const extract = (key: string): string | null => {
        const re = new RegExp(`\\[${key}\\s+"([^"]*)"\\]`);
        const m = input.pgn!.match(re);
        return m ? m[1] : null;
      };
      const white = extract('White');
      const black = extract('Black');
      const date = extract('Date');
      const event = extract('Event');
      const round = extract('Round');
      if (white && black && date) {
        const norm = (s: string | null) => (s ?? '').trim().toLowerCase();
        const key = `${norm(white)}|${norm(black)}|${date}|${norm(event)}|${norm(round)}`;
        const h = `pgn:${createHash('sha256').update(key).digest('hex')}`;
        hashes.push(h);
        preferred ??= h;
      }
    }
    return { applicable: hashes, preferred };
  }

  /**
   * KS-3261. Создание анализа с дедупом.
   *
   * Если для (userId, source_hash) уже существует анализ — НЕ создаём
   * новый, не перезаписываем PGN (там у пользователя могут быть варианты,
   * NAG, стрелки), просто обновляем `last_opened_at = now()` и возвращаем
   * существующий. В response добавляется `existing: true` — фронт может
   * показать toast «открыли существующий анализ».
   *
   * Если source_hash = null (headers неполные, нет source-id) — создаём
   * как раньше.
   */
  /**
   * KS-3263. Резолвер PGN партии из источника (broadcast / archive)
   * для случая, когда фронт передал только `lichessGameId` /
   * `archiveGameId` без `pgn`. Это убирает класс багов «фронт прислал
   * чуть-чуть другой PGN → другой headers-hash → dedup промахнулся →
   * дубль» — теперь источник истины один (наша БД).
   *
   * Источники:
   *   - `lichessGameId` → broadcast-service HTTP
   *     `GET /internal/games/by-lichess/:id` (за InternalKeyGuard).
   *   - `archiveGameId` → FDW `archive_games_remote` (KS-2760, у api
   *     подключён к archive-db через postgres_fdw).
   *
   * Возвращает `null` если источник недоступен / партия не найдена /
   * env не сконфигурирован (broadcast_service_url или internal-key
   * отсутствуют на проде). Тогда caller использует pgn из dto если он
   * есть, иначе создаёт пустой анализ.
   */
  /**
   * KS-3263 / KS-3523. Резолвер PGN партии по lichess/archive id.
   * Используется как AnalysisService.create, так и GuessService (KS-3523
   * — подгрузка pgn в guess-сессию при старте из архива). Возвращает
   * `null` при любой инфра-проблеме (FDW down, network, broadcast-service
   * unavailable) — caller гасит graceful'но.
   */
  async resolveSourceGame(input: {
    lichessGameId?: string | null;
    archiveGameId?: string | null;
  }): Promise<ResolvedSourceGame | null> {
    if (input.lichessGameId) {
      const url = process.env.BROADCAST_SERVICE_URL;
      const key = process.env.SYNTHETIC_BOT_INTERNAL_KEY;
      if (!url || !key) {
        this.logger.warn(
          `KS-3263: BROADCAST_SERVICE_URL or SYNTHETIC_BOT_INTERNAL_KEY not configured; ` +
            `cannot resolve lichessGameId=${input.lichessGameId}`,
        );
        return null;
      }
      try {
        const res = await fetch(
          `${url}/internal/games/by-lichess/${encodeURIComponent(input.lichessGameId)}`,
          {
            headers: { 'X-Internal-Auth': key },
            signal: AbortSignal.timeout(8_000),
          },
        );
        if (!res.ok) {
          this.logger.warn(
            `KS-3263: broadcast-service /by-lichess/${input.lichessGameId} HTTP ${res.status}`,
          );
          return null;
        }
        const data = (await res.json()) as {
          pgn: string;
          whitePlayer: string | null;
          blackPlayer: string | null;
          whiteElo: number | null;
          blackElo: number | null;
          result: string | null;
        };
        if (!data.pgn) return null;
        return {
          pgn: data.pgn,
          white: data.whitePlayer,
          black: data.blackPlayer,
          whiteElo: data.whiteElo,
          blackElo: data.blackElo,
          result: data.result,
        };
      } catch (e: unknown) {
        this.logger.warn(
          `KS-3263: broadcast resolve error for ${input.lichessGameId}: ${(e as Error).message}`,
        );
        return null;
      }
    }
    if (input.archiveGameId) {
      // KS-3263. Резолвер через postgres_fdw foreign table
      // `archive_games_remote` (KS-2760). После hotfix devops добавил в
      // foreign table колонки `pgn, white_name, black_name, result` —
      // SELECT теперь возвращает полную партию из archive_kingside.
      // Try/catch: graceful degrade на любой инфра-проблеме (FDW down /
      // user-mapping / network) — return null, AnalysisPage создаст
      // запись без pgn (пользователь увидит пусто, но не 500).
      try {
        const rows = await this.prisma.$queryRawUnsafe<
          Array<{
            pgn: string | null;
            white_name: string | null;
            black_name: string | null;
            white_elo: number | null;
            black_elo: number | null;
            result: string | null;
          }>
        >(
          `SELECT pgn, white_name, black_name, white_elo, black_elo, result
             FROM archive_games_remote
            WHERE id = $1::uuid
            LIMIT 1`,
          input.archiveGameId,
        );
        const row = rows[0];
        if (!row || !row.pgn) {
          this.logger.warn(
            `KS-3263: archive_games_remote ${input.archiveGameId} not found or pgn=null`,
          );
          return null;
        }
        return {
          pgn: row.pgn,
          white: row.white_name,
          black: row.black_name,
          whiteElo: row.white_elo,
          blackElo: row.black_elo,
          result: row.result,
        };
      } catch (e: unknown) {
        this.logger.warn(
          `KS-3263: archive_games_remote resolve error for ${input.archiveGameId}: ${(e as Error).message}`,
        );
        return null;
      }
    }
    return null;
  }

  async create(
    userId: string,
    dto: CreateAnalysisDto,
  ): Promise<Record<string, unknown> & { existing: boolean }> {
    const now = new Date();

    // KS-3263: если фронт прислал source-id без PGN — резолвим pgn из
    // источника. Это устраняет дрифт PGN-headers между фронтом и БД.
    let resolvedPgn = dto.pgn ?? null;
    if (!resolvedPgn && (dto.lichessGameId || dto.archiveGameId)) {
      const resolved = await this.resolveSourceGame({
        lichessGameId: dto.lichessGameId ?? null,
        archiveGameId: dto.archiveGameId ?? null,
      });
      if (resolved) {
        resolvedPgn = resolved.pgn;
        this.logger.log(
          `KS-3263 PGN resolved from source: ${dto.lichessGameId ? `lichess:${dto.lichessGameId}` : `archive:${dto.archiveGameId}`} ` +
            `→ pgnLen=${resolved.pgn.length}`,
        );
      }
    }

    const title = dto.title ?? this.defaultTitle(now);
    const headline = this.buildHeadline(resolvedPgn ?? undefined);
    const meta = this.extractMetadata(resolvedPgn ?? undefined);

    // KS-3262: вычисляем ВСЕ возможные source_hash'и, чтобы dedup нашёл
    // legacy-записи созданные ранее с другим типом ключа (например с
    // pgn-headers-hash до того, как фронт начал передавать lichessGameId).
    const { applicable: applicableHashes, preferred: sourceHash } =
      AnalysisService.computeAllSourceHashes({
        lichessGameId: dto.lichessGameId ?? null,
        archiveGameId: dto.archiveGameId ?? null,
        // KS-3263: используем resolvedPgn (если фронт прислал source-id
        // без pgn — здесь уже из broadcast_games/archive_games). Это
        // делает pgn-hash детерминированным от нашей БД, а не от того,
        // что прислал фронт.
        pgn: resolvedPgn,
      });

    // Dedup lookup — только если есть хотя бы один applicable hash.
    if (applicableHashes.length > 0) {
      const existing = await this.prisma.analysis.findFirst({
        where: { userId, sourceHash: { in: applicableHashes } },
      });
      if (existing) {
        // KS-3262: upgrade legacy-записи. Если найденная запись имеет
        // source_hash отличный от preferred (например в БД 'pgn:...'
        // а в запросе пришёл lichessGameId → preferred = 'lichess:...'),
        // или не заполнены lichess_game_id / archive_game_id — обновляем
        // их сейчас. Следующий lookup найдёт запись уже по preferred.
        const updateData: Record<string, unknown> = { lastOpenedAt: now };
        if (sourceHash && existing.sourceHash !== sourceHash) {
          updateData.sourceHash = sourceHash;
        }
        if (dto.lichessGameId && !existing.lichessGameId) {
          updateData.lichessGameId = dto.lichessGameId;
        }
        if (dto.archiveGameId && !existing.archiveGameId) {
          updateData.archiveGameId = dto.archiveGameId;
        }
        const updated = await this.prisma.analysis.update({
          where: { id: existing.id },
          data: updateData,
        });
        const upgraded = Object.keys(updateData).length > 1; // не только lastOpenedAt
        this.logger.log(
          `Analysis dedup hit user=${userId.slice(0, 8)} ` +
            `matchedHash=${(existing.sourceHash ?? '∅').slice(0, 24)} → existing=${existing.id}` +
            (upgraded ? ` (upgraded to ${sourceHash?.slice(0, 24) ?? '∅'})` : ''),
        );
        return { ...updated, existing: true };
      }
    }

    const created = await this.prisma.analysis.create({
      data: {
        userId,
        title,
        headline,
        // KS-3263: пишем resolvedPgn (если был source-id и резолв сработал
        // — это pgn из broadcast/archive; иначе dto.pgn от фронта; иначе null).
        pgn: resolvedPgn,
        fen: dto.fen ?? null,
        opening: meta.opening ?? null,
        event: meta.event ?? null,
        site: meta.site ?? null,
        pgnDate: meta.pgnDate ?? null,
        round: meta.round ?? null,
        white: meta.white ?? null,
        black: meta.black ?? null,
        whiteElo: meta.whiteElo ?? null,
        blackElo: meta.blackElo ?? null,
        result: meta.result ?? null,
        category: dto.category ?? 'analysis',
        // KS-3261. Source-привязка для дедупа и bulk-check архив-карточек.
        sourceHash,
        lichessGameId: dto.lichessGameId ?? null,
        archiveGameId: dto.archiveGameId ?? null,
        // lastOpenedAt = createdAt по default'у схемы, но фиксируем явно
        // чтобы сразу попасть в LRU-сортировку.
        lastOpenedAt: now,
      },
    });
    return { ...created, existing: false };
  }

  /**
   * KS-3261. Bulk-check: для архив-странички — пометки «уже в мастерской»
   * на карточках партий. Возвращает map sourceId → analysisId | null.
   */
  async checkExistingBySource(
    userId: string,
    sources: {
      lichessGameIds?: string[];
      archiveGameIds?: string[];
    },
  ): Promise<{
    lichess: Record<string, string | null>;
    archive: Record<string, string | null>;
  }> {
    const lichessIds = (sources.lichessGameIds ?? []).filter(
      (s) => typeof s === 'string' && s.length > 0,
    );
    const archiveIds = (sources.archiveGameIds ?? []).filter(
      (s) => typeof s === 'string' && s.length > 0,
    );

    const lichessResult: Record<string, string | null> = {};
    const archiveResult: Record<string, string | null> = {};

    if (lichessIds.length > 0) {
      const rows = await this.prisma.analysis.findMany({
        where: { userId, lichessGameId: { in: lichessIds } },
        select: { id: true, lichessGameId: true },
      });
      for (const id of lichessIds) lichessResult[id] = null;
      for (const r of rows) {
        if (r.lichessGameId) lichessResult[r.lichessGameId] = r.id;
      }
    }
    if (archiveIds.length > 0) {
      const rows = await this.prisma.analysis.findMany({
        where: { userId, archiveGameId: { in: archiveIds } },
        select: { id: true, archiveGameId: true },
      });
      for (const id of archiveIds) archiveResult[id] = null;
      for (const r of rows) {
        if (r.archiveGameId) archiveResult[r.archiveGameId] = r.id;
      }
    }
    return { lichess: lichessResult, archive: archiveResult };
  }

  /**
   * KS-2948: список анализов пользователя с пагинацией.
   *
   * Параметры:
   *  - `limit` — кол-во записей в ответе. Дефолт 20, max 100, min 1.
   *    NaN/невалидное → дефолт. До KS-2948 список не имел лимита
   *    и вместе с MCP-обёрткой (см. `tools/mcp-kingside.mjs`) на
   *    реальном пользователе давал ~200 КБ tool_result, что ломало
   *    Claude CLI (199,835 chars > token limit).
   *  - `offset` — пагинация. Дефолт 0, min 0.
   *  - `withPgn` — если `true`, в каждую запись добавляются `pgn`,
   *    `fen`, `currentPosition`. По умолчанию список — только
   *    метаданные; для конкретной партии используется `GET /analyses/:id`.
   */
  async findAll(
    userId: string,
    options?: { limit?: number; offset?: number; withPgn?: boolean; search?: string },
  ) {
    const DEFAULT_LIMIT = 20;
    const MAX_LIMIT = 100;
    const rawLimit = options?.limit;
    const limit =
      rawLimit === undefined || Number.isNaN(rawLimit)
        ? DEFAULT_LIMIT
        : Math.min(Math.max(Math.floor(rawLimit), 1), MAX_LIMIT);
    const rawOffset = options?.offset;
    const offset =
      rawOffset === undefined || Number.isNaN(rawOffset)
        ? 0
        : Math.max(Math.floor(rawOffset), 0);

    const baseSelect = {
      id: true,
      title: true,
      headline: true,
      opening: true,
      event: true,
      white: true,
      black: true,
      result: true,
      category: true,
      tags: true,
      createdAt: true,
    } as const;
    const select = options?.withPgn
      ? {
          ...baseSelect,
          pgn: true,
          fen: true,
          currentPosition: true,
        }
      : baseSelect;

    // KS-3203: серверный ILIKE-поиск по своим анализам. Слова в `search`
    // разбиваются по whitespace; каждое слово должно совпасть хотя бы с
    // одним из полей headline/title/opening/event/white/black/site/tags
    // (AND между словами, OR между полями) — drop-in замена для
    // фронт-loop'а из KS-3202. Пустая/whitespace-only строка → фильтр
    // не применяется (старое поведение).
    const searchWords =
      typeof options?.search === 'string'
        ? options.search.trim().split(/\s+/).filter(Boolean)
        : [];
    const wordFilters = searchWords.map((w) => this.buildWordFilter(w));

    const analyses = await this.prisma.analysis.findMany({
      where: {
        userId,
        ...(wordFilters.length > 0 && { AND: wordFilters }),
      },
      select,
      // KS-3261. LRU-сортировка: последний открытый — наверху.
      // Для legacy-записей last_opened_at был выставлен в created_at
      // миграцией, так что порядок старого хвоста сохраняется.
      orderBy: { lastOpenedAt: 'desc' },
      take: limit,
      skip: offset,
    });
    return analyses.map((a) => ({
      ...a,
      tags: a.tags ? a.tags.split(' ').filter(Boolean) : [],
    }));
  }

  private buildWordFilter(word: string) {
    return {
      OR: [
        { headline: { contains: word, mode: 'insensitive' as const } },
        { title: { contains: word, mode: 'insensitive' as const } },
        { opening: { contains: word, mode: 'insensitive' as const } },
        { event: { contains: word, mode: 'insensitive' as const } },
        { white: { contains: word, mode: 'insensitive' as const } },
        { black: { contains: word, mode: 'insensitive' as const } },
        { site: { contains: word, mode: 'insensitive' as const } },
        // KS-3203: tags хранится строкой (space-separated). ILIKE %word%
        // ловит совпадение токена внутри строки тегов.
        { tags: { contains: word, mode: 'insensitive' as const } },
      ],
    };
  }

  async search(userId: string, query: string, limit = 20) {
    const safeLimit = Math.min(limit, 50);
    const words = query.trim().split(/\s+/).filter(Boolean);

    // Each word must match at least one field (AND between words, OR between fields)
    const wordFilters = words.length > 0
      ? words.map((w) => this.buildWordFilter(w))
      : [];

    const analyses = await this.prisma.analysis.findMany({
      where: {
        userId,
        ...(wordFilters.length > 0 && { AND: wordFilters }),
      },
      select: {
        id: true,
        title: true,
        headline: true,
        opening: true,
        category: true,
        tags: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: safeLimit,
    });
    return analyses.map((a) => ({
      ...a,
      tags: a.tags ? a.tags.split(' ').filter(Boolean) : [],
    }));
  }

  async findOne(userId: string, id: string) {
    const analysis = await this.prisma.analysis.findUnique({ where: { id } });
    if (!analysis) throw new NotFoundException('Analysis not found');
    if (analysis.userId !== userId) throw new ForbiddenException();
    // KS-3261. LRU bump: открытие существующего анализа поднимает его
    // в верх списка. Async-update без ожидания — не блокирует ответ.
    void this.prisma.analysis
      .update({ where: { id }, data: { lastOpenedAt: new Date() } })
      .catch((e) =>
        this.logger.warn(
          `KS-3261 lastOpenedAt bump failed for ${id}: ${(e as Error).message}`,
        ),
      );
    return {
      ...analysis,
      tags: analysis.tags ? analysis.tags.split(' ').filter(Boolean) : [],
    };
  }

  /**
   * KS-2601 (ADR-051 §3 share-2). Read-only публичная проекция анализа.
   *
   * Возврат:
   *  - 404 (NotFoundException) если запись не найдена ИЛИ `isPublic=false`.
   *    Не светим существование непубличной записи — это контракт acceptance.
   *  - 200 + тело без `userId` (не отдаём автора анонимам — расширим
   *    отдельной задачей, если потребуется показывать username).
   */
  async findPublic(id: string) {
    const analysis = await this.prisma.analysis.findUnique({ where: { id } });
    if (!analysis || !analysis.isPublic) {
      throw new NotFoundException('Analysis not found');
    }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { userId: _userId, ...publicProjection } = analysis;
    return {
      ...publicProjection,
      tags: analysis.tags ? analysis.tags.split(' ').filter(Boolean) : [],
    };
  }

  async update(userId: string, id: string, dto: UpdateAnalysisDto) {
    const analysis = await this.prisma.analysis.findUnique({ where: { id } });
    if (!analysis) throw new NotFoundException('Analysis not found');
    if (analysis.userId !== userId) throw new ForbiddenException();

    // KS-2404: ранее любая meta-нормализация затирала existing headers
    // на null, если в новом dto.pgn нет [White ...]/[Event ...] и т.п.
    // Это пересекалось со stale-state-багом фронта (KS-2403):
    // фронт мог прислать только moves без headers — и валидные
    // event/white/black-поля в БД теряли значения.
    //
    // Фикс: обновляем поле header'а только если новое значение **не
    // null**. Если в новом pgn header'а нет, оставляем то, что было.
    // Это не покрывает случай «фронт прислал stale moves c HEADERS
    // от другой игры» (там headers перезатрутся под stale-headers,
    // и это правильно — мы доверяем тому, что прислал клиент). Но
    // защищает от потери headers при moves-only PATCH.
    const meta = dto.pgn !== undefined ? this.extractMetadata(dto.pgn) : null;
    const headerUpdate = meta
      ? {
          // headline пересчитываем только если хотя бы один из
          // White/Black есть — иначе buildHeadline вернул бы null и
          // затёр существующий headline.
          ...(meta.white || meta.black
            ? { headline: this.buildHeadline(dto.pgn) }
            : {}),
          ...(meta.opening !== null && { opening: meta.opening }),
          ...(meta.event !== null && { event: meta.event }),
          ...(meta.site !== null && { site: meta.site }),
          ...(meta.pgnDate !== null && { pgnDate: meta.pgnDate }),
          ...(meta.round !== null && { round: meta.round }),
          ...(meta.white !== null && { white: meta.white }),
          ...(meta.black !== null && { black: meta.black }),
          ...(meta.whiteElo !== null && { whiteElo: meta.whiteElo }),
          ...(meta.blackElo !== null && { blackElo: meta.blackElo }),
          ...(meta.result !== null && { result: meta.result }),
        }
      : {};

    // KS-2404 telemetry: если фронт прислал PGN с headers, отличными
    // от тех, что в БД (white/black/round) — лог warn для прод-
    // диагностики stale-state регрессий. Не блокирующее.
    if (
      meta &&
      ((meta.white && analysis.white && meta.white !== analysis.white) ||
        (meta.black && analysis.black && meta.black !== analysis.black) ||
        (meta.round && analysis.round && meta.round !== analysis.round))
    ) {
      this.logger.warn(
        `analysis update headers diverge id=${id} user=${userId} ` +
          `was: ${analysis.white}/${analysis.black} round=${analysis.round} ` +
          `now: ${meta.white}/${meta.black} round=${meta.round}`,
      );
    }

    return this.prisma.analysis.update({
      where: { id },
      data: {
        ...(dto.title !== undefined && { title: dto.title }),
        ...(dto.pgn !== undefined && { pgn: dto.pgn }),
        ...(dto.fen !== undefined && { fen: dto.fen }),
        ...(dto.currentPosition !== undefined && { currentPosition: dto.currentPosition }),
        // KS-3045: ориентация доски, сохранённая автором. `null`
        // допустим и означает «сброс на дефолт фронта». Поле в data
        // попадает только если клиент явно прислал ключ — пустой
        // PATCH без `boardOrientation` ничего не трогает.
        ...(dto.boardOrientation !== undefined && {
          boardOrientation: dto.boardOrientation,
        }),
        ...(dto.tags !== undefined && { tags: dto.tags.join(' ') }),
        ...headerUpdate,
      },
    });
  }

  /**
   * KS-2602 (ADR-051 §3 share-3). Toggle `isPublic` автором анализа.
   *
   * Возврат:
   *  - 404 (NotFoundException) если запись не найдена.
   *  - 403 (ForbiddenException) если запрос делает не автор.
   *  - 200 + обновлённая запись (с tags split) при успехе.
   */
  async share(userId: string, id: string, isPublic: boolean) {
    const analysis = await this.prisma.analysis.findUnique({ where: { id } });
    if (!analysis) throw new NotFoundException('Analysis not found');
    if (analysis.userId !== userId) throw new ForbiddenException();

    const updated = await this.prisma.analysis.update({
      where: { id },
      data: { isPublic },
    });
    return {
      ...updated,
      tags: updated.tags ? updated.tags.split(' ').filter(Boolean) : [],
    };
  }

  async exportPgn(userId: string, ids: string[]): Promise<string> {
    const analyses = await this.prisma.analysis.findMany({
      where: { id: { in: ids }, userId },
      orderBy: { createdAt: 'desc' },
    });

    if (analyses.length === 0) {
      throw new NotFoundException('No analyses found');
    }

    return analyses
      .map((a) => {
        const headers: string[] = [];
        headers.push(`[Event "${a.title}"]`);
        headers.push(`[Site "Kingside"]`);
        const d = a.createdAt;
        headers.push(`[Date "${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}"]`);
        if (a.fen) {
          headers.push(`[FEN "${a.fen}"]`);
          headers.push(`[SetUp "1"]`);
        }
        if (a.opening) {
          headers.push(`[Opening "${a.opening}"]`);
        }
        headers.push(`[Result "*"]`);
        const moves = a.pgn ?? '*';
        return headers.join('\n') + '\n\n' + moves;
      })
      .join('\n\n\n');
  }

  async remove(userId: string, id: string) {
    const analysis = await this.prisma.analysis.findUnique({ where: { id } });
    if (!analysis) throw new NotFoundException('Analysis not found');
    if (analysis.userId !== userId) throw new ForbiddenException();
    await this.prisma.analysis.delete({ where: { id } });
    return { deleted: true };
  }

  /**
   * KS-3602 / ADR-100. NAG auto-annotation: создать или обновить
   * дубль анализа с авто-NAG'ами и variations.
   *
   * Шаги (соответствуют ADR-100 §8.4–§8.5):
   *  1. Загрузить целевой Analysis с проверкой владельца через
   *     `findFirst({ id, userId })` — это маскирует чужие записи в 404
   *     (не светим существование чужого анализа).
   *  2. Если целевой сам является дублём (`originalAnalysisId != null`)
   *     — резолвим в родителя (рекурсия защита: ровно один шаг).
   *     Если родитель удалён — 410 Gone, регенерация невозможна.
   *  3. Поиск существующего дубля парента по
   *     `findFirst({ userId, originalAnalysisId: parent.id })`.
   *     UNIQUE индекс не ставим (см. ADR §«Не делать»: race-обработка
   *     проще в коде).
   *  4. Если существует — `update` (новый pgn, lastOpenedAt). title НЕ
   *     трогаем — пользователь мог переименовать вручную.
   *  5. Если не существует — `create` с копированием метаданных партии
   *     из parent (см. §«Скопированные поля»). pgn новый, title с
   *     суффиксом, isPublic/sourceHash/guessSessionId — сброшены,
   *     currentPosition=0.
   *  6. Возврат в shape `findOne`-результата (tags разбиты на массив).
   */
  async duplicateAnnotated(
    userId: string,
    id: string,
    dto: DuplicateAnnotatedDto,
  ) {
    // 1. Загружаем + проверяем владельца одним findFirst — чужие
    //    отдаём как 404, не светим существование.
    const target = await this.prisma.analysis.findFirst({
      where: { id, userId },
    });
    if (!target) throw new NotFoundException('Analysis not found');

    // 2. Резолв родителя: если target — сам дубль, ищем настоящий
    //    оригинал. Гарантируем ровно один шаг рекурсии: parent сам
    //    дублём не считаем (для simplicity и безопасности — глубина 1).
    let parent = target;
    if (target.originalAnalysisId) {
      const resolved = await this.prisma.analysis.findFirst({
        where: { id: target.originalAnalysisId, userId },
      });
      if (!resolved) {
        // Оригинал удалён, но дубль ещё существует. Регенерировать
        // невозможно — нет канонической метаданных партии. 410 Gone
        // — стандартный HTTP-код для «ресурс был, теперь нет».
        throw new HttpException(
          'Исходный анализ удалён, регенерация невозможна',
          HttpStatus.GONE,
        );
      }
      parent = resolved;
    }

    // 3. Поиск существующего дубля родителя.
    const existing = await this.prisma.analysis.findFirst({
      where: { userId, originalAnalysisId: parent.id },
    });

    const now = new Date();

    // 4. Update — обновляем только pgn + lastOpenedAt, остальное
    //    оставляем (title могли переименовать, метаданные не дрифтуют).
    if (existing) {
      const updated = await this.prisma.analysis.update({
        where: { id: existing.id },
        data: { pgn: dto.pgn, lastOpenedAt: now },
      });
      return {
        ...updated,
        tags: updated.tags ? updated.tags.split(' ').filter(Boolean) : [],
      };
    }

    // 5. Create — копируем метаданные партии из родителя.
    const titleSuffix = dto.titleSuffix ?? '(автоаннотация)';
    const created = await this.prisma.analysis.create({
      data: {
        userId,
        title: `${parent.title} ${titleSuffix}`,
        pgn: dto.pgn,
        originalAnalysisId: parent.id,
        // Метаданные партии — наследуем от родителя.
        category: parent.category,
        tags: parent.tags,
        opening: parent.opening,
        event: parent.event,
        site: parent.site,
        pgnDate: parent.pgnDate,
        round: parent.round,
        white: parent.white,
        black: parent.black,
        whiteElo: parent.whiteElo,
        blackElo: parent.blackElo,
        result: parent.result,
        fen: parent.fen,
        boardOrientation: parent.boardOrientation,
        headline: parent.headline,
        lichessGameId: parent.lichessGameId,
        archiveGameId: parent.archiveGameId,
        // Сброс согласно ADR-100 §8 / KS-3602 «Не копируются»:
        //  - isPublic: дубль всегда приватный.
        //  - sourceHash: не дедуплицируем дубль с оригиналом по партии.
        //  - guessSessionId: soft-ссылка не наследуется.
        //  - currentPosition: 0 — начинаем с начала анотированной партии.
        isPublic: false,
        sourceHash: null,
        guessSessionId: null,
        currentPosition: 0,
        lastOpenedAt: now,
      },
    });
    return {
      ...created,
      tags: created.tags ? created.tags.split(' ').filter(Boolean) : [],
    };
  }
}
