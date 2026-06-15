/**
 * KS-4227. Разовая переиндексация sub-broadcast сущностей
 * (coaches, lectures, players, tournaments) для prerender'а. KS-4221
 * закрыл только broadcasts через `apps/broadcast-service`; остальные
 * сущности живут в `apps/api` и берут данные напрямую из основной
 * БД через `PrismaService`.
 *
 * Аутентификация — `X-Admin-Token: <BROADCAST_ADMIN_TOKEN>` (тот же
 * env, что в KS-4221, прописан в `kingside-api` ревизия 532). Без env —
 * 503; с неверным токеном — 403. Эндпоинт защищён от случайного
 * вызова, но сам факт его наличия публично известен.
 *
 * Выборки повторяют логику `SitemapService.generate*Xml` (KS-4209) —
 * структурно та же фильтрация. Партии (`gid`) у трансляций не
 * перебираются: их закрыл KS-4221, плюс mutation hook KS-4208.
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

/** §7.10: окно «свежих» tournaments — 12 месяцев. */
const TWELVE_MONTHS_MS = 12 * 30 * 24 * 60 * 60 * 1000;

@Controller('admin/prerender/reindex')
export class ReindexAllController {
  private readonly logger = new Logger(ReindexAllController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly prerender: PrerenderEnqueueService,
    private readonly config: ConfigService,
  ) {}

  @Post('all')
  async reindexAll(
    @Headers('x-admin-token') token: string | undefined,
  ): Promise<{
    coaches: number;
    lectures: number;
    tournaments: number;
    players: number;
    lists: number;
    tasks: number;
    sent: number;
  }> {
    this.assertAuth(token);

    const since = new Date(Date.now() - TWELVE_MONTHS_MS);

    // ─── Lectures ───────────────────────────────────────────────────
    const lectures = await this.prisma.lecture.findMany({
      where: {
        visibility: 'public',
        status: { in: ['scheduled', 'live', 'recorded'] },
      },
      select: { id: true },
    });

    // ─── Coaches (distinct ownerId публичных лекций) ───────────────
    // Сам coach публикуется как /coaches/:username (см.
    // resolvePrerenderRoute в shared). Те же критерии, что для
    // sitemap-coaches.xml в KS-4209.
    const coachRows = (await this.prisma.$queryRawUnsafe<
      Array<{ username: string }>
    >(
      `SELECT DISTINCT u.username
       FROM users u
       JOIN lectures l ON l.owner_id = u.id
       WHERE l.visibility = 'public'
         AND u.username IS NOT NULL
         AND u.is_hidden = false
       LIMIT 50000`,
    )) ?? [];

    // ─── Tournaments (arena) за 12 мес ─────────────────────────────
    const tournaments = await this.prisma.arenaTournament.findMany({
      where: { createdAt: { gte: since } },
      select: { id: true },
      take: 50_000,
    });

    // ─── Players (top-1000 по ratingBlitz) ─────────────────────────
    const players = await this.prisma.user.findMany({
      where: {
        username: { not: null },
        isHidden: false,
        isBot: false,
        isSynthetic: false,
      },
      orderBy: { ratingBlitz: 'desc' },
      take: 1000,
      select: { username: true },
    });

    // ─── Сборка задач ──────────────────────────────────────────────
    const tasks: PrerenderTask[] = [];
    for (const c of coachRows) {
      tasks.push({ kind: 'coach', username: c.username });
    }
    for (const l of lectures) {
      tasks.push({ kind: 'lecture', id: l.id });
    }
    for (const t of tournaments) {
      tasks.push({ kind: 'tournament', id: t.id });
    }
    for (const p of players) {
      if (!p.username) continue;
      tasks.push({ kind: 'player', username: p.username });
    }
    // Lists — `/broadcasts` и `/archive` уже отправлены в KS-4221 /
    // sitemap-cron, остальное добавляем здесь.
    tasks.push({ kind: 'list', route: '/tournaments' });
    tasks.push({ kind: 'list', route: '/lectures' });
    tasks.push({ kind: 'list', route: '/players' });

    const counts = {
      coaches: coachRows.length,
      lectures: lectures.length,
      tournaments: tournaments.length,
      players: players.filter((p) => p.username).length,
      lists: 3,
    };
    this.logger.log(
      `[reindex-all] enqueueing ${tasks.length} prerender tasks: ` +
        `coaches=${counts.coaches} lectures=${counts.lectures} ` +
        `tournaments=${counts.tournaments} players=${counts.players} ` +
        `lists=${counts.lists}`,
    );
    const { sent } = await this.prerender.enqueueBatch(tasks);
    this.logger.log(
      `[reindex-all] done: sent=${sent} of ${tasks.length} (0=client disabled)`,
    );
    return { ...counts, tasks: tasks.length, sent };
  }

  private assertAuth(token: string | undefined): void {
    const expected = this.config.get<string>('BROADCAST_ADMIN_TOKEN');
    if (!expected || !expected.trim()) {
      this.logger.error(
        '[reindex-all] BROADCAST_ADMIN_TOKEN is not configured — endpoint disabled',
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
