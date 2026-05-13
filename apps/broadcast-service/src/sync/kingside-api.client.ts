/**
 * KS-2883 / ADR-060 §3.7 B10. HTTP-клиент broadcast-service → api для
 * управления broadcast-зеркалом студии.
 *
 * Эндпоинты (под `X-Internal-Auth`, см. apps/api InternalKeyGuard):
 *  - `POST /api/studies/from-broadcast-round` `{roundId}`
 *      → `{studyId, slug, chapterIds}` (409 если зеркало уже есть).
 *  - `POST /api/studies/sync-broadcast-round` `{roundId}`
 *      → `{studyId, slug, updatedChapters, createdChapters}` (404 если нет).
 *
 * Debounce 30s для `syncMirror`:
 *  - in-memory `Map<roundId, NodeJS.Timeout>`;
 *  - повторный вызов в окне 30s заменяет таймер (последний выигрывает);
 *  - при срабатывании выполняется HTTP-запрос и таймер удаляется.
 *
 * Auth между сервисами — общий `SYNTHETIC_BOT_INTERNAL_KEY` из env
 * (тот же, что использует api для своего `InternalKeyGuard`). База URL
 * api — `KINGSIDE_API_URL` (например `http://api:3001` в кластере).
 */
import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { INTERNAL_AUTH_HEADER } from '@kingside/shared';

export interface FromBroadcastRoundResponse {
  studyId: string;
  slug: string;
  chapterIds: string[];
}

export interface SyncBroadcastRoundResponse {
  studyId: string;
  slug: string;
  updatedChapters: number;
  createdChapters: number;
}

export const DEFAULT_SYNC_DEBOUNCE_MS = 30_000;

/**
 * Опции внедрения для тестов — позволяют переопределить debounce и
 * fetch-функцию без monkey-patch'а глобального `fetch`.
 */
export interface KingsideApiClientOptions {
  debounceMs?: number;
  fetchFn?: typeof fetch;
}

export const KINGSIDE_API_CLIENT_OPTIONS = 'KINGSIDE_API_CLIENT_OPTIONS';

@Injectable()
export class KingsideApiClient implements OnModuleDestroy {
  private readonly logger = new Logger(KingsideApiClient.name);
  private readonly debouncers = new Map<string, NodeJS.Timeout>();
  private readonly debounceMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(
    private readonly config: ConfigService,
    @Optional()
    @Inject(KINGSIDE_API_CLIENT_OPTIONS)
    options?: KingsideApiClientOptions,
  ) {
    this.debounceMs = options?.debounceMs ?? DEFAULT_SYNC_DEBOUNCE_MS;
    this.fetchFn = options?.fetchFn ?? fetch;
  }

  /** Гарантированно очистить таймеры при остановке (тесты + graceful shutdown). */
  onModuleDestroy(): void {
    for (const t of this.debouncers.values()) clearTimeout(t);
    this.debouncers.clear();
  }

  /**
   * Создать зеркало раунда. Без debounce — событие «новый раунд с
   * mirrorToStudy=true» приходит редко и должно отрабатывать сразу.
   *
   * Возвращает null при 409 (зеркало уже есть) — caller использует это
   * как сигнал «нужно вызвать sync вместо create» либо пометить
   * `mirroredStudySlug` другим путём.
   */
  async createMirror(roundId: string): Promise<FromBroadcastRoundResponse | null> {
    try {
      const res = await this.post('/api/studies/from-broadcast-round', { roundId });
      if (res.status === 409) return null;
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(
          `api /from-broadcast-round ${res.status}: ${body.slice(0, 200)}`,
        );
      }
      return (await res.json()) as FromBroadcastRoundResponse;
    } catch (e: unknown) {
      this.logger.error(
        `createMirror(${roundId}) failed: ${(e as Error).message}`,
      );
      throw e;
    }
  }

  /**
   * Запросить sync с debounce 30s.
   *
   * Семантика «trailing edge»: первый вызов запускает таймер;
   * последующие вызовы в окне сбрасывают таймер; HTTP-запрос
   * выполняется один раз — после тишины длительностью `debounceMs`.
   */
  scheduleSync(roundId: string): void {
    const existing = this.debouncers.get(roundId);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => {
      this.debouncers.delete(roundId);
      void this.flushSync(roundId).catch((e) =>
        this.logger.warn(
          `scheduleSync(${roundId}) flush failed: ${(e as Error).message}`,
        ),
      );
    }, this.debounceMs);
    // Не блокировать выход процесса из-за оставшихся таймеров.
    if (typeof (t as NodeJS.Timeout & { unref?: () => void }).unref === 'function') {
      (t as NodeJS.Timeout & { unref?: () => void }).unref?.();
    }
    this.debouncers.set(roundId, t);
  }

  /**
   * Принудительный sync без debounce (для тестов и для повторного
   * прохода после отказа в `createMirror`).
   */
  async flushSync(roundId: string): Promise<SyncBroadcastRoundResponse | null> {
    const existing = this.debouncers.get(roundId);
    if (existing) {
      clearTimeout(existing);
      this.debouncers.delete(roundId);
    }
    const res = await this.post('/api/studies/sync-broadcast-round', { roundId });
    if (res.status === 404) {
      // Зеркало не существует — caller (broadcast-sync) должен сначала
      // вызвать createMirror. Тихий null чтобы не флудить логи warn'ом.
      this.logger.warn(
        `flushSync(${roundId}): mirror not found (404) — call createMirror first`,
      );
      return null;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(
        `api /sync-broadcast-round ${res.status}: ${body.slice(0, 200)}`,
      );
    }
    return (await res.json()) as SyncBroadcastRoundResponse;
  }

  /** Внутренний POST с заголовком X-Internal-Auth. */
  private async post(path: string, body: unknown): Promise<Response> {
    const baseUrl =
      this.config.get<string>('KINGSIDE_API_URL') ??
      process.env.KINGSIDE_API_URL;
    if (!baseUrl) {
      throw new Error('KINGSIDE_API_URL is not configured');
    }
    const key =
      this.config.get<string>('SYNTHETIC_BOT_INTERNAL_KEY') ??
      process.env.SYNTHETIC_BOT_INTERNAL_KEY;
    if (!key) {
      throw new Error('SYNTHETIC_BOT_INTERNAL_KEY is not configured');
    }
    return await this.fetchFn(`${baseUrl.replace(/\/$/, '')}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [INTERNAL_AUTH_HEADER]: key,
      },
      body: JSON.stringify(body),
    });
  }
}
