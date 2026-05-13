import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { StudyModel as Study } from '@kingside/db';
import { PrismaService } from '../prisma/prisma.service';
import { StudySlugService } from './study-slug.service';
import {
  STUDY_LIMITS,
  type StudyMemberRole,
  type StudyVisibility,
} from './study-limits';
import type {
  CreateStudyDto,
  StudyCatalogQueryDto,
  StudyCatalogSort,
  UpdateStudyDto,
} from './dto/study.dto';
import type { Prisma } from '@kingside/db';
import {
  normalizeTopics,
  resolveVisibilityChange,
} from './study-visibility.util';
import { StudyMembersService } from './study-members.service';

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
    private readonly members: StudyMembersService,
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
    // KS-2910 / ADR-060 §2.6: каталог `mine=false` показывает ТОЛЬКО
    // `visibility='public'`. `unlisted` доступны исключительно по
    // прямой ссылке / UUID; в листинг не попадают. До этого фикса
    // фильтр `isPublic: true` подбирал и unlisted (через бэкфилл
    // `isPublic = visibility !== 'private'` из миграции KS-2857).
    const where = opts.mine
      ? { ownerId: userId! }
      : { visibility: 'public' };
    const rows = await this.prisma.study.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      take,
      skip,
    });
    return { data: rows.map(toStudyListItem) };
  }

  /**
   * KS-2880 / ADR-060 §3.4. Каталог публичных студий.
   *
   * Особенности:
   *  - `visibility='public'` строго (unlisted/private не попадают; см.
   *    KS-2910 регрессия — раньше под `isPublic=true` лежали и unlisted).
   *  - `q`: case-insensitive `ILIKE` по `name`+`description` (без FTS).
   *  - `topic`: `topics @> ARRAY[$1]` — Prisma `has` маппится в `?` для
   *    text[]-колонки.
   *  - `sort='hot'`: PG-формула из ADR `likes / EXTRACT(EPOCH FROM (NOW()
   *    - created_at)) + 1 DESC`. Деление на 0 защищаем `GREATEST(..., 1)`
   *    — иначе только что созданная студия с 0 лайков даёт `0/0=NaN` и
   *    смешивает порядок.
   *  - `sort='popular'`: tie-break по `updatedAt DESC`.
   *  - `sort∈{new,updated,popular}`: Prisma findMany — индексы
   *    `(visibility, *_DESC)` в KS-2857 миграции (Postgres делает
   *    Index Scan Backward для DESC по ASC-индексу).
   *
   * Response: `{ items, total, hasMore }`. `total` — count с теми же
   * фильтрами, без `take/skip`. `hasMore = offset + items.length < total`.
   */
  async catalog(
    query: StudyCatalogQueryDto,
  ): Promise<{ items: StudyDto[]; total: number; hasMore: boolean }> {
    const sort: StudyCatalogSort = query.sort ?? 'hot';
    const page = clampInt(query.page ?? 1, 1, 10_000);
    const pageSize = clampInt(query.pageSize ?? 20, 1, 50);
    const skip = (page - 1) * pageSize;
    const take = pageSize;

    // q — нормализуем: trim, пустую строку считаем «нет фильтра».
    const q = (query.q ?? '').trim();
    const topic = (query.topic ?? '').trim();

    const where: Prisma.StudyWhereInput = {
      visibility: 'public',
      ...(q.length > 0
        ? {
            OR: [
              { name: { contains: q, mode: 'insensitive' as const } },
              { description: { contains: q, mode: 'insensitive' as const } },
            ],
          }
        : {}),
      ...(topic.length > 0 ? { topics: { has: topic } } : {}),
    };

    const total = await this.prisma.study.count({ where });

    let rows: Study[];
    if (sort === 'hot') {
      // PG raw для hot-формулы. Чтобы не дублировать select полей
      // (snake_case в raw), сначала выбираем только `id` упорядоченный
      // по hot-rate, затем дозагружаем полные Study через findMany и
      // восстанавливаем порядок.
      //
      // `$queryRawUnsafe` с параметризованными `$N` плейсхолдерами —
      // pgsql-driver биндит значения, защита от SQL-injection
      // эквивалентна `$queryRaw`. Используется здесь потому, что
      // условия фильтра собираются динамически (Prisma.sql/join
      // удобнее, но не покрыты jest-моком `@kingside/db`).
      const params: unknown[] = [];
      const conditions: string[] = [`s.visibility = 'public'`];
      if (q.length > 0) {
        const pat = `%${q}%`;
        params.push(pat);
        const p1 = `$${params.length}`;
        params.push(pat);
        const p2 = `$${params.length}`;
        conditions.push(`(s.name ILIKE ${p1} OR s.description ILIKE ${p2})`);
      }
      if (topic.length > 0) {
        params.push(topic);
        const p = `$${params.length}`;
        conditions.push(`s.topics @> ARRAY[${p}]::text[]`);
      }
      params.push(take);
      const takeParam = `$${params.length}`;
      params.push(skip);
      const skipParam = `$${params.length}`;
      const sql = `
        SELECT s.id
        FROM studies s
        WHERE ${conditions.join(' AND ')}
        ORDER BY (
          s.likes::float
            / GREATEST(EXTRACT(EPOCH FROM (NOW() - s.created_at)), 1)
            + 1
        ) DESC, s.updated_at DESC
        LIMIT ${takeParam} OFFSET ${skipParam}
      `;
      const idRows = await this.prisma.$queryRawUnsafe<
        Array<{ id: string }>
      >(sql, ...params);
      const orderedIds = idRows.map((r) => r.id);
      if (orderedIds.length === 0) {
        rows = [];
      } else {
        const fetched = await this.prisma.study.findMany({
          where: { id: { in: orderedIds } },
        });
        const byId = new Map(fetched.map((s) => [s.id, s]));
        rows = orderedIds
          .map((id) => byId.get(id))
          .filter((s): s is Study => Boolean(s));
      }
    } else {
      const orderBy: Prisma.StudyOrderByWithRelationInput[] =
        sort === 'new'
          ? [{ createdAt: 'desc' }]
          : sort === 'updated'
            ? [{ updatedAt: 'desc' }]
            : /* popular */ [{ likes: 'desc' }, { updatedAt: 'desc' }];
      rows = await this.prisma.study.findMany({ where, orderBy, take, skip });
    }

    const items = rows.map(toStudyDto);
    return {
      items,
      total,
      hasMore: skip + items.length < total,
    };
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
   *
   * KS-2911 / ADR-060 §3.2: contributor (member) чужой private/unlisted
   * студии должен иметь read-доступ. До этого фикса resolveBySlug
   * возвращал null для contributor — фронт получал 404 даже на GET.
   *
   * Правила:
   * - owner → возвращает свою (любая visibility).
   * - contributor (не owner, есть запись в `study_members`) → возвращает
   *   студию любой visibility (read-доступ к private/unlisted/public).
   * - anonymous / outsider → только `visibility ∈ {public, unlisted}`
   *   (unlisted доступен по прямой ссылке — таков контракт ADR §2.6).
   * - null если не существует либо visibility=private и пользователь
   *   не member.
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
    // KS-2911: для аутентифицированного caller'а ищем студию, в которой
    // он member (contributor). findFirst по slug + join на members.
    if (userId) {
      const asMember = await this.prisma.study.findFirst({
        where: {
          slug,
          members: { some: { userId } },
        },
      });
      if (asMember) return asMember;
    }
    // KS-2911 / ADR-060 §2.6: не-member видит только public и unlisted
    // (анонимный доступ по прямой ссылке к unlisted допустим — в каталог
    // он не попадает через `list()`).
    const visible = await this.prisma.study.findFirst({
      where: {
        slug,
        visibility: { in: ['public', 'unlisted'] },
      },
    });
    return visible;
  }

  /**
   * KS-2911 (Wave A B5+). Разрешает slug в студию с проверкой членства.
   * Используется в chapter-mutating endpoints контроллера, где
   * `StudyContributorGuard` уже отказал anonymous/outsider, но handler'у
   * всё ещё нужен Study-объект как контекст для сервисов chapters.
   *
   * Возвращает Study если caller — owner или contributor (любой member
   * из whitelist `roles`). Иначе 404.
   */
  async requireMember(
    userId: string,
    slug: string,
    roles: ReadonlyArray<StudyMemberRole> = ['owner', 'contributor'],
  ): Promise<Study> {
    const study = await this.prisma.study.findFirst({ where: { slug } });
    if (!study) throw new NotFoundException('Study not found');
    if (study.ownerId === userId && roles.includes('owner')) return study;
    const role = await this.members.getRole(study.id, userId);
    if (!role || !roles.includes(role)) {
      throw new NotFoundException('Study not found');
    }
    return study;
  }

  // ─── Mutations ───────────────────────────────────────────────────

  /**
   * Создать пустую студию. Проверяется лимит `studiesPerUser`.
   * Slug генерируется через `StudySlugService` per-owner.
   *
   * KS-2856 / ADR-060 §3.2: при create автоматически создаётся
   * owner-запись в `study_members` (B4 StudyAccessGuard будет
   * пускать на mutations только members). Обе записи в одной
   * транзакции — иначе race при ошибке inner-insert'а.
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
    const visibilityChange = resolveVisibilityChange({
      visibility: dto.visibility,
      isPublic: dto.isPublic,
    });
    const topics = normalizeTopics(dto.topics) ?? [];
    const created = await this.prisma.$transaction(async (tx) => {
      const study = await tx.study.create({
        data: {
          ownerId: userId,
          slug,
          name: dto.name,
          description: dto.description ?? null,
          isPublic: visibilityChange?.isPublic ?? false,
          visibility: visibilityChange?.visibility ?? 'private',
          topics,
        },
      });
      await tx.studyMember.create({
        data: { studyId: study.id, userId, role: 'owner' },
      });
      return study;
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
    const visibilityChange = resolveVisibilityChange({
      visibility: dto.visibility,
      isPublic: dto.isPublic,
    });
    const topics = normalizeTopics(dto.topics);
    const updated = await this.prisma.study.update({
      where: { id: study.id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.description !== undefined
          ? { description: dto.description }
          : {}),
        ...(visibilityChange
          ? {
              visibility: visibilityChange.visibility,
              isPublic: visibilityChange.isPublic,
            }
          : {}),
        ...(topics !== undefined ? { topics } : {}),
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
  /** DEPRECATED — см. visibility. */
  isPublic: boolean;
  visibility: StudyVisibility;
  topics: string[];
  likes: number;
  fromKind: string;
  fromRefId: string | null;
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
    visibility: (s.visibility as StudyVisibility) ?? 'private',
    topics: s.topics ?? [],
    likes: s.likes ?? 0,
    fromKind: s.fromKind ?? 'scratch',
    fromRefId: s.fromRefId ?? null,
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
