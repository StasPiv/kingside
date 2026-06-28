/**
 * KS-4750 / ADR-149 G4. HTTP-клиент для эмита actor-событий из
 * apps/game-service в apps/api (`POST /internal/events`).
 *
 * Контракт совпадает с `apps/api/src/events/events.service.ts:track`:
 * передаём `(actor, type, payload, ts?)`. Дальше apps/api прокидывает
 * это в `EventsService.track` — гарантируя, что все listeners
 * (HintsEngine, smart-dismiss observer) видят события одинаково,
 * независимо от того, из какого процесса они пришли.
 *
 * Конфиг:
 *   - `INTERNAL_EVENTS_URL` — URL endpoint'а (по умолчанию
 *     `http://api.internal:3001/internal/events`).
 *   - `INTERNAL_EVENTS_SECRET` — общий секрет HMAC с apps/api.
 *
 * Поведение:
 *   - Если secret не задан — `track` no-op (warn один раз на старте).
 *     Это нужно, чтобы dev-инстанс без интеграции с api не падал.
 *   - HTTP-ошибка / network-ошибка — log.warn + проглатываем. Игровая
 *     операция не должна падать из-за track'а (точно как `events.track`
 *     в apps/api fail-soft в Redis).
 */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { createHmac } from 'crypto';
import {
  type Actor,
  type EventPayload,
  type InternalEventInput,
  isValidActor,
  isValidEventType,
  serializePayload,
} from '@kingside/events-client';

const DEFAULT_URL = 'http://api.internal:3001/internal/events';
const REQUEST_TIMEOUT_MS = 2000;

@Injectable()
export class EventsClientService implements OnModuleInit {
  private readonly logger = new Logger(EventsClientService.name);
  private url = DEFAULT_URL;
  private secret: string | null = null;

  onModuleInit(): void {
    this.url = process.env.INTERNAL_EVENTS_URL || DEFAULT_URL;
    this.secret = process.env.INTERNAL_EVENTS_SECRET || null;
    if (!this.secret) {
      this.logger.warn(
        'INTERNAL_EVENTS_SECRET not set — track() will be no-op '
          + '(dev mode). Set the env-var to enable cross-service event emit.',
      );
    } else {
      this.logger.log(`EventsClient ready: POST ${this.url}`);
    }
  }

  /**
   * Эмит одного события. Не бросает наружу — сетевые/HTTP ошибки
   * логируются как warning. Подпись считается по тому же JSON-телу,
   * которое уходит в POST (важно: stringify должен быть идентичен
   * у обеих сторон — поэтому используем `JSON.stringify(body)`, не
   * подсчёт по полям).
   */
  async track(
    actor: Actor,
    type: string,
    payload: EventPayload,
    occurredAt?: Date,
  ): Promise<void> {
    if (!this.secret) return;
    if (!isValidActor(actor) || !isValidEventType(type)) {
      this.logger.warn(
        `track: skip invalid (actor.type=${String((actor as any)?.type)}, type=${String(type)})`,
      );
      return;
    }

    const body: InternalEventInput = {
      actor,
      type,
      payload: payload ?? null,
      ...(occurredAt ? { ts: occurredAt.toISOString() } : {}),
    };
    // Сериализуем именно тело — чтобы подпись считалась по точно тому,
    // что уйдёт по сети. serializePayload использовать нельзя: он для
    // payload-поля, не для целого body.
    const json = JSON.stringify(body);
    const signature = createHmac('sha256', this.secret).update(json).digest('hex');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(this.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Signature': signature,
        },
        body: json,
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        this.logger.warn(
          `POST /internal/events ${res.status}: ${text.slice(0, 200)} (type=${type})`,
        );
      }
    } catch (e: any) {
      this.logger.warn(
        `POST /internal/events failed (type=${type}): ${e?.message ?? e}`,
      );
    } finally {
      clearTimeout(timer);
    }
    // Подавление неиспользуемых импортов (export tree-shaking friendly):
    void serializePayload;
  }

  /**
   * Хелпер для эмита по обоим игрокам, исключая bot. Аналог
   * `GameService.trackBoth` в apps/api. Для `game_end` payload надо
   * отличать per-actor (`result`, `rating_delta`) — этот метод
   * подходит только для событий с одинаковым payload (например,
   * game_start).
   */
  trackBothExcludingBot(
    whiteId: string,
    blackId: string,
    botId: string,
    type: string,
    payload: Record<string, unknown>,
  ): void {
    if (whiteId && whiteId !== botId) {
      void this.track({ type: 'user', id: whiteId }, type, { ...payload, color: 'white' });
    }
    if (blackId && blackId !== botId) {
      void this.track({ type: 'user', id: blackId }, type, { ...payload, color: 'black' });
    }
  }
}
