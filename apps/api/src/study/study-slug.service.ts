import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { customAlphabet } from 'nanoid';
import { PrismaService } from '../prisma/prisma.service';
import { SlugService } from '../lessons/user-courses/slug.service';

/**
 * KS-2815 / KS-2818 T3. Генератор slug'а для `Study`.
 *
 * Аналогичен `SlugService` пользовательских курсов (ADR-026 §2.5):
 * `<shortId>-<slug-from-title>`. Уникальность проверяется в `studies`
 * per-owner — slug-namespace ограничен `(owner_id, slug)` UNIQUE (см.
 * миграцию KS-2817), а не глобально, поэтому для коллизии достаточно
 * проверить владельца.
 *
 * Логика slugify-body (транслит кириллицы, очистка не-ASCII) переиспользована
 * из `SlugService.slugifyBody` через статический метод — чтобы не плодить
 * параллельные реализации.
 */
@Injectable()
export class StudySlugService {
  private readonly logger = new Logger(StudySlugService.name);

  /** Те же значения, что в user-courses SlugService — стабильный URL-стиль. */
  static readonly SHORT_ID_LENGTH = 6;
  static readonly MAX_ATTEMPTS = 5;

  private readonly nanoid = customAlphabet(
    '23456789abcdefghijkmnpqrstuvwxyz',
    StudySlugService.SHORT_ID_LENGTH,
  );

  constructor(private readonly prisma: PrismaService) {}

  generate(title: string): string {
    return `${this.nanoid()}-${SlugService.slugifyBody(title)}`;
  }

  /**
   * Генерирует slug, проверяя уникальность в `studies` per-owner.
   * Перегенерирует до `MAX_ATTEMPTS` при коллизии (на практике
   * одной попытки достаточно).
   */
  async generateUnique(ownerId: string, title: string): Promise<string> {
    for (let attempt = 0; attempt < StudySlugService.MAX_ATTEMPTS; attempt++) {
      const slug = this.generate(title);
      const exists = await this.prisma.study.findFirst({
        where: { ownerId, slug },
        select: { id: true },
      });
      if (!exists) return slug;
      this.logger.warn(
        `study slug collision on attempt ${attempt + 1}: "${slug}" — regenerating`,
      );
    }
    throw new BadRequestException(
      `Failed to generate unique study slug after ${StudySlugService.MAX_ATTEMPTS} attempts`,
    );
  }
}
