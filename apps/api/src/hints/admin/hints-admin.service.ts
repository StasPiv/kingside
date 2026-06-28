/**
 * KS-4702 / ADR-147 §3.1 + §3.3. Admin CRUD над `events.hints`.
 * Использует owner-Prisma (`EventsPrismaService.getOwner()`) — `INSERT/
 * UPDATE/DELETE` на schema events требуют owner-роли (events_writer
 * имеет права, но они даются DEFAULT PRIVILEGES → admin-API всё равно
 * под owner для прозрачности; см. ADR §2.2 «изоляция через роли»).
 *
 * DSL-валидация через `validateRule` (hints-dsl.evaluator) — статическая
 * проверка структуры без обращения к БД. Бросок Error → 400 в
 * контроллере.
 *
 * Sanitize i18n: каждый title/body/ctaLabel прогоняется через
 * `stripHtml` (blog/comment-sanitize) — превращает любой HTML в
 * plain-text, защита от случайного <script>… в админ-форме. Если
 * полей нет — оставляем как есть.
 */
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { PrismaClient as EventsPrismaClient } from '@kingside/events-db';
import { Prisma } from '@kingside/events-db';
import { stripHtml } from '../../blog/comment-sanitize';
import { EventsPrismaService } from '../../events/events-prisma.service';
import { validateRule } from '../hints-dsl.evaluator';
import type {
  CreateHintDto,
  HintCtaDto,
  HintI18nDto,
  HintI18nEntryDto,
  UpdateHintDto,
  UpdateHintStatusDto,
} from './admin-hint.dto';

export interface AdminHintSummary {
  id: string;
  key: string;
  anchor: string;
  placement: string;
  enabled: boolean;
  priority: number;
  targetActorTypes: string[];
  titleRu: string | null;
  titleEn: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AdminHintDetail extends AdminHintSummary {
  i18n: HintI18nDto;
  cta: HintCtaDto | null;
  rule: Record<string, unknown>;
  acceptedBy: string[];
  cooldownSec: number;
  ttlSec: number;
  maxShows: number;
  deletedAt: string | null;
}

export interface ListAdminHintsOptions {
  enabled?: boolean;
  anchor?: string;
  actorType?: 'user' | 'guest';
  search?: string;
  /** Включить soft-deleted (`deletedAt IS NOT NULL`). Default false. */
  includeDeleted?: boolean;
}

@Injectable()
export class HintsAdminService {
  private readonly logger = new Logger(HintsAdminService.name);

  constructor(private readonly prismaSvc: EventsPrismaService) {}

  /* ─── list / get ─────────────────────────────────────────── */

  async list(opts: ListAdminHintsOptions = {}): Promise<AdminHintSummary[]> {
    const owner = this.requireOwner();
    const where: Prisma.HintWhereInput = {};
    if (!opts.includeDeleted) where.deletedAt = null;
    if (opts.enabled !== undefined) where.enabled = opts.enabled;
    if (opts.anchor) where.anchor = opts.anchor;
    if (opts.actorType) where.targetActorTypes = { has: opts.actorType };
    if (opts.search) {
      const q = opts.search.trim();
      if (q.length > 0) {
        // Поиск по key (LIKE) или по i18n.{ru,en}.title (JSON path).
        // Prisma jsonb search через `path: ['ru', 'title'], string_contains`.
        where.OR = [
          { key: { contains: q, mode: 'insensitive' } },
          { i18n: { path: ['ru', 'title'], string_contains: q } as never },
          { i18n: { path: ['en', 'title'], string_contains: q } as never },
        ];
      }
    }

    const rows = await owner.hint.findMany({
      where,
      orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
      take: 200,
    });
    return rows.map(toSummary);
  }

  async getById(id: string): Promise<AdminHintDetail> {
    const owner = this.requireOwner();
    const row = await owner.hint.findUnique({ where: { id } });
    if (!row) throw new NotFoundException(`hint ${id} not found`);
    return toDetail(row);
  }

  /* ─── create / update / status / delete ──────────────────── */

  async create(dto: CreateHintDto): Promise<AdminHintDetail> {
    this.validateInput(dto.anchor, dto.rule);
    const i18n = sanitizeI18n(dto.i18n);
    const owner = this.requireOwner();
    try {
      const created = await owner.hint.create({
        data: {
          key: dto.key,
          i18n: i18n as Prisma.InputJsonValue,
          cta: dto.cta ? (dto.cta as Prisma.InputJsonValue) : Prisma.JsonNull,
          anchor: dto.anchor,
          placement: dto.placement,
          rule: dto.rule as Prisma.InputJsonValue,
          priority: dto.priority ?? 0,
          enabled: dto.enabled ?? true,
          acceptedBy: dto.acceptedBy ?? [],
          targetActorTypes: dto.targetActorTypes ?? ['user', 'guest'],
          cooldownSec: dto.cooldownSec ?? 86_400,
          ttlSec: dto.ttlSec ?? 0,
          maxShows: dto.maxShows ?? 3,
        },
      });
      return toDetail(created);
    } catch (err) {
      throw mapPrismaError(err, `key='${dto.key}'`);
    }
  }

  async update(id: string, dto: UpdateHintDto): Promise<AdminHintDetail> {
    const owner = this.requireOwner();
    const existing = await owner.hint.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException(`hint ${id} not found`);

    // KS-4731: формат anchor — DTO `@Matches`/`@Length` уже отвалидировал.
    // Whitelist-проверки больше нет (ADR-148).
    if (dto.rule) {
      try {
        validateRule(dto.rule);
      } catch (e) {
        throw new BadRequestException((e as Error).message);
      }
    }
    const i18n = dto.i18n ? sanitizeI18n(dto.i18n) : undefined;

    try {
      const updated = await owner.hint.update({
        where: { id },
        data: {
          ...(i18n !== undefined ? { i18n: i18n as Prisma.InputJsonValue } : {}),
          ...(dto.cta !== undefined
            ? { cta: dto.cta === null ? Prisma.JsonNull : (dto.cta as Prisma.InputJsonValue) }
            : {}),
          ...(dto.anchor !== undefined ? { anchor: dto.anchor } : {}),
          ...(dto.placement !== undefined ? { placement: dto.placement } : {}),
          ...(dto.rule !== undefined ? { rule: dto.rule as Prisma.InputJsonValue } : {}),
          ...(dto.priority !== undefined ? { priority: dto.priority } : {}),
          ...(dto.enabled !== undefined ? { enabled: dto.enabled } : {}),
          ...(dto.acceptedBy !== undefined ? { acceptedBy: dto.acceptedBy } : {}),
          ...(dto.targetActorTypes !== undefined
            ? { targetActorTypes: dto.targetActorTypes }
            : {}),
          ...(dto.cooldownSec !== undefined ? { cooldownSec: dto.cooldownSec } : {}),
          ...(dto.ttlSec !== undefined ? { ttlSec: dto.ttlSec } : {}),
          ...(dto.maxShows !== undefined ? { maxShows: dto.maxShows } : {}),
        },
      });
      return toDetail(updated);
    } catch (err) {
      throw mapPrismaError(err, `id=${id}`);
    }
  }

  async setStatus(id: string, dto: UpdateHintStatusDto): Promise<AdminHintDetail> {
    const owner = this.requireOwner();
    const row = await owner.hint.findUnique({ where: { id } });
    if (!row) throw new NotFoundException(`hint ${id} not found`);
    // Re-enable у soft-deleted — снимаем deletedAt.
    const updated = await owner.hint.update({
      where: { id },
      data: {
        enabled: dto.enabled,
        ...(dto.enabled && row.deletedAt ? { deletedAt: null } : {}),
      },
    });
    return toDetail(updated);
  }

  async delete(id: string): Promise<void> {
    const owner = this.requireOwner();
    const row = await owner.hint.findUnique({ where: { id } });
    if (!row) throw new NotFoundException(`hint ${id} not found`);
    if (row.deletedAt) return; // идемпотентно
    await owner.hint.update({
      where: { id },
      data: { deletedAt: new Date(), enabled: false },
    });
  }

  /* ─── preview-trigger ───────────────────────────────────── */

  /**
   * Оценочный счёт: сколько уникальных actor'ов из последних 24h
   * соответствуют правилу. Полноценная проверка для каждого actor'а —
   * дорогая операция; для UI достаточно «±10%». Алгоритм:
   *
   *   1. Валидируем DSL (`validateRule`) — на невалидном бросаем 400.
   *   2. Достаём кандидатов: список actor_id, у которых ЕСТЬ хотя бы
   *      одно событие за 24h (через `actor_event_counts_24h`).
   *   3. Для каждого actor_id запускаем `evaluateRule` (без `page`-
   *      контекста — для preview берём «глобально», без UI-привязки).
   *      Limit 1000 actor'ов — гарантия что endpoint не зависает.
   *
   * Результат: `{ estimate: N, sampled: K, capped: bool }` —
   * прозрачность ограничений для админ-UI.
   */
  async previewTrigger(rule: Record<string, unknown>): Promise<{
    estimate: number;
    sampled: number;
    capped: boolean;
  }> {
    try {
      validateRule(rule);
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
    const owner = this.requireOwner();
    const SAMPLE_CAP = 1000;
    let actors: Array<{ actor_id: string; actor_type: 'user' | 'guest' }> = [];
    try {
      // matview `actor_event_counts_24h` (создан KS-4691) — agg по
      // (actor_id, actor_type, type). Уникальных actors берём через
      // distinct SELECT.
      actors = await owner.$queryRawUnsafe<typeof actors>(
        `SELECT DISTINCT actor_id::text AS actor_id, actor_type
         FROM "events"."actor_event_counts_24h"
         LIMIT $1`,
        SAMPLE_CAP,
      );
    } catch (err) {
      this.logger.warn(`previewTrigger SQL failed: ${(err as Error).message}`);
      return { estimate: 0, sampled: 0, capped: false };
    }
    // Lazy-import evaluateRule, чтобы избежать circular DI с module-init.
    const { evaluateRule } = await import('../hints-dsl.evaluator');
    let matched = 0;
    for (const a of actors) {
      try {
        const ok = await evaluateRule(
          rule,
          { type: a.actor_type, id: a.actor_id },
          {},
          { events: owner },
        );
        if (ok) matched += 1;
      } catch { /* skip */ }
    }
    return {
      estimate: matched,
      sampled: actors.length,
      capped: actors.length >= SAMPLE_CAP,
    };
  }

  /* ─── helpers ───────────────────────────────────────────── */

  private requireOwner(): EventsPrismaClient {
    const owner = this.prismaSvc.getOwner();
    if (!owner) {
      throw new BadRequestException(
        'events database not configured (EVENTS_DATABASE_URL missing)',
      );
    }
    return owner;
  }

  private validateInput(_anchor: string, rule: Record<string, unknown>): void {
    // KS-4731 / ADR-148: anchor — свободная строка, формат проверен
    // class-validator'ом на DTO. Whitelist `isHintAnchor` удалён.
    try {
      validateRule(rule);
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
  }
}

/* ─── pure mappers / sanitizers ─────────────────────────────── */

function sanitizeI18n(i18n: HintI18nDto): HintI18nDto {
  const out: HintI18nDto = {};
  if (i18n.ru) out.ru = sanitizeEntry(i18n.ru);
  if (i18n.en) out.en = sanitizeEntry(i18n.en);
  return out;
}

function sanitizeEntry(e: HintI18nEntryDto): HintI18nEntryDto {
  return {
    title: stripHtml(e.title ?? ''),
    body: stripHtml(e.body ?? ''),
    ...(e.ctaLabel !== undefined ? { ctaLabel: stripHtml(e.ctaLabel) } : {}),
  };
}

function toSummary(row: any): AdminHintSummary {
  const i18n = (row.i18n ?? {}) as Record<string, HintI18nEntryDto | undefined>;
  return {
    id: row.id,
    key: row.key,
    anchor: row.anchor,
    placement: row.placement,
    enabled: row.enabled,
    priority: row.priority,
    targetActorTypes: row.targetActorTypes ?? [],
    titleRu: i18n.ru?.title ?? null,
    titleEn: i18n.en?.title ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toDetail(row: any): AdminHintDetail {
  return {
    ...toSummary(row),
    i18n: (row.i18n ?? {}) as HintI18nDto,
    cta: (row.cta ?? null) as HintCtaDto | null,
    rule: (row.rule ?? {}) as Record<string, unknown>,
    acceptedBy: row.acceptedBy ?? [],
    cooldownSec: row.cooldownSec,
    ttlSec: row.ttlSec,
    maxShows: row.maxShows,
    deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
  };
}

function mapPrismaError(err: unknown, ctx: string): Error {
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as { code: string }).code;
    if (code === 'P2002') {
      return new ConflictException(`hint already exists (${ctx})`);
    }
  }
  return err as Error;
}
