import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  SavedFilterDto,
  SavedFilterParams,
  SavedFilterSection,
} from '@kingside/shared';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CreateSavedFilterDto,
  UpdateSavedFilterDto,
} from './dto/saved-filters.dto';
import {
  normalizeSavedFilterParams,
  stripSectionFromParams,
} from './saved-filters-params.validator';

/** KS-2924 §3.2. Лимит — 20 фильтров на пару (user_id, section). */
export const MAX_FILTERS_PER_SECTION = 20;

/**
 * KS-2927 Phase A3. CRUD для `/api/user/saved-filters`.
 *
 * Особенности:
 *   - Дискриминатор `section` валидируется на DTO; params
 *     нормализуется через {@link normalizeSavedFilterParams}.
 *   - В JSONB-колонку `params` поле `section` не пишется
 *     (дискриминатор хранится отдельно). При чтении подмешивается
 *     в DTO {@link toSavedFilterDto}.
 *   - Уникальность имени в пределах (userId, section) — TOCTOU-race
 *     при concurrent create acknowledged (отдельного unique-индекса
 *     в БД пока нет; race крайне маловероятен на user-UI-сценарии,
 *     добавление partial unique index — отдельная задача после
 *     стабилизации формы).
 *   - Ownership-чек: PATCH/DELETE/GET-by-id чужого пресета → 404
 *     (без enumeration о существовании).
 *
 * Старый `apps/api/src/analysis/saved-filter.service.ts` пока
 * сосуществует — он будет удалён в Phase A5 отдельной задачей
 * после переезда фронта на новый эндпоинт.
 */
@Injectable()
export class SavedFiltersService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    userId: string,
    section: SavedFilterSection,
  ): Promise<SavedFilterDto[]> {
    const rows = await this.prisma.savedFilter.findMany({
      where: { userId, section },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(toSavedFilterDto);
  }

  async create(
    userId: string,
    dto: CreateSavedFilterDto,
  ): Promise<SavedFilterDto> {
    const name = (dto.name ?? '').trim();
    if (name.length < 1 || name.length > 100) {
      throw new BadRequestException('name must be 1..100 chars after trim');
    }
    const params = normalizeSavedFilterParams(dto.section, dto.params);

    const count = await this.prisma.savedFilter.count({
      where: { userId, section: dto.section },
    });
    if (count >= MAX_FILTERS_PER_SECTION) {
      throw new BadRequestException(
        `Maximum ${MAX_FILTERS_PER_SECTION} saved filters per section`,
      );
    }
    const duplicate = await this.prisma.savedFilter.findFirst({
      where: { userId, section: dto.section, name },
      select: { id: true },
    });
    if (duplicate) {
      throw new ConflictException('Имя уже используется');
    }

    const created = await this.prisma.savedFilter.create({
      data: {
        userId,
        section: dto.section,
        name,
        params: stripSectionFromParams(params) as object,
      },
    });
    return toSavedFilterDto(created);
  }

  async update(
    userId: string,
    id: string,
    dto: UpdateSavedFilterDto,
  ): Promise<SavedFilterDto> {
    const existing = await this.prisma.savedFilter.findUnique({
      where: { id },
    });
    if (!existing || existing.userId !== userId) {
      throw new NotFoundException('Saved filter not found');
    }
    const section = existing.section as SavedFilterSection;

    const data: Record<string, unknown> = {};

    if (dto.name !== undefined) {
      const name = dto.name.trim();
      if (name.length < 1 || name.length > 100) {
        throw new BadRequestException('name must be 1..100 chars after trim');
      }
      // duplicate check — исключаем текущую запись
      const dup = await this.prisma.savedFilter.findFirst({
        where: {
          userId,
          section,
          name,
          NOT: { id },
        },
        select: { id: true },
      });
      if (dup) {
        throw new ConflictException('Имя уже используется');
      }
      data.name = name;
    }

    if (dto.params !== undefined) {
      const params = normalizeSavedFilterParams(section, dto.params);
      data.params = stripSectionFromParams(params);
    }

    if (Object.keys(data).length === 0) {
      // нечего менять — отдадим текущее состояние
      return toSavedFilterDto(existing);
    }

    const updated = await this.prisma.savedFilter.update({
      where: { id },
      data,
    });
    return toSavedFilterDto(updated);
  }

  async remove(
    userId: string,
    id: string,
  ): Promise<{ deleted: true }> {
    const existing = await this.prisma.savedFilter.findUnique({
      where: { id },
    });
    if (!existing || existing.userId !== userId) {
      throw new NotFoundException('Saved filter not found');
    }
    await this.prisma.savedFilter.delete({ where: { id } });
    return { deleted: true };
  }
}

/**
 * Маппинг записи saved_filters → SavedFilterDto. Подмешивает
 * `section` в `params` (дискриминатор), чтобы возвращаемый объект
 * соответствовал union'у `SavedFilterParams` из @kingside/shared.
 */
export function toSavedFilterDto(row: {
  id: string;
  section: string;
  name: string;
  params: unknown;
  createdAt: Date;
  updatedAt: Date;
}): SavedFilterDto {
  const section = row.section as SavedFilterSection;
  const stored =
    typeof row.params === 'object' && row.params !== null
      ? (row.params as Record<string, unknown>)
      : {};
  const params = { section, ...stored } as SavedFilterParams;
  return {
    id: row.id,
    section,
    name: row.name,
    params,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
