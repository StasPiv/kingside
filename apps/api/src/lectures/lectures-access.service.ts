import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * KS-3931 / ADR-118 §2.3. Подмножество полей `Lecture`, которое нужно
 * резолверу. Все три обязательны; передаём не всю модель, чтобы
 * тестам не приходилось делать полный mock `Lecture`.
 */
export type LectureForAccessCheck = {
  id: string;
  ownerId: string;
  /**
   * Строкой намеренно: импорт `LectureVisibility` из generated Prisma
   * client'а внутри других модулей api тянет цепочку, плюс enum-значения
   * у Prisma — обычные строки. Сравниваем по значениям.
   */
  visibility: 'public' | 'unlisted' | 'restricted';
};

/**
 * KS-3931 / ADR-118 §2.3. Результат проверки доступа к лекции.
 * `reason` всегда строка из фиксированного набора — фронт мапит её на
 * UX-сообщение и HTTP-код (401 / 403). См. ADR §2.4.1 «Коды ошибок».
 */
export type LectureAccessResult =
  | { allowed: true; reason: 'owner' | 'public' | 'unlisted' | 'allowlisted' }
  | { allowed: false; reason: 'auth_required' | 'not_in_allowlist' };

/**
 * KS-3931 / ADR-118 §2.3. Единая точка проверки доступа к лекции для
 * REST (`GET /lectures/:id`, `GET /lectures/:id/recording`) и
 * WS (`subscribe` к live-сессии лекции в `LiveAnalysisGateway`).
 *
 * Логика по ADR §2.3:
 *
 *   if viewer is owner            → allowed (owner)
 *   switch lecture.visibility:
 *     case 'public'               → allowed (public)
 *     case 'unlisted'             → allowed (unlisted)
 *     case 'restricted':
 *       if viewer is anonymous    → denied (auth_required)
 *       if viewer in allowlist    → allowed (allowlisted)
 *       else                      → denied (not_in_allowlist)
 *
 * MVP проверяет только `subjectType='user'`. Для будущего
 * `subjectType='course'` будет JOIN на `CourseEnrollment` (ADR §2.3:
 * сегодня игнорируется — записей нет).
 *
 * **Owner-проверка идёт ПЕРВОЙ**, до switch по visibility. Это значит
 * владелец видит свою restricted-лекцию без allowlist'а; владелец
 * также не получает auth_required даже если как-то залогинен под
 * собой и одновременно проходит anonymous-резолвер (хотя такой
 * сценарий не воспроизводим — anonymous viewerUserId=null, не равен
 * lecture.ownerId). Owner-bypass выполнен через простое сравнение
 * id, без отдельного SQL-запроса.
 */
@Injectable()
export class LecturesAccessService {
  private readonly logger = new Logger(LecturesAccessService.name);

  constructor(private readonly prisma: PrismaService) {}

  async resolveLectureAccess(
    lecture: LectureForAccessCheck,
    viewerUserId: string | null,
  ): Promise<LectureAccessResult> {
    // 1. Owner всегда видит свою лекцию, независимо от visibility.
    if (viewerUserId !== null && viewerUserId === lecture.ownerId) {
      return { allowed: true, reason: 'owner' };
    }

    switch (lecture.visibility) {
      case 'public':
        return { allowed: true, reason: 'public' };
      case 'unlisted':
        // Доступ по прямой ссылке; ничего проверять не нужно.
        return { allowed: true, reason: 'unlisted' };
      case 'restricted':
        return this.resolveRestricted(lecture.id, viewerUserId);
      default: {
        // Защитная ветка: если в БД появится новое значение enum, к
        // которому код не готов, не пропускаем по умолчанию. Лучше
        // 403 для известного зрителя, чем случайно открытый доступ.
        this.logger.warn(
          `resolveLectureAccess: unknown visibility=${String(lecture.visibility)} for lecture=${lecture.id} — defaulting to denied`,
        );
        return viewerUserId === null
          ? { allowed: false, reason: 'auth_required' }
          : { allowed: false, reason: 'not_in_allowlist' };
      }
    }
  }

  /**
   * KS-3931 / ADR-118 §2.3. Проверка allowlist для restricted-лекции.
   * Выделено приватным методом для тестируемости — основной метод
   * остаётся коротким, без вложенных условий.
   *
   * SQL по индексу `lecture_access_unique` (UNIQUE по
   * `(lecture_id, subject_type, subject_id)` — KS-3930), `findFirst`
   * за O(log n) даже при больших allowlist'ах.
   */
  private async resolveRestricted(
    lectureId: string,
    viewerUserId: string | null,
  ): Promise<LectureAccessResult> {
    if (viewerUserId === null) {
      return { allowed: false, reason: 'auth_required' };
    }
    const grant = await this.prisma.lectureAccessGrant.findFirst({
      where: {
        lectureId,
        subjectType: 'user',
        subjectId: viewerUserId,
      },
      select: { id: true },
    });
    if (grant) {
      return { allowed: true, reason: 'allowlisted' };
    }
    return { allowed: false, reason: 'not_in_allowlist' };
  }
}
