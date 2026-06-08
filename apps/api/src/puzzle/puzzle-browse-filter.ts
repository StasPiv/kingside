/**
 * KS-3893. Построение SQL-фильтра для `/puzzles/browse` и
 * `/puzzles/browse/count`. Выделено из контроллера, чтобы
 * не дублировать ~200 строк нормализации/валидации между двумя
 * обработчиками.
 *
 * Возвращает массив `conditions` (WHERE-фрагменты, склеиваются через
 * `AND`), упорядоченный `params` под `$1..$N` плейсхолдеры и
 * выражение `blundererEloExpr` (CASE по side-to-move) — нужно
 * контроллеру и для SELECT-части, и при наличии фильтра по ELO
 * зевнувшего.
 *
 * Семантика отдельных фильтров полностью повторяет историческое
 * поведение (KS-2556 / KS-2560 / KS-2582 / KS-2761 / KS-2762 /
 * KS-3353 / KS-3357 / KS-3656 / KS-3670 / ADR-050 / ADR-079 /
 * ADR-080 / ADR-106). Контроллер при необходимости добавляет
 * к результату cursor-условие, solvedStatus-subquery и LIMIT.
 */
import { BadRequestException } from '@nestjs/common';
import { isPrecisionRelevantTheme } from '@kingside/shared';

/**
 * Сырые query-параметры обработчика `browse`. Все поля опциональны
 * — типы повторяют сигнатуру контроллера (string|string[]|undefined),
 * никаких приведений на стороне вызова не требуется.
 */
export interface BrowseFilterInput {
  userId: string | null;
  mine?: string;
  themes?: string;
  ratingMin?: string;
  ratingMax?: string;
  hideSolved?: string;
  source?: string;
  visibility?: string;
  excludeMine?: string;
  blundererEloMin?: string;
  blundererEloMax?: string;
  themesAnd?: string | string[];
  themesOr?: string | string[];
  minMaiaWeakChoiceProb?: string;
  maxMaiaWeakChoiceProb?: string;
}

export interface BrowseFilterResult {
  /**
   * Готовые WHERE-фрагменты, без префикса WHERE и без `AND` между
   * собой. Вызов: `WHERE ${conditions.join(' AND ')}`.
   */
  conditions: string[];
  /**
   * Позиционные параметры для $queryRawUnsafe. Первый элемент
   * соответствует `$1`, второй — `$2` и т.д. (нумерация в conditions
   * уже сгенерирована из этого индекса).
   */
  params: (string | number)[];
  /**
   * KS-2761. Выражение CASE для рейтинга зевнувшего, используется
   * контроллером в SELECT-части и (при заданных границах) дублируется
   * в WHERE.
   */
  blundererEloExpr: string;
  /**
   * KS-3891. `idx` после построения фильтр-блока. Контроллер
   * использует значение для продолжения нумерации $-плейсхолдеров
   * при добавлении cursor и LIMIT.
   */
  nextParamIndex: number;
}

const ALLOWED_SOURCES = new Set(['lichess', 'generated']);
const ALLOWED_VISIBILITY = new Set(['public', 'draft', 'all']);

const BLUNDERER_ELO_EXPR = `CASE
      WHEN split_part((p.source_metadata::jsonb)->>'fenBeforeBlunder', ' ', 2) = 'w' THEN p.source_white_elo
      WHEN split_part((p.source_metadata::jsonb)->>'fenBeforeBlunder', ' ', 2) = 'b' THEN p.source_black_elo
      ELSE NULL
    END`;

function normalizeThemes(input: string | string[] | undefined): string[] {
  if (!input) return [];
  const arr = Array.isArray(input) ? input : [input];
  const out: string[] = [];
  for (const v of arr) {
    const parts = v.split(',').map((t) => t.trim()).filter(Boolean);
    for (const p of parts) {
      if (isPrecisionRelevantTheme(p)) out.push(p);
    }
  }
  return Array.from(new Set(out));
}

function parseMaiaProb(raw: string | undefined, paramName: string): number | undefined {
  if (raw === undefined) return undefined;
  const v = parseFloat(raw);
  if (!Number.isFinite(v) || v < 0 || v > 1) {
    throw new BadRequestException(
      `${paramName} must be a number in [0, 1] (got '${raw}')`,
    );
  }
  return v;
}

/**
 * Построить WHERE-фильтр и параметры для запросов `puzzles.browse` /
 * `puzzles.browse/count`. Контроллер дальше добавляет cursor / LIMIT
 * и формирует финальный SQL.
 *
 * При невалидных параметрах кидает `BadRequestException` — Nest
 * автоматически превращает в 400.
 */
export function buildBrowseFilterSql(input: BrowseFilterInput): BrowseFilterResult {
  const {
    userId,
    mine,
    themes,
    ratingMin: ratingMinStr,
    ratingMax: ratingMaxStr,
    hideSolved,
    source: sourceParam,
    visibility: visibilityParam,
    excludeMine: excludeMineParam,
    blundererEloMin: blundererEloMinStr,
    blundererEloMax: blundererEloMaxStr,
    themesAnd: themesAndParam,
    themesOr: themesOrParam,
    minMaiaWeakChoiceProb: minMaiaWeakChoiceProbStr,
    maxMaiaWeakChoiceProb: maxMaiaWeakChoiceProbStr,
  } = input;

  // KS-2556 whitelist `source`.
  const sourceFilter =
    sourceParam && ALLOWED_SOURCES.has(sourceParam) ? sourceParam : null;

  // KS-2582 whitelist `visibility`.
  if (visibilityParam !== undefined && !ALLOWED_VISIBILITY.has(visibilityParam)) {
    throw new BadRequestException(
      `visibility must be one of: public, draft, all (got '${visibilityParam}')`,
    );
  }
  const visibility = visibilityParam ?? 'all';
  if (visibility === 'draft' && (mine !== 'true' || !userId)) {
    throw new BadRequestException(
      "visibility='draft' requires authenticated mine=true (drafts are private)",
    );
  }

  const conditions: string[] = [];
  const params: (string | number)[] = [];
  let idx = 1;
  const next = (): string => `$${idx++}`;

  if (sourceFilter !== null) {
    conditions.push(`p.source = ${next()}`);
    params.push(sourceFilter);
  }

  const excludeMine = excludeMineParam === 'true';
  if (mine === 'true' && userId) {
    conditions.push(`p.created_by = ${next()}::uuid`);
    params.push(userId);
    if (visibility === 'public') {
      conditions.push('p.is_public = true');
    } else if (visibility === 'draft') {
      conditions.push('p.is_public = false');
    }
  } else if (excludeMine && userId) {
    // KS-3353 / ADR-079 scope=server.
    conditions.push('p.is_public = true');
    const ph = next();
    conditions.push(`(p.created_by IS NULL OR p.created_by != ${ph}::uuid)`);
    params.push(userId);
  } else if (userId) {
    const placeholder = next();
    conditions.push(`(p.created_by = ${placeholder}::uuid OR p.is_public = true)`);
    params.push(userId);
  } else {
    conditions.push('p.is_public = true');
  }

  // KS-3357 / ADR-080 §4.1.
  const themesAndList = normalizeThemes(themesAndParam);
  let themesOrList = normalizeThemes(themesOrParam);
  if (themesOrList.length === 0 && themes) {
    themesOrList = normalizeThemes(themes);
  }
  if (themesAndList.length > 5) {
    throw new BadRequestException('themesAnd[] limit 5');
  }
  if (themesOrList.length > 10) {
    throw new BadRequestException('themesOr[] limit 10');
  }
  if (themesAndList.length > 0) {
    for (const t of themesAndList) {
      const ph = next();
      params.push(`%${t}%`);
      conditions.push(`p.themes LIKE ${ph}`);
    }
  }
  if (themesOrList.length > 0) {
    const orParts = themesOrList.map((t) => {
      const ph = next();
      params.push(`%${t}%`);
      return `p.themes LIKE ${ph}`;
    });
    conditions.push(`(${orParts.join(' OR ')})`);
  }

  if (ratingMinStr) {
    conditions.push(`p.rating >= ${next()}`);
    params.push(parseInt(ratingMinStr, 10));
  }
  if (ratingMaxStr) {
    conditions.push(`p.rating <= ${next()}`);
    params.push(parseInt(ratingMaxStr, 10));
  }

  // KS-2762.
  if (blundererEloMinStr) {
    const v = parseInt(blundererEloMinStr, 10);
    if (Number.isFinite(v)) {
      conditions.push(`${BLUNDERER_ELO_EXPR} >= ${next()}`);
      params.push(v);
    }
  }
  if (blundererEloMaxStr) {
    const v = parseInt(blundererEloMaxStr, 10);
    if (Number.isFinite(v)) {
      conditions.push(`${BLUNDERER_ELO_EXPR} <= ${next()}`);
      params.push(v);
    }
  }

  if (hideSolved === 'true' && userId) {
    const ph = next();
    conditions.push(
      `NOT EXISTS (SELECT 1 FROM puzzle_attempts pa WHERE pa.puzzle_id = p.id AND pa.user_id = ${ph}::uuid)`,
    );
    params.push(userId);
  }

  // KS-3656 / KS-3670 / ADR-106 §2.6.
  const minMaiaProb = parseMaiaProb(minMaiaWeakChoiceProbStr, 'minMaiaWeakChoiceProb');
  const maxMaiaProb = parseMaiaProb(maxMaiaWeakChoiceProbStr, 'maxMaiaWeakChoiceProb');
  if (
    minMaiaProb !== undefined &&
    maxMaiaProb !== undefined &&
    minMaiaProb > maxMaiaProb
  ) {
    throw new BadRequestException(
      `minMaiaWeakChoiceProb (${minMaiaProb}) must be <= maxMaiaWeakChoiceProb (${maxMaiaProb})`,
    );
  }
  const wantMin = minMaiaProb !== undefined && minMaiaProb > 0;
  const wantMax = maxMaiaProb !== undefined && maxMaiaProb < 1;
  if (wantMin) {
    conditions.push(`p.maia_weak_choice_prob >= ${next()}`);
    params.push(minMaiaProb as number);
  }
  if (wantMax) {
    conditions.push(`p.maia_weak_choice_prob <= ${next()}`);
    params.push(maxMaiaProb as number);
  }
  if (wantMin || wantMax) {
    conditions.push('p.maia_metric_version = 1');
  }

  return {
    conditions,
    params,
    blundererEloExpr: BLUNDERER_ELO_EXPR,
    nextParamIndex: idx,
  };
}
