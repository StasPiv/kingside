import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { StudyModel as Study } from '@kingside/db';
import { PrismaService } from '../prisma/prisma.service';
import { StudySlugService } from './study-slug.service';
import { STUDY_LIMITS } from './study-limits';
import type { CreateStudyDto, UpdateStudyDto } from './dto/study.dto';

/**
 * KS-2815 / ADR-059 / KS-2818 T3. CRUD-сервис для `Study` (контейнер).
 *
 * Сервис только бизнес-логика (валидация лимитов, slug, разрешения
 * на основе ownerId/isPublic). Авторизация JWT и owner-guard стоят
 * перед сервисом в контроллерах (T4/T6); тут мы получаем уже
 * resolved-userId либо null (anonymous public access).
 */
@Injectable()
export class StudyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly slug: StudySlugService,
  ) {}

  // ─── Listings ────────────────────────────────────────────────────

  /**
   * `mine=true`: студии текущего пользователя (включая приватные).
   * `mine=false`: публичные студии всех пользователей.
   *
   * `userId=null` допустим только для `mine=false` (anonymous catalog).
   */
  async list(
    userId: string | null,
    opts: { mine: boolean; limit?: number; offset?: number },
  ): Promise<{ data: StudyListItem[] }> {
    if (opts.mine && !userId) {
      throw new BadRequestException('mine=1 requires authentication');
    }
    const take = clampInt(opts.limit ?? 50, 1, 50);
    const skip = clampInt(opts.offset ?? 0, 0, 1000);
    const where = opts.mine
      ? { ownerId: userId! }
      : { isPublic: true };
    const rows = await this.prisma.study.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      take,
      skip,
    });
    return { data: rows.map(toStudyListItem) };
  }

  // ─── Read by slug ────────────────────────────────────────────────

  /**
   * Возвращает студию + список её глав (без `pgn` — экономим payload
   * каталога). Если `userId` есть и совпадает с владельцем — отдаём
   * приватную тоже; иначе доступны только `isPublic=true`.
   *
   * Slug уникален per-owner, поэтому ищем `findFirst` по slug —
   * приоритет «моя студия с этим slug'ом», fallback на публичную
   * чужую с тем же slug'ом.
   */
  async getBySlug(
    userId: string | null,
    slug: string,
  ): Promise<StudyWithChapters> {
    const study = await this.resolveBySlug(userId, slug);
    if (!study) {
      throw new NotFoundException('Study not found');
    }
    const chapters = await this.prisma.studyChapter.findMany({
      where: { studyId: study.id },
      orderBy: { orderIdx: 'asc' },
      select: {
        id: true,
        name: true,
        orderIdx: true,
        startFen: true,
        orientation: true,
        mode: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    return {
      study: toStudyDto(study),
      chapters: chapters.map((c) => ({
        id: c.id,
        name: c.name,
        orderIdx: c.orderIdx,
        startFen: c.startFen,
        orientation: c.orientation,
        mode: c.mode,
        createdAt: c.createdAt.toISOString(),
        updatedAt: c.updatedAt.toISOString(),
      })),
    };
  }

  /**
   * Разрешает slug в `Study`-запись с учётом прав доступа.
   * - owner → возвращает свою (private или public).
   * - anonymous / другой userId → только если study.isPublic.
   * - null если не существует или приватная чужая.
   *
   * Возвращает `Study` объект целиком (нужен в guard'ах и chapters-
   * сервисе как контекст), без выборки тяжёлых полей.
   */
  async resolveBySlug(
    userId: string | null,
    slug: string,
  ): Promise<Study | null> {
    // Сначала ищем «мою» с этим slug — она в приоритете при коллизии.
    if (userId) {
      const mine = await this.prisma.study.findFirst({
        where: { ownerId: userId, slug },
      });
      if (mine) return mine;
    }
    const pub = await this.prisma.study.findFirst({
      where: { slug, isPublic: true },
    });
    return pub;
  }

  // ─── Mutations ───────────────────────────────────────────────────

  /**
   * Создать пустую студию. Проверяется лимит `studiesPerUser`.
   * Slug генерируется через `StudySlugService` per-owner.
   */
  async create(userId: string, dto: CreateStudyDto): Promise<StudyDto> {
    const existingCount = await this.prisma.study.count({
      where: { ownerId: userId },
    });
    if (existingCount >= STUDY_LIMITS.studiesPerUser) {
      throw new BadRequestException(
        `Studies limit reached (max ${STUDY_LIMITS.studiesPerUser} per user)`,
      );
    }
    const slug = await this.slug.generateUnique(userId, dto.name);
    const created = await this.prisma.study.create({
      data: {
        ownerId: userId,
        slug,
        name: dto.name,
        description: dto.description ?? null,
        isPublic: dto.isPublic ?? false,
      },
    });
    return toStudyDto(created);
  }

  /**
   * Обновить студию. `userId` обязателен — пришли сюда с owner-guard'а.
   * Дополнительная проверка `study.ownerId === userId` страхует от
   * случая, когда guard кто-то снимет с роута.
   */
  async update(
    userId: string,
    slug: string,
    dto: UpdateStudyDto,
  ): Promise<StudyDto> {
    const study = await this.requireOwn(userId, slug);
    const updated = await this.prisma.study.update({
      where: { id: study.id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.description !== undefined
          ? { description: dto.description }
          : {}),
        ...(dto.isPublic !== undefined ? { isPublic: dto.isPublic } : {}),
      },
    });
    return toStudyDto(updated);
  }

  /** Удалить студию — каскадом удалятся главы (FK CASCADE). */
  async delete(userId: string, slug: string): Promise<void> {
    const study = await this.requireOwn(userId, slug);
    await this.prisma.study.delete({ where: { id: study.id } });
  }

  /**
   * Достаёт студию и проверяет, что текущий пользователь — её владелец.
   * Иначе 404 (ADR §2.5 — единый код, чтобы не давать enumeration).
   */
  async requireOwn(userId: string, slug: string): Promise<Study> {
    const study = await this.prisma.study.findFirst({
      where: { ownerId: userId, slug },
    });
    if (!study) throw new NotFoundException('Study not found');
    if (study.ownerId !== userId) {
      // Не должно случаться по предыдущему where, но защитный invariant.
      throw new ForbiddenException();
    }
    return study;
  }
}

// ─── DTO converters ────────────────────────────────────────────────

export interface StudyDto {
  id: string;
  ownerId: string;
  slug: string;
  name: string;
  description: string | null;
  isPublic: boolean;
  chaptersCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface StudyListItem extends StudyDto {}

export interface StudyChapterSummaryDto {
  id: string;
  name: string;
  orderIdx: number;
  startFen: string | null;
  orientation: string;
  mode: string;
  createdAt: string;
  updatedAt: string;
}

export interface StudyWithChapters {
  study: StudyDto;
  chapters: StudyChapterSummaryDto[];
}

export function toStudyDto(s: Study): StudyDto {
  return {
    id: s.id,
    ownerId: s.ownerId,
    slug: s.slug,
    name: s.name,
    description: s.description,
    isPublic: s.isPublic,
    chaptersCount: s.chaptersCount,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}

export function toStudyListItem(s: Study): StudyListItem {
  return toStudyDto(s);
}

// ─── helpers ───────────────────────────────────────────────────────

function clampInt(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}
