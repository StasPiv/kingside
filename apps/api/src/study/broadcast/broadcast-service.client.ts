/**
 * KS-2884 / ADR-060 §3.7 B11. HTTP-клиент к `apps/broadcast-service`.
 *
 * Контракт (фиксируется B11; B10 имплементирует серверную сторону):
 *   - `GET {BROADCAST_SERVICE_URL}/internal/rounds/:roundId/with-games`
 *   - Header `X-Internal-Auth: <SYNTHETIC_BOT_INTERNAL_KEY>` (общий
 *     shared-secret между api и сервис-сервис коммуникацией — паттерн
 *     `InternalKeyGuard`, KS-2182).
 *   - Response 200: `{ round: {id, name}, games: BroadcastGameDto[] }`.
 *   - 404 если round не найден.
 *
 * Текущая api ↔ broadcast-service коммуникация шла только в обратную
 * сторону (broadcast-service → ничего, api читала свою копию таблиц).
 * После выноса broadcast-models в отдельную БД (ADR-021 §2.1) у api
 * прямого доступа нет — поэтому клиент.
 */
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface BroadcastRoundDto {
  id: string;
  name: string;
}

export interface BroadcastGameDto {
  id: string;
  pgn: string;
  whitePlayer: string | null;
  blackPlayer: string | null;
  result: string | null;
}

export interface BroadcastRoundWithGames {
  round: BroadcastRoundDto;
  games: BroadcastGameDto[];
}

@Injectable()
export class BroadcastServiceClient {
  private readonly logger = new Logger(BroadcastServiceClient.name);

  constructor(private readonly config: ConfigService) {}

  /**
   * Получить раунд с играми. Используется для создания и синхронизации
   * broadcast-зеркала.
   *
   * Ошибки:
   *  - 404 NotFoundException — round не найден в broadcast-service;
   *  - Error — конфигурация не задана или transport-проблема.
   */
  async getRoundWithGames(roundId: string): Promise<BroadcastRoundWithGames> {
    const baseUrl =
      this.config.get<string>('BROADCAST_SERVICE_URL') ??
      process.env.BROADCAST_SERVICE_URL;
    if (!baseUrl) {
      throw new Error('BROADCAST_SERVICE_URL is not configured');
    }
    const key =
      this.config.get<string>('SYNTHETIC_BOT_INTERNAL_KEY') ??
      process.env.SYNTHETIC_BOT_INTERNAL_KEY;
    if (!key) {
      throw new Error('SYNTHETIC_BOT_INTERNAL_KEY is not configured');
    }

    const url = `${baseUrl.replace(/\/$/, '')}/internal/rounds/${encodeURIComponent(roundId)}/with-games`;
    const res = await fetch(url, {
      headers: { 'X-Internal-Auth': key },
    });
    if (res.status === 404) {
      throw new NotFoundException(`Broadcast round ${roundId} not found`);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      this.logger.error(
        `broadcast-service ${url} ${res.status}: ${body.slice(0, 200)}`,
      );
      throw new Error(
        `broadcast-service returned ${res.status} for round ${roundId}`,
      );
    }
    return (await res.json()) as BroadcastRoundWithGames;
  }
}
