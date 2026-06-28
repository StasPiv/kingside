/**
 * KS-4699 / ADR-147 §3.2. DSL-evaluator для правил подсказок.
 *
 * Узкий DSL первой версии:
 *
 *   { all: [...] } | { any: [...] } | { not: <op> }
 *   { page: { matches: string } }
 *   { actorType: { equals: 'user' | 'guest' } }
 *   { count: { event: string, where?: object,
 *              windowMin|windowHours|windowDays|sinceDays: number,
 *              gte|lte|eq: number, layer?: 'matview'|'redis'|'auto' } }
 *   { exists: { event: string, where?: object,
 *               windowMin|windowHours|windowDays: number } }
 *   { timeSince: { event: string, gtMin|gtHours|gtDays: number } }
 *
 * Где доступно — `count` использует `events.actor_event_counts_*`
 * matviews (24h/7d/30d, через `actor_id+type+actor_type`). Для коротких
 * окон (≤1h) и `where`-фильтров — fallback на raw SELECT по
 * `events.actor_events` (через owner-Prisma). Reдис hot counters
 * пока не задействованы — DSL первой версии не требует их (см.
 * комментарии в `evaluateCount`); встроим, когда правила с windowMin
 * появятся в seed.
 *
 * Неизвестный оператор → правило отвергается (return false) + warn.
 *
 * Контракт: чистая функция от (rule, ctx). Никакого Nest-DI здесь.
 * Это даёт простые юнит-тесты и переиспользование (admin preview T12
 * вызовет тот же evaluator).
 */
import { Logger } from '@nestjs/common';
import type { PrismaClient as EventsPrismaClient } from '@kingside/events-db';
import type { Actor } from '../events/events.types';
import type { HintCheckContext } from './hints.types';

const log = new Logger('HintsDslEvaluator');

interface EvalDeps {
  /** owner-Prisma для SELECT-ов в schema events. null → defensive false. */
  events: EventsPrismaClient | null;
  /** Замер длительности aggregate-запроса. */
  startAggregate?: (layer: 'matview' | 'redis') => () => void;
}

export type DslRule = unknown;

/** Главная точка входа. true → правило сработало. */
export async function evaluateRule(
  rule: DslRule,
  actor: Actor,
  ctx: HintCheckContext,
  deps: EvalDeps,
): Promise<boolean> {
  if (rule === null || typeof rule !== 'object') return false;
  const r = rule as Record<string, unknown>;

  if (Array.isArray(r.all)) {
    for (const sub of r.all) {
      if (!(await evaluateRule(sub, actor, ctx, deps))) return false;
    }
    return true;
  }
  if (Array.isArray(r.any)) {
    for (const sub of r.any) {
      if (await evaluateRule(sub, actor, ctx, deps)) return true;
    }
    return false;
  }
  if ('not' in r) {
    return !(await evaluateRule(r.not, actor, ctx, deps));
  }
  if (isObj(r.page)) return evaluatePage(r.page as Record<string, unknown>, ctx);
  if (isObj(r.actorType)) return evaluateActorType(r.actorType as Record<string, unknown>, actor);
  if (isObj(r.count)) return evaluateCount(r.count as Record<string, unknown>, actor, deps);
  if (isObj(r.exists)) return evaluateExists(r.exists as Record<string, unknown>, actor, deps);
  if (isObj(r.timeSince)) return evaluateTimeSince(r.timeSince as Record<string, unknown>, actor, deps);

  log.warn(`evaluateRule: unknown operator → false. rule=${JSON.stringify(rule).slice(0, 200)}`);
  return false;
}

/* ─── operators ─────────────────────────────────────────────────── */

function evaluatePage(node: Record<string, unknown>, ctx: HintCheckContext): boolean {
  const pattern = typeof node.matches === 'string' ? node.matches : null;
  if (!pattern || !ctx.page) return false;
  return globMatch(pattern, ctx.page);
}

function evaluateActorType(node: Record<string, unknown>, actor: Actor): boolean {
  return typeof node.equals === 'string' && node.equals === actor.type;
}

async function evaluateCount(
  node: Record<string, unknown>,
  actor: Actor,
  deps: EvalDeps,
): Promise<boolean> {
  const eventType = typeof node.event === 'string' ? node.event : null;
  if (!eventType || !deps.events) return false;
  const since = sinceDate(node);
  if (!since) return false;

  const stopTimer = deps.startAggregate?.('matview') ?? null;
  let cnt = 0;
  try {
    // Полагаемся на raw-таблицу: matview обновляется реже, и для DSL
    // мы хотим ровно интервал из правила, не привязанный к 24h/7d/30d
    // matview-окнам. SELECT с актуальным индексом (actor_id, type,
    // created_at DESC) — index-only scan по партиции, миллисекунды.
    const where = compileEventWhere(node.where);
    const rows = await deps.events.actorEvent.findMany({
      where: {
        actorId: actor.id,
        actorType: actor.type,
        type: eventType,
        createdAt: { gte: since },
        ...where,
      },
      select: { id: true },
    });
    cnt = rows.length;
  } catch (err) {
    log.warn(`evaluateCount: ${(err as Error).message}`);
    return false;
  } finally {
    if (stopTimer) stopTimer();
  }
  return compare(cnt, node);
}

async function evaluateExists(
  node: Record<string, unknown>,
  actor: Actor,
  deps: EvalDeps,
): Promise<boolean> {
  const eventType = typeof node.event === 'string' ? node.event : null;
  if (!eventType || !deps.events) return false;
  const since = sinceDate(node);
  if (!since) return false;
  const where = compileEventWhere(node.where);
  try {
    const r = await deps.events.actorEvent.findFirst({
      where: {
        actorId: actor.id,
        actorType: actor.type,
        type: eventType,
        createdAt: { gte: since },
        ...where,
      },
      select: { id: true },
    });
    return r !== null;
  } catch {
    return false;
  }
}

async function evaluateTimeSince(
  node: Record<string, unknown>,
  actor: Actor,
  deps: EvalDeps,
): Promise<boolean> {
  const eventType = typeof node.event === 'string' ? node.event : null;
  if (!eventType || !deps.events) return false;
  let last: { createdAt: Date } | null = null;
  try {
    last = await deps.events.actorEvent.findFirst({
      where: { actorId: actor.id, actorType: actor.type, type: eventType },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
  } catch {
    return false;
  }
  if (!last) {
    // Никогда не было события: timeSince > X → true (бесконечно давно).
    return true;
  }
  const ageMs = Date.now() - last.createdAt.getTime();
  if (typeof node.gtMin === 'number') return ageMs > node.gtMin * 60_000;
  if (typeof node.gtHours === 'number') return ageMs > node.gtHours * 3_600_000;
  if (typeof node.gtDays === 'number') return ageMs > node.gtDays * 86_400_000;
  return false;
}

/* ─── helpers ───────────────────────────────────────────────────── */

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function sinceDate(node: Record<string, unknown>): Date | null {
  const now = Date.now();
  if (typeof node.windowMin === 'number') return new Date(now - node.windowMin * 60_000);
  if (typeof node.windowHours === 'number') return new Date(now - node.windowHours * 3_600_000);
  if (typeof node.windowDays === 'number') return new Date(now - node.windowDays * 86_400_000);
  if (typeof node.sinceDays === 'number') return new Date(now - node.sinceDays * 86_400_000);
  return null;
}

function compare(cnt: number, node: Record<string, unknown>): boolean {
  if (typeof node.gte === 'number') return cnt >= node.gte;
  if (typeof node.lte === 'number') return cnt <= node.lte;
  if (typeof node.eq === 'number') return cnt === node.eq;
  return false;
}

function compileEventWhere(where: unknown): Record<string, unknown> {
  // `where` — простые равенства по полям payload. Prisma jsonPath:
  // `payload: { path: ['rated'], equals: true }`. Поддерживаем плоские
  // ключи; вложенность можно добавить, когда понадобится.
  //
  // KS-4782: исправлена регрессия KS-4757. Prisma 6 JSONFilter НЕ имеет
  // оператора `string_equals` (см. packages/events-db/src/generated/
  // prisma/commonInputTypes.ts → JsonFilterBase: equals, string_contains,
  // string_starts_with, string_ends_with, array_*, но НЕ string_equals).
  // KS-4757 фикс собирал `payload.string_equals: v` для строк — Prisma
  // throw'ил «Unknown argument `string_equals`», evaluateCount ловил
  // exception (return false), все правила с payload-фильтрами (analyze-
  // after-loss, bridge-promo-after-3-wasm и т.п.) НИКОГДА не матчили в
  // проде. Возвращаем единый `equals` — для строки Prisma внутри
  // строит SQL `payload#>>'{result}' = 'loss'`, что корректно.
  if (!isObj(where)) return {};
  const conds: Array<Record<string, unknown>> = [];
  for (const [k, v] of Object.entries(where)) {
    conds.push({ payload: { path: [k], equals: v as Prisma.InputJsonValue } });
  }
  return conds.length > 0 ? { AND: conds } : {};
}

/** Простой glob: `*` → `[^/]*` (один сегмент). Совпадает с фронтовым
 *  чувством «/play/*» = «/play/<anything-but-deeper>». Никаких **. */
export function globMatch(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
  return new RegExp('^' + escaped + '$').test(value);
}

// Узкий type-only импорт, чтобы не тянуть весь @kingside/events-db
// в runtime evaluator-файла.
import type { Prisma } from '@kingside/events-db';

/* ─── validateRule (KS-4702) ──────────────────────────────────── */

/**
 * KS-4702: статическая проверка DSL-правила без обращения к БД. Бросает
 * `Error` с понятным message на первом проблемном узле. Используется
 * `HintsAdminService.create/update` для возврата 400.
 *
 * Контракт совпадает с `evaluateRule` — те же операторы, те же
 * обязательные поля. Если evaluator расширили, не забыть обновить
 * этот валидатор и спецификации.
 */
export function validateRule(rule: unknown, path: string = '$'): void {
  if (rule === null || typeof rule !== 'object' || Array.isArray(rule)) {
    throw new Error(`${path}: правило должно быть объектом-DSL`);
  }
  const r = rule as Record<string, unknown>;
  const keys = Object.keys(r);
  if (keys.length === 0) {
    throw new Error(`${path}: правило не содержит операторов`);
  }
  const KNOWN = ['all', 'any', 'not', 'page', 'actorType', 'count', 'exists', 'timeSince'];
  for (const k of keys) {
    if (!KNOWN.includes(k)) {
      throw new Error(
        `${path}.${k}: неизвестный оператор (известные: ${KNOWN.join(', ')})`,
      );
    }
  }

  if (Array.isArray(r.all)) {
    r.all.forEach((sub, i) => validateRule(sub, `${path}.all[${i}]`));
  }
  if (Array.isArray(r.any)) {
    r.any.forEach((sub, i) => validateRule(sub, `${path}.any[${i}]`));
  }
  if ('not' in r) {
    validateRule(r.not, `${path}.not`);
  }
  if (isObj(r.page)) {
    if (typeof (r.page as Record<string, unknown>).matches !== 'string') {
      throw new Error(`${path}.page.matches: ожидается строка-glob`);
    }
  }
  if (isObj(r.actorType)) {
    const eq = (r.actorType as Record<string, unknown>).equals;
    if (eq !== 'user' && eq !== 'guest') {
      throw new Error(`${path}.actorType.equals: ожидается 'user' или 'guest'`);
    }
  }
  if (isObj(r.count)) {
    validateAggregateOperator(r.count as Record<string, unknown>, `${path}.count`, true);
  }
  if (isObj(r.exists)) {
    validateAggregateOperator(r.exists as Record<string, unknown>, `${path}.exists`, false);
  }
  if (isObj(r.timeSince)) {
    const n = r.timeSince as Record<string, unknown>;
    if (typeof n.event !== 'string' || n.event.length === 0) {
      throw new Error(`${path}.timeSince.event: ожидается имя события`);
    }
    const hasTime = ['gtMin', 'gtHours', 'gtDays'].some(
      (k) => typeof n[k] === 'number' && (n[k] as number) > 0,
    );
    if (!hasTime) {
      throw new Error(`${path}.timeSince: укажи gtMin / gtHours / gtDays > 0`);
    }
  }
}

function validateAggregateOperator(
  n: Record<string, unknown>,
  path: string,
  requireComparison: boolean,
): void {
  if (typeof n.event !== 'string' || n.event.length === 0) {
    throw new Error(`${path}.event: ожидается имя события`);
  }
  const hasWindow = ['windowMin', 'windowHours', 'windowDays', 'sinceDays'].some(
    (k) => typeof n[k] === 'number' && (n[k] as number) > 0,
  );
  if (!hasWindow) {
    throw new Error(
      `${path}: укажи окно (windowMin / windowHours / windowDays / sinceDays) > 0`,
    );
  }
  if (requireComparison) {
    const hasCmp = ['gte', 'lte', 'eq'].some((k) => typeof n[k] === 'number');
    if (!hasCmp) {
      throw new Error(`${path}: укажи сравнение (gte / lte / eq)`);
    }
  }
  if (n.where !== undefined && !isObj(n.where)) {
    throw new Error(`${path}.where: должно быть object-key:value`);
  }
}
