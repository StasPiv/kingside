/**
 * KS-4674 / ADR-146. Сервис админских CRUD-операций над демо-репертуарами
 * (`is_demo=true`). Используется только `OpeningTrainerAdminController`
 * (не пользовательский lobby).
 *
 * Архитектурные правила (§2.5 ADR-146):
 *  - Все методы оперируют ТОЛЬКО `is_demo=true`. Изоляция от
 *    пользовательских записей — на уровне where-фильтра в каждом запросе.
 *  - Hard-delete для admin-записей (без soft-delete). Каскад
 *    зависимых `OpeningRepertoireSource`, `OpeningTrainerSession`,
 *    `OpeningLineProgress` обеспечен FK `ON DELETE CASCADE`.
 *  - `slug` уникален среди `is_demo=true` (БД partial unique index).
 *    Конфликт slug → 409.
 *  - `userId` всегда NULL для admin-записей (БД CHECK).
 */
import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@kingside/db';
import { PrismaService } from '../../prisma/prisma.service';
import {
  RepertoireBuilderService,
  RepertoireLimitExceededError,
  RepertoirePgnError,
} from '../repertoire-builder.service';
import {
  CreateAdminRepertoireDto,
  UpdateAdminRepertoireDto,
  UpdateAdminRepertoireStatusDto,
} from './admin-opening-repertoire.dto';

export interface AdminRepertoireSummary {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  side: 'white' | 'black';
  isPublished: boolean;
  nodeCount: number;
  edgeCount: number;
  maxDepth: number;
  createdAt: string;
  updatedAt: string;
}

export interface AdminRepertoireDetail extends AdminRepertoireSummary {
  pgn: string;
  tree: unknown;
}

export interface ListAdminRepertoireOptions {
  side?: 'white' | 'black';
  isPublished?: boolean;
  slug?: string;
}

/** Кastoм-ошибки экспонируются как HTTP-исключения в контроллере. */
export class AdminRepertoireSlugConflictError extends Error {
  override readonly name = 'AdminRepertoireSlugConflictError';
}

@Injectable()
export class OpeningTrainerAdminService {
  private readonly logger = new Logger(OpeningTrainerAdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly builder: RepertoireBuilderService,
  ) {}

  async list(opts: ListAdminRepertoireOptions = {}): Promise<AdminRepertoireSummary[]> {
    const where: Prisma.OpeningRepertoireWhereInput = { isDemo: true };
    if (opts.side) where.side = opts.side;
    if (opts.isPublished !== undefined) where.isPublished = opts.isPublished;
    if (opts.slug) where.slug = opts.slug;

    const rows = await this.prisma.openingRepertoire.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        slug: true,
        title: true,
        description: true,
        side: true,
        isPublished: true,
        nodeCount: true,
        edgeCount: true,
        maxDepth: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    return rows.map((r) => toSummary(r));
  }

  async getById(id: string): Promise<AdminRepertoireDetail> {
    const row = await this.prisma.openingRepertoire.findFirst({
      where: { id, isDemo: true },
      include: { sources: { orderBy: { createdAt: 'asc' } } },
    });
    if (!row) {
      throw new NotFoundException(`admin repertoire ${id} not found`);
    }
    return toDetail(row);
  }

  async create(input: CreateAdminRepertoireDto): Promise<AdminRepertoireDetail> {
    const tree = this.buildTreeOrThrow(input.pgn);
    try {
      const row = await this.prisma.openingRepertoire.create({
        data: {
          userId: null,
          isDemo: true,
          isPublished: input.isPublished ?? false,
          slug: input.slug,
          title: input.title,
          description: input.description ?? null,
          side: input.side,
          pgn: input.pgn,
          tree: tree as unknown as Prisma.InputJsonValue,
          nodeCount: tree.meta.nodeCount,
          edgeCount: tree.meta.edgeCount,
          maxDepth: tree.meta.maxDepth,
          sources: {
            create: {
              name: input.title,
              pgn: input.pgn,
              sourceKind: 'legacy-import',
            },
          },
        },
        include: { sources: { orderBy: { createdAt: 'asc' } } },
      });
      this.logger.log(
        `[admin] created repertoire id=${row.id} slug=${row.slug}`,
      );
      return toDetail(row);
    } catch (e) {
      throw this.mapPrismaError(e);
    }
  }

  async update(
    id: string,
    input: UpdateAdminRepertoireDto,
  ): Promise<AdminRepertoireDetail> {
    const current = await this.prisma.openingRepertoire.findFirst({
      where: { id, isDemo: true },
      select: { id: true, sources: { orderBy: { createdAt: 'asc' }, take: 1 } },
    });
    if (!current) {
      throw new NotFoundException(`admin repertoire ${id} not found`);
    }
    const data: Prisma.OpeningRepertoireUpdateInput = {};
    if (input.slug !== undefined) data.slug = input.slug;
    if (input.title !== undefined) data.title = input.title;
    if (input.description !== undefined) data.description = input.description;
    if (input.side !== undefined) data.side = input.side;
    if (input.pgn !== undefined) {
      const tree = this.buildTreeOrThrow(input.pgn);
      data.pgn = input.pgn;
      data.tree = tree as unknown as Prisma.InputJsonValue;
      data.nodeCount = tree.meta.nodeCount;
      data.edgeCount = tree.meta.edgeCount;
      data.maxDepth = tree.meta.maxDepth;
      // Перезаписываем единственный source: для админских демо мы держим
      // один legacy-import source на репертуар (см. `create`). Это
      // упрощает админ-UI; multi-source — feature пользовательского API.
      const firstSourceId = current.sources[0]?.id;
      if (firstSourceId) {
        data.sources = {
          update: {
            where: { id: firstSourceId },
            data: { pgn: input.pgn, name: input.title ?? undefined },
          },
        };
      }
    }
    try {
      const row = await this.prisma.openingRepertoire.update({
        where: { id },
        data,
        include: { sources: { orderBy: { createdAt: 'asc' } } },
      });
      return toDetail(row);
    } catch (e) {
      throw this.mapPrismaError(e);
    }
  }

  async setStatus(
    id: string,
    input: UpdateAdminRepertoireStatusDto,
  ): Promise<AdminRepertoireDetail> {
    const existing = await this.prisma.openingRepertoire.findFirst({
      where: { id, isDemo: true },
      select: { id: true },
    });
    if (!existing) {
      throw new NotFoundException(`admin repertoire ${id} not found`);
    }
    const row = await this.prisma.openingRepertoire.update({
      where: { id },
      data: { isPublished: input.isPublished },
      include: { sources: { orderBy: { createdAt: 'asc' } } },
    });
    return toDetail(row);
  }

  async delete(id: string): Promise<void> {
    const existing = await this.prisma.openingRepertoire.findFirst({
      where: { id, isDemo: true },
      select: { id: true, slug: true },
    });
    if (!existing) {
      throw new NotFoundException(`admin repertoire ${id} not found`);
    }
    // Hard-delete; каскад FK снесёт sources / sessions / lineProgress.
    await this.prisma.openingRepertoire.delete({ where: { id } });
    this.logger.log(
      `[admin] deleted repertoire id=${id} slug=${existing.slug}`,
    );
  }

  // ─── helpers ───────────────────────────────────────────────────────

  private buildTreeOrThrow(pgn: string): ReturnType<RepertoireBuilderService['buildTree']> {
    try {
      return this.builder.buildTree(pgn);
    } catch (e) {
      if (e instanceof RepertoirePgnError) {
        throw new ConflictException(`PGN invalid: ${e.message}`);
      }
      if (e instanceof RepertoireLimitExceededError) {
        throw new ConflictException(`PGN exceeds limits: ${e.message}`);
      }
      throw e;
    }
  }

  private mapPrismaError(e: unknown): Error {
    // Duck-typing вместо `instanceof Prisma.PrismaClientKnownRequestError`:
    // в jest-моках constructor класса недоступен (см. blog-admin.service.ts
    // тот же паттерн). У реального Prisma-ошибки поле `code` есть всегда.
    const code = (e as { code?: string }).code;
    if (code === 'P2002') {
      // Уникальность slug среди is_demo=true (partial unique index).
      return new ConflictException('admin repertoire with this slug already exists');
    }
    return e as Error;
  }
}

// ─── pure mappers (для тестов и контроллера) ───────────────────────────

function toSummary(r: {
  id: string;
  slug: string | null;
  title: string;
  description: string | null;
  side: string;
  isPublished: boolean;
  nodeCount: number;
  edgeCount: number;
  maxDepth: number;
  createdAt: Date;
  updatedAt: Date;
}): AdminRepertoireSummary {
  return {
    id: r.id,
    slug: r.slug ?? '',
    title: r.title,
    description: r.description,
    side: r.side === 'black' ? 'black' : 'white',
    isPublished: r.isPublished,
    nodeCount: r.nodeCount,
    edgeCount: r.edgeCount,
    maxDepth: r.maxDepth,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

function toDetail(row: {
  id: string;
  slug: string | null;
  title: string;
  description: string | null;
  side: string;
  isPublished: boolean;
  nodeCount: number;
  edgeCount: number;
  maxDepth: number;
  createdAt: Date;
  updatedAt: Date;
  pgn: string;
  tree: unknown;
  sources: Array<{ pgn: string }>;
}): AdminRepertoireDetail {
  // pgn в DTO — это denormalised concat sources (как в OpeningRepertoireDetailDto).
  const pgn = row.sources.length > 0
    ? row.sources.map((s) => s.pgn).join('\n\n')
    : row.pgn;
  return {
    ...toSummary(row),
    pgn,
    tree: row.tree,
  };
}
