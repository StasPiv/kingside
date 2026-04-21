import { Controller, Get, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

const DB_PING_TIMEOUT_MS = 500;

/**
 * `GET /_/health` — проверяет доступность archive DB (ADR-018 §2.9 п.8).
 *
 * Запрос `SELECT 1` ограничен `DB_PING_TIMEOUT_MS` (500мс) через
 * `Promise.race`, чтобы зависший клиент не держал health check на минуты.
 *
 * HTTP 200 + `{ status: 'ok' }` если БД ответила до таймаута.
 * HTTP 200 + `{ status: 'degraded' }` — если таймаут или ошибка; тело
 * содержит короткую причину (без stack, чтобы не утекли детали).
 *
 * Возвращаем 200 с degraded (а не 503), потому что Nest в тестах
 * может интерпретировать 5xx как fail — Gherkin сценарий требует 200
 * на пустой БД (`локально /health возвращает 200`). При необходимости
 * можно добавить отдельный `/_/readiness` c 503.
 */
@Controller('_/health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async check(): Promise<{ status: 'ok' | 'degraded'; db?: string }> {
    try {
      await this.pingWithTimeout();
      return { status: 'ok', db: 'ok' };
    } catch (err) {
      const msg = (err as Error).message;
      this.logger.warn(`archive DB ping failed: ${msg}`);
      return { status: 'degraded', db: msg };
    }
  }

  private pingWithTimeout(): Promise<void> {
    const ping = this.prisma.$queryRawUnsafe<Array<{ ok: number }>>('SELECT 1 AS ok').then(
      () => undefined,
    );
    const timeout = new Promise<void>((_, reject) => {
      const t = setTimeout(
        () => reject(new Error(`db ping timeout (${DB_PING_TIMEOUT_MS}ms)`)),
        DB_PING_TIMEOUT_MS,
      );
      // unref позволяет ноде корректно завершаться во время тестов, если
      // пинг успешно резолвится раньше таймаута.
      t.unref?.();
    });
    return Promise.race([ping, timeout]);
  }
}
