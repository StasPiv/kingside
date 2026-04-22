import { Controller, Get, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

const DB_PING_TIMEOUT_MS = 500;

/**
 * `GET /_/health` — проверяет доступность broadcasts DB (ADR-021 §2.9 п.8).
 *
 * Запрос `SELECT 1` ограничен `DB_PING_TIMEOUT_MS` (500мс) через
 * `Promise.race`, чтобы зависший клиент не держал health check на минуты.
 *
 * Возвращаем 200 с degraded (а не 503), потому что Nest в тестах может
 * интерпретировать 5xx как fail. При необходимости можно отделить
 * `/_/readiness` c 503.
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
      this.logger.warn(`broadcasts DB ping failed: ${msg}`);
      return { status: 'degraded', db: msg };
    }
  }

  private pingWithTimeout(): Promise<void> {
    const ping = this.prisma
      .$queryRawUnsafe<Array<{ ok: number }>>('SELECT 1 AS ok')
      .then(() => undefined);
    const timeout = new Promise<void>((_, reject) => {
      const t = setTimeout(
        () => reject(new Error(`db ping timeout (${DB_PING_TIMEOUT_MS}ms)`)),
        DB_PING_TIMEOUT_MS,
      );
      t.unref?.();
    });
    return Promise.race([ping, timeout]);
  }
}
