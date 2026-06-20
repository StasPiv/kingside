/**
 * KS-4470 / ADR-140 T4. Лайки статей блога — идемпотентные `POST` и
 * `DELETE`. Источник правды — таблица `blog_post_likes` (PK
 * (post_id, user_id)), денормализованный счётчик — `blog_posts.likes_count`.
 *
 * Контракты:
 *   - `like(postId, userId)`:
 *       INSERT … ON CONFLICT DO NOTHING RETURNING — если строка была
 *       новой, в той же транзакции `UPDATE likes_count = likes_count + 1`.
 *       Повтор не инкрементит; возвращаемый `likesCount` — актуальный.
 *       `likedByMe=true` всегда после успешного вызова: если строка
 *       только что вставлена — лайк есть; если уже была — тоже есть.
 *   - `unlike(postId, userId)`:
 *       DELETE … RETURNING — если строка удалилась, в той же
 *       транзакции `UPDATE likes_count = GREATEST(likes_count - 1, 0)`.
 *       Повтор не декрементит; защита от ухода в минус — на уровне
 *       SQL через `GREATEST`. `likedByMe=false` всегда после успешного
 *       вызова.
 *
 * Транзакция обязательна: ситуация «строку вставили, счётчик не
 * успели обновить» оставит дрейф, который T7-cron потом выправит, но
 * клиент в этом запросе получит инкорректный `likesCount` от первого
 * UPDATE. Транзакция гарантирует пару «delta-таблица + delta-счётчик»
 * атомарно.
 *
 * 404 — если поста нет: до начала транзакции делаем `findUnique` по
 * id; иначе INSERT упадёт на foreign-key, что не отличишь от других
 * P-ошибок без `try/catch` по коду.
 */

import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { BlogLikeResponse } from '@kingside/shared';

@Injectable()
export class BlogLikeService {
  private readonly logger = new Logger(BlogLikeService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Поставить лайк. Идемпотентно: повторный вызов того же пользователя
   * по тому же посту возвращает текущий `likesCount` без инкремента.
   */
  async like(postId: string, userId: string): Promise<BlogLikeResponse> {
    await this.ensurePostExists(postId);

    const likesCount = await this.prisma.$transaction(async (tx) => {
      // INSERT … ON CONFLICT DO NOTHING RETURNING post_id.
      // Если PK (post_id, user_id) уже занят — RETURNING вернёт 0 строк.
      const inserted = await tx.$queryRawUnsafe<Array<{ post_id: string }>>(
        `INSERT INTO blog_post_likes (post_id, user_id)
         VALUES ($1::uuid, $2::uuid)
         ON CONFLICT (post_id, user_id) DO NOTHING
         RETURNING post_id`,
        postId,
        userId,
      );

      if (inserted.length === 0) {
        // No-op: лайк уже был. Возвращаем текущий счётчик без апдейта.
        return this.readLikesCount(tx, postId);
      }

      // Атомарный инкремент в той же транзакции.
      const rows = await tx.$queryRawUnsafe<Array<{ likes_count: number }>>(
        `UPDATE blog_posts
         SET likes_count = likes_count + 1
         WHERE id = $1::uuid
         RETURNING likes_count`,
        postId,
      );
      return rows[0]?.likes_count ?? 0;
    });

    return { likesCount, likedByMe: true };
  }

  /**
   * Снять лайк. Идемпотентно: повторный вызов того же пользователя по
   * тому же посту возвращает текущий `likesCount` без декремента.
   * Счётчик не уходит в минус (`GREATEST(likes_count - 1, 0)`).
   */
  async unlike(postId: string, userId: string): Promise<BlogLikeResponse> {
    await this.ensurePostExists(postId);

    const likesCount = await this.prisma.$transaction(async (tx) => {
      // DELETE … RETURNING post_id. Если такого лайка не было —
      // RETURNING вернёт 0 строк.
      const deleted = await tx.$queryRawUnsafe<Array<{ post_id: string }>>(
        `DELETE FROM blog_post_likes
         WHERE post_id = $1::uuid AND user_id = $2::uuid
         RETURNING post_id`,
        postId,
        userId,
      );

      if (deleted.length === 0) {
        return this.readLikesCount(tx, postId);
      }

      // Декремент с защитой от минуса прямо в SQL. Дрейф «таблица
      // пуста, счётчик 5» в T7-cron всё равно нормализуется; здесь
      // гарантия что мы не сделаем -1 → -2 в реальном времени.
      const rows = await tx.$queryRawUnsafe<Array<{ likes_count: number }>>(
        `UPDATE blog_posts
         SET likes_count = GREATEST(likes_count - 1, 0)
         WHERE id = $1::uuid
         RETURNING likes_count`,
        postId,
      );
      return rows[0]?.likes_count ?? 0;
    });

    return { likesCount, likedByMe: false };
  }

  // ─── helpers ──────────────────────────────────────────────────────

  private async ensurePostExists(postId: string): Promise<void> {
    const post = await this.prisma.blogPost.findUnique({
      where: { id: postId },
      select: { id: true },
    });
    if (!post) {
      throw new NotFoundException(`Blog post ${postId} not found`);
    }
  }

  /**
   * Прочитать `likes_count` под текущей транзакцией. Используется
   * только когда no-op (вставка/удаление не дали строк) — чтобы
   * вернуть клиенту актуальное значение без отдельного запроса.
   */
  private async readLikesCount(
    tx: { $queryRawUnsafe: PrismaService['$queryRawUnsafe'] },
    postId: string,
  ): Promise<number> {
    const rows = await tx.$queryRawUnsafe<Array<{ likes_count: number }>>(
      `SELECT likes_count FROM blog_posts WHERE id = $1::uuid`,
      postId,
    );
    return rows[0]?.likes_count ?? 0;
  }
}
