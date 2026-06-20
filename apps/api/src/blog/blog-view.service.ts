/**
 * KS-4469 / ADR-140 §2.2. Подсчёт просмотров статей блога.
 *
 * `POST /blog/posts/:id/view` идёт мимо CloudFront (на API-домен),
 * поэтому каждый реальный запрос фронта доходит до бэка. Сервис
 * решает: засчитывать просмотр или нет.
 *
 * Правила (см. ADR-140 §2.2):
 *   1. Антибот по UA — известные краулеры и CLI-клиенты 200 OK
 *      без инкремента (`counted=false`). Не отвечаем 4xx, чтобы не
 *      подсвечивать правило проверки.
 *   2. Origin/Referer должен указывать на `https://kingside.site`.
 *      Чужие источники (консоль стороннего сайта, прямой curl без
 *      origin) — тоже 200 OK без инкремента.
 *   3. Дедуп через Redis (`SET key 1 NX EX 86400`). Ключ:
 *      - авторизованный: `blog:view:<postId>:u:<userId>`.
 *      - гость:           `blog:view:<postId>:ip:<sha1(ip+\x00+ua)>`.
 *      UA в ключе — чтобы NAT'ы не схлопывали разных пользователей
 *      в одного. IP — чтобы один пользователь со сменой страницы
 *      на той же сессии считался один раз.
 *   4. Если ключ новый — атомарный `UPDATE views_count = views_count + 1`
 *      и `counted=true`. Если был — `counted=false`, возвращаем
 *      актуальный (текущий) `viewsCount` без изменения.
 *
 * Контракт ответа — `BlogViewResponse` (packages/shared).
 *
 * Источник правды просмотров — `blog_posts.views_count`; отдельной
 * таблицы со списком сессий просмотра в MVP нет (см. ADR §2.1).
 */

import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { createHash } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import type { BlogViewResponse } from '@kingside/shared';

/**
 * KS-4469. UA-фильтр для отсева краулеров и неинтерактивных
 * клиентов. Регистрозависимости нет (`i`). Список — основные
 * паттерны, которые в реальном трафике дают шум на счётчике; пополнять
 * по необходимости без миграций.
 */
const BOT_UA_RE = /bot|crawler|spider|curl|python-requests|wget|httpie/i;

/**
 * KS-4469. Допустимый источник запроса. Сравниваем строго префиксом
 * `https://kingside.site` + `/` либо равенством `https://kingside.site` —
 * это блокирует кейс `https://kingside.site.evil.com/`.
 */
const ALLOWED_ORIGIN = 'https://kingside.site';

/** Дедуп Redis-ключа: 24 часа. */
const VIEW_DEDUP_TTL_SEC = 24 * 60 * 60;

export interface ViewRequestContext {
  /** Идентификатор поста — UUID. */
  postId: string;
  /** Авторизованный userId или null (гость). */
  userId: string | null;
  /** IP клиента (best-effort: x-forwarded-for[0] / socket). */
  ip: string;
  /** User-Agent (пустая строка если не пришёл). */
  userAgent: string;
  /** Заголовок Origin (может отсутствовать). */
  origin: string | null;
  /** Заголовок Referer (может отсутствовать). */
  referer: string | null;
}

@Injectable()
export class BlogViewService {
  private readonly logger = new Logger(BlogViewService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  /**
   * Обрабатывает запрос на учёт просмотра. Возвращает `BlogViewResponse`
   * с актуальным `viewsCount` (после возможного инкремента) и флагом
   * `counted` — был ли реальный инкремент в этот вызов.
   */
  async registerView(ctx: ViewRequestContext): Promise<BlogViewResponse> {
    // 1) Проверка существования поста. Если нет — 404: иначе клиент
    //    может крутить счётчик по несуществующему id.
    const post = await this.prisma.blogPost.findUnique({
      where: { id: ctx.postId },
      select: { id: true, viewsCount: true },
    });
    if (!post) {
      throw new NotFoundException(`Blog post ${ctx.postId} not found`);
    }

    // 2) UA-фильтр ботов.
    if (this.looksLikeBot(ctx.userAgent)) {
      return { viewsCount: post.viewsCount, counted: false };
    }

    // 3) Origin/Referer должны указывать на kingside.site.
    if (!this.isAllowedSource(ctx.origin, ctx.referer)) {
      return { viewsCount: post.viewsCount, counted: false };
    }

    // 4) Дедуп через Redis.
    const dedupKey = this.makeDedupKey(ctx);
    let isNew = false;
    try {
      // `SET key 1 NX EX 86400`. Возвращает 'OK' если поставил, null если был.
      const result = await this.redis.set(
        dedupKey,
        '1',
        'EX',
        VIEW_DEDUP_TTL_SEC,
        'NX',
      );
      isNew = result === 'OK';
    } catch (e) {
      // Fail-open по образцу RedisRateLimitGuard: если Redis недоступен,
      // не считаем (`counted=false`). Альтернатива «считать всегда»
      // открывает дверь накрутке при потере Redis.
      this.logger.warn(
        `Redis dedup failed for ${ctx.postId}: ${(e as Error).message}`,
      );
      return { viewsCount: post.viewsCount, counted: false };
    }

    if (!isNew) {
      return { viewsCount: post.viewsCount, counted: false };
    }

    // 5) Атомарный инкремент. Prisma `increment` транслируется в
    //    `UPDATE blog_posts SET views_count = views_count + 1` — не
    //    зависит от прочитанного выше значения и не страдает от
    //    гонок с параллельным инкрементом.
    const updated = await this.prisma.blogPost.update({
      where: { id: ctx.postId },
      data: { viewsCount: { increment: 1 } },
      select: { viewsCount: true },
    });
    return { viewsCount: updated.viewsCount, counted: true };
  }

  /** UA попадает под bot-паттерн или строка пустая. */
  private looksLikeBot(ua: string): boolean {
    if (!ua) return true;
    return BOT_UA_RE.test(ua);
  }

  /**
   * Хотя бы один из (Origin, Referer) должен соответствовать
   * `https://kingside.site` или быть его поддиректорией. Пустые оба —
   * чужой источник.
   */
  private isAllowedSource(
    origin: string | null,
    referer: string | null,
  ): boolean {
    const candidates = [origin, referer].filter(
      (v): v is string => typeof v === 'string' && v.length > 0,
    );
    if (candidates.length === 0) return false;
    for (const v of candidates) {
      if (v === ALLOWED_ORIGIN) return true;
      if (v.startsWith(ALLOWED_ORIGIN + '/')) return true;
    }
    return false;
  }

  /**
   * Ключ дедупа. Для авторизованного — стабилен по userId, для гостя —
   * sha1(ip+\x00+ua). Разделитель `\x00` нужен, чтобы пары `('1.2.3.4',
   * 'Foo')` и `('1.2.3.4F', 'oo')` не давали один и тот же ключ.
   */
  private makeDedupKey(ctx: ViewRequestContext): string {
    if (ctx.userId) {
      return `blog:view:${ctx.postId}:u:${ctx.userId}`;
    }
    const fingerprint = createHash('sha1')
      .update(`${ctx.ip}\x00${ctx.userAgent}`)
      .digest('hex');
    return `blog:view:${ctx.postId}:ip:${fingerprint}`;
  }
}
