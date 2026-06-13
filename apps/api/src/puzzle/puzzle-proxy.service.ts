/**
 * KS-4088 (блокер KS-4065). Dev-проксирование каталога задач на
 * производственный puzzle-API по образцу archive-прокси KS-4082/KS-4087
 * (`ArchivePositionProxyService`, `AnalysisService.resolveSourceGame`).
 *
 * Проблема: на dev в локальной puzzle-БД всего 3 задачи `source=lichess`,
 * поэтому `/puzzles` в кадре видеообзора показывает 3 карточки и сразу
 * «Больше задач нет». На проде задач 10 000+.
 *
 * Решение (server-to-server, без правок фронта и без CORS): когда задан
 * `PUZZLE_SERVICE_URL`, локальный api проксирует «читающие» маршруты
 * каталога (`/puzzles/browse`, `/puzzles/browse/count`, `/puzzles/:id`)
 * на прод-API. Прод отдаёт свой богатый каталог с рабочим `nextCursor` —
 * бесконечная прокрутка дозагружает страницы.
 *
 * Попытки (`/puzzles/:id/attempt`) при этом пишутся ЛОКАЛЬНО: перед
 * грейдингом задача с прода материализуется в локальную таблицу
 * `puzzles` (ensureLocalPuzzle), дальше работает штатный
 * `PuzzleService.submitAttempt` — статистика и дневник ошибок копятся
 * на наших таблицах.
 *
 * Прод-API запущен БЕЗ глобального префикса `/api` (см. `apps/api/src/
 * main.ts` — `setGlobalPrefix` отсутствует), поэтому путь — `/puzzles/...`
 * без префикса. Дефолтное значение — `https://api.kingside.site`
 * (ADR-017 §2, поддомен api-сервиса).
 *
 * ВКЛЮЧАЕТСЯ ТОЛЬКО при заданном `PUZZLE_SERVICE_URL`. На проде переменная
 * не выставляется — там api сам владеет каталогом, проксировать некуда.
 */
import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/** Таймаут вызова прод-API. */
const FETCH_TIMEOUT_MS = 10_000;

/** Прод-поддомен puzzle-API (ADR-017 §2), api запущен без `/api` префикса. */
const PUZZLE_BASE_URL_DEFAULT = 'https://api.kingside.site';

/** Сырой ответ прод getOne (`PuzzleService.formatPuzzle`). */
interface ProdPuzzle {
  id: string;
  fen: string;
  moves: string[] | string;
  rating?: number;
  themes?: string[] | string;
  source?: string;
  solutionMode?: string;
}

@Injectable()
export class PuzzleProxyService {
  private readonly logger = new Logger(PuzzleProxyService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Прокси активен только при явно заданном `PUZZLE_SERVICE_URL`. */
  get enabled(): boolean {
    return !!process.env.PUZZLE_SERVICE_URL;
  }

  private get baseUrl(): string {
    return process.env.PUZZLE_SERVICE_URL || PUZZLE_BASE_URL_DEFAULT;
  }

  /**
   * Прозрачный прокси `/puzzles/browse` и `/puzzles/browse/count`.
   * `rawUrl` — `req.url` обработчика (`/puzzles/browse?...`); прод отдаёт
   * JSON `{ data, nextCursor, total }` — возвращаем как есть.
   */
  async forward(rawUrl: string): Promise<unknown> {
    const url = new URL(rawUrl, this.baseUrl);
    return this.fetchJson(url, `forward ${url.pathname}`);
  }

  /** Прокси `GET /puzzles/:id` — задача с прода (fen + moves + themes). */
  async getPuzzle(id: string): Promise<unknown> {
    const url = new URL(`/puzzles/${encodeURIComponent(id)}`, this.baseUrl);
    return this.fetchJson(url, `getPuzzle ${id}`);
  }

  /**
   * Гарантировать, что задача `id` существует в локальной БД — нужно
   * для `submitAttempt` (FK `puzzle_attempts.puzzle_id → puzzles.id` +
   * грейдинг по `fen`/`moves`). Если её нет — тянем с прода и пишем
   * в `puzzles` (insert; при гонке `skipDuplicates` гасит конфликт).
   */
  async ensureLocalPuzzle(id: string): Promise<void> {
    const existing = await this.prisma.puzzle.findUnique({
      where: { id },
      select: { id: true },
    });
    if (existing) return;

    const url = new URL(`/puzzles/${encodeURIComponent(id)}`, this.baseUrl);
    const prod = (await this.fetchJson(
      url,
      `ensureLocalPuzzle ${id}`,
    )) as ProdPuzzle;

    const moves = Array.isArray(prod.moves)
      ? prod.moves.join(' ')
      : (prod.moves ?? '');
    const themes = Array.isArray(prod.themes)
      ? prod.themes.join(' ')
      : (prod.themes ?? '');

    await this.prisma.puzzle.createMany({
      data: [
        {
          id: prod.id,
          fen: prod.fen,
          moves,
          rating: prod.rating ?? 1500,
          themes,
          source: prod.source ?? 'lichess',
          solutionMode: prod.solutionMode ?? 'forced-line',
        },
      ],
      skipDuplicates: true,
    });
    this.logger.log(`materialized prod puzzle ${id} into local DB`);
  }

  private async fetchJson(url: URL, label: string): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(url.toString(), {
        method: 'GET',
        signal: controller.signal,
      });
    } catch (err: unknown) {
      const msg = (err as Error).message ?? String(err);
      this.logger.error(`puzzle-proxy ${label} fetch failed: ${msg}`);
      throw new ServiceUnavailableException('puzzle service unavailable');
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      this.logger.error(`puzzle-proxy ${label} → HTTP ${res.status}`);
      throw new ServiceUnavailableException(
        `puzzle service error ${res.status}`,
      );
    }
    return res.json();
  }
}
