/**
 * KS-3469 / ADR-090 §4.2 B2. Тонкая proxy-обёртка к
 * `archive-service /games/by-position` с жёсткими default-параметрами
 * для сценария «собрать репертуар из мастер-партий 2400+».
 *
 * Defaults:
 *   - bucket=master
 *   - sort=topElo
 *   - minElo=2400
 *   - timeControlCategory=classical
 *   - color=any (передаём только если пришёл от клиента)
 *
 * Клиент может ПЕРЕОПРЕДЕЛИТЬ любой параметр в query (для дебага/
 * расширения), кроме того что мы не разрешаем гостям (auth выше).
 *
 * Без локальной валидации/нормализации — всё делает archive-service.
 */
import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import type {
  ArchiveGamesByPositionRequest,
  ArchiveGamesByPositionResponse,
} from '@kingside/shared';

/** Дефолт для service-to-service: docker-compose alias из ADR. */
const ARCHIVE_BASE_URL_DEFAULT = 'http://archive-service:3003';

/** Таймаут вызова archive-service. */
const FETCH_TIMEOUT_MS = 10_000;

@Injectable()
export class ArchivePositionProxyService {
  private readonly logger = new Logger(ArchivePositionProxyService.name);

  private get baseUrl(): string {
    return process.env.ARCHIVE_SERVICE_URL ?? ARCHIVE_BASE_URL_DEFAULT;
  }

  /**
   * Прокси к archive-service `/api/archive/games/by-position` с
   * KS-3469-defaults. Поля из `query` (fen, cursor, limit, color, move
   * и т.д.) — приоритетнее defaults; пустые поля → defaults.
   */
  async findGamesByPosition(
    query: ArchiveGamesByPositionRequest,
  ): Promise<ArchiveGamesByPositionResponse> {
    if (!query.fen || query.fen.trim() === '') {
      // Контракт: fen обязателен. Защита от пустого запроса со стороны фронта.
      throw new ServiceUnavailableException('fen is required');
    }

    const merged: ArchiveGamesByPositionRequest = {
      fen: query.fen,
      bucket: query.bucket ?? 'master',
      sort: query.sort ?? 'topElo',
      minElo: query.minElo ?? 2400,
      timeControlCategory: query.timeControlCategory ?? 'classical',
      // Остальные параметры передаём только если пришли — иначе пусть
      // archive-service применит свои defaults / отсутствие фильтра.
      ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
      ...(query.limit !== undefined ? { limit: query.limit } : {}),
      ...(query.color !== undefined ? { color: query.color } : {}),
      ...(query.result !== undefined ? { result: query.result } : {}),
      ...(query.since !== undefined ? { since: query.since } : {}),
      ...(query.move !== undefined ? { move: query.move } : {}),
      ...(query.player !== undefined ? { player: query.player } : {}),
      ...(query.eco !== undefined ? { eco: query.eco } : {}),
    };

    const url = new URL('/api/archive/games/by-position', this.baseUrl);
    appendQuery(url, merged);

    const startedAt = Date.now();
    let res: Response;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      try {
        res = await fetch(url.toString(), {
          method: 'GET',
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    } catch (err: unknown) {
      const msg = (err as Error).message ?? String(err);
      this.logger.error(
        `archive-service fetch failed: ${url.pathname} → ${msg}`,
      );
      throw new ServiceUnavailableException('archive-service unavailable');
    }

    if (!res.ok) {
      const text = await safeText(res);
      this.logger.error(
        `archive-service ${res.status} on ${url.pathname}: ${text.slice(0, 200)}`,
      );
      throw new ServiceUnavailableException(
        `archive-service error ${res.status}`,
      );
    }

    const body = (await res.json()) as ArchiveGamesByPositionResponse;
    const elapsed = Date.now() - startedAt;
    this.logger.log(
      `archive-position proxy ${elapsed}ms items=${body.items?.length ?? 0} hasMore=${body.hasMore}`,
    );
    return body;
  }
}

/** Сериализация query-параметров с массивом для timeControlCategory. */
function appendQuery(
  url: URL,
  req: ArchiveGamesByPositionRequest,
): void {
  const sp = url.searchParams;
  for (const [key, value] of Object.entries(req)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      // ?key=v1&key=v2 — Express парсит как массив.
      for (const v of value) sp.append(key, String(v));
    } else {
      sp.append(key, String(value));
    }
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}
