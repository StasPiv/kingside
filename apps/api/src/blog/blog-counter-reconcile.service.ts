/**
 * KS-4473 / ADR-140 T7. Суточный пересчёт денормализованных счётчиков
 * `blog_posts.likes_count` и `blog_posts.comments_count` из COUNT(*)
 * детальных таблиц.
 *
 * Зачем: T3..T5 поддерживают счётчики в реальном времени транзакциями
 * (`+1` при INSERT, `-1` при soft-delete с GREATEST). Но дрейф
 * возможен:
 *   - Транзакция оборвалась между `INSERT comment` и `UPDATE counter`
 *     (Prisma откатит обе, но между разными процессами/ошибками
 *     теоретически возможен дрейф).
 *   - Прямые правки БД (миграции, recovery, ручные UPDATE).
 *   - Будущее изменение кода — забыли поддержать счётчик.
 * Cron — компенсаторный пояс безопасности; источник правды
 * остаётся в `blog_post_likes` / `blog_post_comments`.
 *
 * `views_count` не пересчитываем: нет «детальной» таблицы со списком
 * просмотров (см. ADR-140 §2.2 — дедуп в Redis, без журнала).
 *
 * Алгоритм:
 *   1. Получаем id всех опубликованных постов батчами по 100
 *      (через `findMany(skip, take)` с упорядочением по id).
 *   2. На батч — один RAW SQL с CTE: для каждого id считаем актуальные
 *      `likes_count` и `comments_count` (deleted_at IS NULL) и
 *      сравниваем с текущими значениями в `blog_posts`. Возвращаем
 *      только дрейфующие строки.
 *   3. Для дрейфующих — `UPDATE blog_posts SET likes_count=$, comments_count=$`
 *      ровно по этим id (одна UPDATE из CTE с VALUES не дешевле, чем
 *      по одному `update` Prisma'й — у нас расхождений мало).
 *   4. В лог: `processed` (всего постов), `mismatched` (с дрейфом),
 *      `updated` (успешно записано).
 *
 * Пакеты по 100 — компромисс между «не блокировать БД на длительное
 * IN-сравнение для тысяч id» и «не делать тысячи мелких запросов».
 */

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/** Размер пакета постов на один SQL-проход. */
const BATCH_SIZE = 100;

export interface BlogReconcileSummary {
  processed: number;
  mismatched: number;
  updated: number;
  tookMs: number;
}

interface DriftRow {
  id: string;
  expected_likes: number;
  expected_comments: number;
  current_likes: number;
  current_comments: number;
}

@Injectable()
export class BlogCounterReconcileService {
  private readonly logger = new Logger(BlogCounterReconcileService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Пересчитать счётчики для всех опубликованных постов. Возвращает
   * summary; логирует прогресс и итог.
   */
  async reconcileAll(): Promise<BlogReconcileSummary> {
    const start = Date.now();
    let processed = 0;
    let mismatched = 0;
    let updated = 0;

    // Идём по постам пакетами. Берём только id — нагрузка минимальна.
    // Считаем `published`, потому что эндпоинты вовлечённости работают
    // только с ними; черновики счётчики не показывают.
    for (let skip = 0; ; skip += BATCH_SIZE) {
      const batch = await this.prisma.blogPost.findMany({
        where: { status: 'published' },
        select: { id: true },
        orderBy: { id: 'asc' },
        skip,
        take: BATCH_SIZE,
      });
      if (batch.length === 0) break;
      processed += batch.length;

      const ids = batch.map((p) => p.id);
      const drifted = await this.findDrift(ids);
      mismatched += drifted.length;

      for (const row of drifted) {
        try {
          await this.prisma.blogPost.update({
            where: { id: row.id },
            data: {
              likesCount: row.expected_likes,
              commentsCount: row.expected_comments,
            },
          });
          updated += 1;
          this.logger.warn(
            `reconcile drift fixed post=${row.id} likes ${row.current_likes}→${row.expected_likes} comments ${row.current_comments}→${row.expected_comments}`,
          );
        } catch (e) {
          // Один битый UPDATE не должен останавливать остальные.
          this.logger.error(
            `reconcile UPDATE failed for post=${row.id}: ${(e as Error).message}`,
          );
        }
      }
    }

    const tookMs = Date.now() - start;
    const summary: BlogReconcileSummary = {
      processed,
      mismatched,
      updated,
      tookMs,
    };
    this.logger.log(
      `reconcile done: processed=${processed}, mismatched=${mismatched}, updated=${updated}, tookMs=${tookMs}`,
    );
    return summary;
  }

  /**
   * Для пакета `postIds` вернуть строки с дрейфом — где денормализованный
   * счётчик расходится с реальным COUNT(*). Один RAW SQL для всего
   * пакета — экономит round-trips. Возвращаемые числа приведены к
   * `number` через `::int`.
   *
   * SQL устойчив к постам без лайков/комментариев: LEFT JOIN +
   * COALESCE гарантируют 0, а не NULL.
   */
  private async findDrift(postIds: string[]): Promise<DriftRow[]> {
    if (postIds.length === 0) return [];
    // Используем `::uuid[]` каст с `ANY(...)` для типизации.
    return this.prisma.$queryRawUnsafe<DriftRow[]>(
      `WITH like_counts AS (
         SELECT post_id, COUNT(*)::int AS c
         FROM blog_post_likes
         WHERE post_id = ANY($1::uuid[])
         GROUP BY post_id
       ),
       comment_counts AS (
         SELECT post_id, COUNT(*)::int AS c
         FROM blog_post_comments
         WHERE post_id = ANY($1::uuid[]) AND deleted_at IS NULL
         GROUP BY post_id
       )
       SELECT bp.id,
              COALESCE(lc.c, 0)::int   AS expected_likes,
              COALESCE(cc.c, 0)::int   AS expected_comments,
              bp.likes_count::int      AS current_likes,
              bp.comments_count::int   AS current_comments
       FROM blog_posts bp
       LEFT JOIN like_counts    lc ON lc.post_id = bp.id
       LEFT JOIN comment_counts cc ON cc.post_id = bp.id
       WHERE bp.id = ANY($1::uuid[])
         AND (
           bp.likes_count    <> COALESCE(lc.c, 0) OR
           bp.comments_count <> COALESCE(cc.c, 0)
         )`,
      postIds,
    );
  }
}
