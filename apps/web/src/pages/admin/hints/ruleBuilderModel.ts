/**
 * KS-4830. Модель визуального конструктора правил подсказок и
 * двунаправленная сериализация в существующий DSL-JSON.
 *
 * DSL — см. `apps/api/src/hints/hints-dsl.evaluator.ts`. Конструктор
 * не пытается покрыть все edge-case'ы (`layer`, `gtHours`, и т.п.), но
 * поддерживает все операторы, реально используемые в seed'ах:
 *   all / any / not / page.matches / actorType.equals /
 *   count{event,where?,window*,gte|lte|eq} /
 *   exists{event,where?,window*} /
 *   timeSince{event,gt*}
 *
 * Если приходящий JSON содержит что-то непокрытое — `decode()` вернёт
 * `null`, и UI откатится на Raw-JSON-режим (без потери данных).
 */

export type WindowUnit =
  | 'windowMin'
  | 'windowHours'
  | 'windowDays'
  | 'sinceDays';

export type TimeSinceUnit = 'gtMin' | 'gtHours' | 'gtDays';

export type CompareOp = 'gte' | 'lte' | 'eq';

export interface WhereEntry {
  key: string;
  value: string;
}

export type RuleNode =
  | { kind: 'all'; children: RuleNode[] }
  | { kind: 'any'; children: RuleNode[] }
  | { kind: 'not'; child: RuleNode }
  | { kind: 'page'; matches: string }
  | { kind: 'actorType'; equals: '' | 'user' | 'guest' }
  | {
      kind: 'count';
      event: string;
      where: WhereEntry[];
      windowUnit: WindowUnit;
      windowValue: string;
      op: CompareOp;
      opValue: string;
    }
  | {
      kind: 'exists';
      event: string;
      where: WhereEntry[];
      windowUnit: WindowUnit;
      windowValue: string;
    }
  | {
      kind: 'timeSince';
      event: string;
      sinceUnit: TimeSinceUnit;
      sinceValue: string;
    };

export type RuleKind = RuleNode['kind'];

/* ─── helpers ──────────────────────────────────────────────────── */

const WINDOW_UNITS: ReadonlyArray<WindowUnit> = [
  'windowMin',
  'windowHours',
  'windowDays',
  'sinceDays',
];

const TIME_SINCE_UNITS: ReadonlyArray<TimeSinceUnit> = [
  'gtMin',
  'gtHours',
  'gtDays',
];

const COMPARE_OPS: ReadonlyArray<CompareOp> = ['gte', 'lte', 'eq'];

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isNumberString(s: string): boolean {
  if (s.trim() === '') return false;
  const n = Number(s);
  return Number.isFinite(n);
}

function isPositiveNumberString(s: string): boolean {
  if (s.trim() === '') return false;
  const n = Number(s);
  return Number.isFinite(n) && n > 0;
}

function whereToObj(entries: WhereEntry[]): Record<string, string> | null {
  const filtered = entries.filter((e) => e.key.trim().length > 0);
  if (filtered.length === 0) return null;
  const out: Record<string, string> = {};
  for (const e of filtered) out[e.key.trim()] = e.value;
  return out;
}

function whereFromObj(obj: unknown): WhereEntry[] {
  if (!isObj(obj)) return [];
  return Object.entries(obj).map(([key, value]) => ({
    key,
    value: typeof value === 'string' ? value : JSON.stringify(value),
  }));
}

/* ─── encode (node → JSON) ─────────────────────────────────────── */

export function encode(node: RuleNode): unknown {
  switch (node.kind) {
    case 'all':
      return { all: node.children.map(encode) };
    case 'any':
      return { any: node.children.map(encode) };
    case 'not':
      return { not: encode(node.child) };
    case 'page':
      return { page: { matches: node.matches } };
    case 'actorType':
      return { actorType: { equals: node.equals } };
    case 'count': {
      const inner: Record<string, unknown> = { event: node.event };
      const w = whereToObj(node.where);
      if (w) inner.where = w;
      const wv = Number(node.windowValue);
      if (Number.isFinite(wv)) inner[node.windowUnit] = wv;
      const ov = Number(node.opValue);
      if (Number.isFinite(ov)) inner[node.op] = ov;
      return { count: inner };
    }
    case 'exists': {
      const inner: Record<string, unknown> = { event: node.event };
      const w = whereToObj(node.where);
      if (w) inner.where = w;
      const wv = Number(node.windowValue);
      if (Number.isFinite(wv)) inner[node.windowUnit] = wv;
      return { exists: inner };
    }
    case 'timeSince': {
      const inner: Record<string, unknown> = { event: node.event };
      const sv = Number(node.sinceValue);
      if (Number.isFinite(sv)) inner[node.sinceUnit] = sv;
      return { timeSince: inner };
    }
  }
}

/* ─── decode (JSON → node) ─────────────────────────────────────── */

export function decode(rule: unknown): RuleNode | null {
  if (!isObj(rule)) return null;
  const keys = Object.keys(rule);
  if (keys.length !== 1) return null;
  const k = keys[0];
  switch (k) {
    case 'all': {
      const arr = rule.all;
      if (!Array.isArray(arr)) return null;
      const children = arr.map(decode);
      if (children.some((c) => c === null)) return null;
      return { kind: 'all', children: children as RuleNode[] };
    }
    case 'any': {
      const arr = rule.any;
      if (!Array.isArray(arr)) return null;
      const children = arr.map(decode);
      if (children.some((c) => c === null)) return null;
      return { kind: 'any', children: children as RuleNode[] };
    }
    case 'not': {
      const child = decode(rule.not);
      return child ? { kind: 'not', child } : null;
    }
    case 'page': {
      const inner = rule.page;
      if (!isObj(inner)) return null;
      const m = inner.matches;
      if (typeof m !== 'string') return null;
      // Только matches; присутствие других полей — расширение DSL,
      // которое мы не поддерживаем визуально → fallback.
      if (Object.keys(inner).length !== 1) return null;
      return { kind: 'page', matches: m };
    }
    case 'actorType': {
      const inner = rule.actorType;
      if (!isObj(inner)) return null;
      const eq = inner.equals;
      if (eq !== 'user' && eq !== 'guest') return null;
      if (Object.keys(inner).length !== 1) return null;
      return { kind: 'actorType', equals: eq };
    }
    case 'count':
      return decodeCount(rule.count);
    case 'exists':
      return decodeExists(rule.exists);
    case 'timeSince':
      return decodeTimeSince(rule.timeSince);
    default:
      return null;
  }
}

function decodeCount(inner: unknown): RuleNode | null {
  if (!isObj(inner)) return null;
  const event = inner.event;
  if (typeof event !== 'string' || event.length === 0) return null;

  // Найти window-unit (один и только один).
  const wins = WINDOW_UNITS.filter(
    (u) => typeof inner[u] === 'number',
  );
  if (wins.length > 1) return null;
  const windowUnit = (wins[0] ?? 'windowDays') as WindowUnit;
  const windowValue =
    typeof inner[windowUnit] === 'number' ? String(inner[windowUnit]) : '';

  // compare-op
  const cmps = COMPARE_OPS.filter((u) => typeof inner[u] === 'number');
  if (cmps.length > 1) return null;
  const op = (cmps[0] ?? 'gte') as CompareOp;
  const opValue = typeof inner[op] === 'number' ? String(inner[op]) : '';

  // where
  const where = whereFromObj(inner.where);

  // Неизвестные поля — расширение DSL, fallback.
  const known = new Set<string>([
    'event',
    'where',
    ...WINDOW_UNITS,
    ...COMPARE_OPS,
  ]);
  for (const k of Object.keys(inner)) {
    if (!known.has(k)) return null;
  }

  return {
    kind: 'count',
    event,
    where,
    windowUnit,
    windowValue,
    op,
    opValue,
  };
}

function decodeExists(inner: unknown): RuleNode | null {
  if (!isObj(inner)) return null;
  const event = inner.event;
  if (typeof event !== 'string' || event.length === 0) return null;

  const wins = WINDOW_UNITS.filter((u) => typeof inner[u] === 'number');
  if (wins.length > 1) return null;
  const windowUnit = (wins[0] ?? 'windowDays') as WindowUnit;
  const windowValue =
    typeof inner[windowUnit] === 'number' ? String(inner[windowUnit]) : '';

  const where = whereFromObj(inner.where);

  const known = new Set<string>(['event', 'where', ...WINDOW_UNITS]);
  for (const k of Object.keys(inner)) {
    if (!known.has(k)) return null;
  }

  return { kind: 'exists', event, where, windowUnit, windowValue };
}

function decodeTimeSince(inner: unknown): RuleNode | null {
  if (!isObj(inner)) return null;
  const event = inner.event;
  if (typeof event !== 'string' || event.length === 0) return null;

  const sincs = TIME_SINCE_UNITS.filter(
    (u) => typeof inner[u] === 'number',
  );
  if (sincs.length > 1) return null;
  const sinceUnit = (sincs[0] ?? 'gtMin') as TimeSinceUnit;
  const sinceValue =
    typeof inner[sinceUnit] === 'number' ? String(inner[sinceUnit]) : '';

  const known = new Set<string>(['event', ...TIME_SINCE_UNITS]);
  for (const k of Object.keys(inner)) {
    if (!known.has(k)) return null;
  }

  return { kind: 'timeSince', event, sinceUnit, sinceValue };
}

/* ─── validation ───────────────────────────────────────────────── */

/**
 * KS-4830. Базовая проверка, что узел заполнен достаточно для backend'а.
 * Возвращает массив сообщений; пустой массив = ок.
 */
export function validate(node: RuleNode, path = '$'): string[] {
  const errs: string[] = [];
  switch (node.kind) {
    case 'all':
    case 'any':
      if (node.children.length === 0) {
        errs.push(`${path}: ${node.kind} требует хотя бы один дочерний узел`);
      }
      node.children.forEach((c, i) =>
        errs.push(...validate(c, `${path}.${node.kind}[${i}]`)),
      );
      break;
    case 'not':
      errs.push(...validate(node.child, `${path}.not`));
      break;
    case 'page':
      if (!node.matches.trim()) {
        errs.push(`${path}.page.matches: укажите шаблон страницы`);
      }
      break;
    case 'actorType':
      if (node.equals === '') {
        errs.push(`${path}.actorType.equals: выберите user или guest`);
      }
      break;
    case 'count': {
      if (!node.event.trim()) {
        errs.push(`${path}.count.event: выберите тип события`);
      }
      if (!isPositiveNumberString(node.windowValue)) {
        errs.push(`${path}.count.${node.windowUnit}: число > 0`);
      }
      if (!isNumberString(node.opValue)) {
        errs.push(`${path}.count.${node.op}: число обязательно`);
      }
      break;
    }
    case 'exists': {
      if (!node.event.trim()) {
        errs.push(`${path}.exists.event: выберите тип события`);
      }
      if (!isPositiveNumberString(node.windowValue)) {
        errs.push(`${path}.exists.${node.windowUnit}: число > 0`);
      }
      break;
    }
    case 'timeSince': {
      if (!node.event.trim()) {
        errs.push(`${path}.timeSince.event: выберите тип события`);
      }
      if (!isPositiveNumberString(node.sinceValue)) {
        errs.push(`${path}.timeSince.${node.sinceUnit}: число > 0`);
      }
      break;
    }
  }
  return errs;
}

/* ─── factory ─────────────────────────────────────────────────── */

export function emptyNode(kind: RuleKind): RuleNode {
  switch (kind) {
    case 'all':
      return { kind: 'all', children: [] };
    case 'any':
      return { kind: 'any', children: [] };
    case 'not':
      return { kind: 'not', child: { kind: 'all', children: [] } };
    case 'page':
      return { kind: 'page', matches: '' };
    case 'actorType':
      return { kind: 'actorType', equals: '' };
    case 'count':
      return {
        kind: 'count',
        event: '',
        where: [],
        windowUnit: 'windowDays',
        windowValue: '7',
        op: 'gte',
        opValue: '1',
      };
    case 'exists':
      return {
        kind: 'exists',
        event: '',
        where: [],
        windowUnit: 'windowDays',
        windowValue: '7',
      };
    case 'timeSince':
      return {
        kind: 'timeSince',
        event: '',
        sinceUnit: 'gtMin',
        sinceValue: '30',
      };
  }
}
