import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * KS-2856 / ADR-060 §3.4 (KS-2859 B3). Toggle like для студии:
 * INSERT/DELETE записи `study_likes` + увеличение/уменьшение
 * денормализованного `studies.likes` атомарно через транзакцию.
 *
 * Возвращает финальное состояние `{ liked, likes }` — фронт может
 * перерисовать кнопку без дополнительного запроса.
 *
 * Cooldown 1 сек (ADR §3.4) не enforce-имся здесь — для MVP полагаемся
 * на frontend-debounce и rate-limit на эндпоинте.
 */
@Injectable()
export class StudyLikesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Атомарный toggle. Идемпотентно: повторный like без unlike
   * не увеличивает счётчик (защищено уникальностью PK
   * `(studyId, userId)`).
   */
  async toggle(
    studyId: string,
    userId: string,
  ): Promise<{ liked: boolean; likes: number }> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.studyLike.findUnique({
        where: { studyId_userId: { studyId, userId } },
      });
      if (existing) {
        await tx.studyLike.delete({
          where: { studyId_userId: { studyId, userId } },
        });
        const updated = await tx.study.update({
          where: { id: studyId },
          data: { likes: { decrement: 1 } },
          select: { likes: true },
        });
        return { liked: false, likes: Math.max(updated.likes, 0) };
      }
      await tx.studyLike.create({
        data: { studyId, userId },
      });
      const updated = await tx.study.update({
        where: { id: studyId },
        data: { likes: { increment: 1 } },
        select: { likes: true },
      });
      return { liked: true, likes: updated.likes };
    });
  }

  /** Проверка — лайкнул ли пользователь конкретную студию. */
  async hasLiked(studyId: string, userId: string): Promise<boolean> {
    const row = await this.prisma.studyLike.findUnique({
      where: { studyId_userId: { studyId, userId } },
      select: { studyId: true },
    });
    return row !== null;
  }
}
