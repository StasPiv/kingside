/**
 * KS-4221. Разовый admin-эндпоинт для batch-переиндексации всех
 * трансляций (активные + завершённые за 12 мес). После закрытия
 * KS-4213 (frontend per-entity SeoHelmet для broadcasts) старые S3-
 * снимки висят с общими метатегами «Kingside» — нужно прогнать всё
 * через очередь, чтобы prerender-воркер обновил каждый URL.
 *
 * Аутентификация: статический токен в env `BROADCAST_ADMIN_TOKEN`,
 * сравнивается с заголовком `X-Admin-Token`. Если env не задан —
 * эндпоинт возвращает 503: без токена опасно открывать наружу.
 *
 * Сама задача поставленных URL:
 *   - `{kind:'broadcast', tid}` — карточка турнира.
 *   - `{kind:'broadcast', tid, rid}` — каждый раунд.
 *   - `{kind:'list', route:'/broadcasts'}` — один раз.
 *
 * Партии (`gid`) не реиндексируем в этом проходе: для активных
 * раундов это десятки тысяч URL'ов, риск SQS-throttling. Финальные
 * HTML партий обновятся точечно — через mutation hook KS-4208 при
 * следующем обновлении PGN, либо отдельным batch'ем потом.
 */

import {
  Controller,
  Headers,
  HttpException,
  HttpStatus,
  Logger,
  Post,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { PrerenderTask } from '@kingside/shared';
import { PrismaService } from '../prisma/prisma.service';
import { PrerenderEnqueueService } from '../prerender/prerender-enqueue.service';

const TWELVE_MONTHS_MS = 12 * 30 * 24 * 60 * 60 * 1000;

@Controller('admin/prerender/reindex')
export class ReindexBroadcastsController {
  private readonly logger = new Logger(ReindexBroadcastsController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly prerender: PrerenderEnqueueService,
    private readonly config: ConfigService,
  ) {}

  @Post('broadcasts')
  async reindexBroadcasts(
    @Headers('x-admin-token') token: string | undefined,
  ): Promise<{
    broadcasts: number;
    rounds: number;
    tasks: number;
    sent: number;
  }> {
    this.assertAuth(token);

    const since = new Date(Date.now() - TWELVE_MONTHS_MS);

    // Все трансляции за окно. У `broadcasts` нет explicit-status
    // active/finished — берём через updatedAt окно (12 мес), это
    // совпадает с sitemap-логикой (KS-4209). Если в будущем появится
    // archived-флаг — добавить сюда.
    const broadcasts = await this.prisma.broadcast.findMany({
      where: { updatedAt: { gte: since } },
      select: { id: true },
    });

    const rounds = await this.prisma.broadcastRound.findMany({
      where: {
        updatedAt: { gte: since },
        // Skip явно отменённые — у нас status='cancelled' в схеме нет,
        // но 'failed' встречается. Их тоже индексируем — это не
        // спам, страница всё равно публична.
      },
      select: { id: true, broadcastId: true },
    });

    const tasks: PrerenderTask[] = [];
    for (const b of broadcasts) {
      tasks.push({ kind: 'broadcast', tid: b.id });
    }
    for (const r of rounds) {
      tasks.push({ kind: 'broadcast', tid: r.broadcastId, rid: r.id });
    }
    tasks.push({ kind: 'list', route: '/broadcasts' });

    this.logger.log(
      `[reindex] enqueueing ${tasks.length} prerender tasks (broadcasts=${broadcasts.length}, rounds=${rounds.length})`,
    );
    const { sent } = await this.prerender.enqueueBatch(tasks);
    this.logger.log(
      `[reindex] done: sent=${sent} of ${tasks.length} (0=client disabled)`,
    );
    return {
      broadcasts: broadcasts.length,
      rounds: rounds.length,
      tasks: tasks.length,
      sent,
    };
  }

  private assertAuth(token: string | undefined): void {
    const expected = this.config.get<string>('BROADCAST_ADMIN_TOKEN');
    if (!expected || !expected.trim()) {
      this.logger.error(
        '[reindex] BROADCAST_ADMIN_TOKEN is not configured — endpoint disabled',
      );
      throw new HttpException(
        'admin endpoint is not configured (BROADCAST_ADMIN_TOKEN missing)',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    if (!token || token !== expected) {
      throw new HttpException('forbidden', HttpStatus.FORBIDDEN);
    }
  }
}
