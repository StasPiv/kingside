import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { ArchiveFilters } from '@kingside/shared';
import type { ArchiveFiltersDto } from './dto/archive-filters.dto';

/**
 * Сервис сохранения пользовательских предпочтений (KS-2210).
 *
 * Предпочтения хранятся в таблице `users` — минимальный overhead
 * без extra-join'ов. Фильтры архива — первый тип предпочтений;
 * при расширении (цвет темы, язык и т.п.) логика будет здесь.
 */
@Injectable()
export class UserPreferencesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Возвращает сохранённые фильтры архива. Если пользователь ещё не
   * выставлял фильтры — возвращаем пустой объект (не null).
   */
  async getArchiveFilters(userId: string): Promise<ArchiveFilters> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { archiveFilters: true },
    });
    if (!user) return {};
    return (user.archiveFilters as ArchiveFilters) ?? {};
  }

  /**
   * Сохраняет (перезаписывает полностью) фильтры архива для пользователя.
   * Поля с `null` остаются в JSON как `null` — фронт интерпретирует
   * их как «сброшен».
   */
  async saveArchiveFilters(
    userId: string,
    dto: ArchiveFiltersDto,
  ): Promise<ArchiveFilters> {
    // Убираем undefined-поля, оставляем только явно переданные
    // (включая null-значения — они важны для «сброс фильтра»).
    const filters: ArchiveFilters = Object.fromEntries(
      Object.entries(dto).filter(([, v]) => v !== undefined),
    );
    await this.prisma.user.update({
      where: { id: userId },
      data: { archiveFilters: filters },
    });
    return filters;
  }
}
