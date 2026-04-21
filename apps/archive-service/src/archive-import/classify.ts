/**
 * Классификация партий по типу контроля времени (ADR-015 §1, §2.4).
 *
 * Чистые функции, без I/O. Используются в парсере PGN (`parseGame`) и в
 * TWIC-пайплайне для записи `archive_games.time_control / category /
 * is_classical` и последующей фильтрации позиционного индекса.
 */

export type GameCategory =
  | 'classical'
  | 'classical-legacy'
  | 'rapid'
  | 'blitz'
  | 'bullet'
  | 'correspondence'
  | 'online-unknown'
  | 'unknown';

/** Пороги FIDE (секунды эффективного времени на 60 ходов). */
const CLASSICAL_THRESHOLD_SEC = 3600;
const RAPID_THRESHOLD_SEC = 600;
const BLITZ_THRESHOLD_SEC = 180;
/** «1 ход за сутки» — признак correspondence. */
const CORRESPONDENCE_PER_MOVE_SEC = 86400;

export interface TimeControlParsed {
  /** Сумма баз всех этапов (секунды). */
  baseSeconds: number;
  /** Последний ненулевой инкремент (секунды/ход). */
  incrementSeconds: number;
  /** `1/86400` или аналогичное per-move время ≥ 24ч. */
  isCorrespondence: boolean;
  /** Исходная строка для хранения в БД. */
  raw: string;
}

/**
 * Разбор `TimeControl` тега PGN в базовые числа.
 *
 * Поддержанные формы (PGN Standard + de-facto использование TWIC/Lichess):
 *   - `5400+30`, `60+0`, `180+1`            — sudden death + инкремент
 *   - `5400`                                — sudden death без инкремента
 *   - `40/7200`                             — одиночный этап `N ходов / X секунд`
 *   - `40/7200:3600`                        — этап + sudden death
 *   - `40/7200+30:3600+30`                  — этапы с инкрементом
 *   - `1/86400`                             — correspondence
 *   - `-`, пустая строка, `null`, `?`       — unknown
 *
 * Unrecognised формы возвращают `null` — caller трактует как unknown TC.
 */
export function parseTimeControl(tc: string | null | undefined): TimeControlParsed | null {
  if (tc == null) return null;
  const trimmed = tc.trim();
  if (trimmed === '' || trimmed === '-' || trimmed === '?') return null;

  const stages = trimmed.split(':');
  let baseSeconds = 0;
  let incrementSeconds = 0;
  let validStages = 0;

  for (const stage of stages) {
    // Correspondence-маркер: `1/86400` или `1/604800` и т.п.
    // Считаем correspondence, если seconds-per-move >= 24ч для singular move.
    const correspondence = stage.match(/^(\d+)\/(\d+)$/);
    if (correspondence) {
      const moves = parseInt(correspondence[1], 10);
      const seconds = parseInt(correspondence[2], 10);
      if (moves === 1 && seconds >= CORRESPONDENCE_PER_MOVE_SEC) {
        return {
          baseSeconds: 0,
          incrementSeconds: 0,
          isCorrespondence: true,
          raw: trimmed,
        };
      }
      // Иначе трактуем как стадию `N ходов / X секунд` — прибавляем секунды.
      baseSeconds += seconds;
      validStages++;
      continue;
    }

    // `N/X+Y` — стадия N ходов X сек + инкремент Y
    const stageWithInc = stage.match(/^(\d+)\/(\d+)\+(\d+)$/);
    if (stageWithInc) {
      baseSeconds += parseInt(stageWithInc[2], 10);
      incrementSeconds = parseInt(stageWithInc[3], 10);
      validStages++;
      continue;
    }

    // `X+Y` — sudden death с инкрементом
    const suddenInc = stage.match(/^(\d+)\+(\d+)$/);
    if (suddenInc) {
      baseSeconds += parseInt(suddenInc[1], 10);
      incrementSeconds = parseInt(suddenInc[2], 10);
      validStages++;
      continue;
    }

    // `X` — sudden death без инкремента
    const onlyBase = stage.match(/^(\d+)$/);
    if (onlyBase) {
      baseSeconds += parseInt(onlyBase[1], 10);
      validStages++;
      continue;
    }

    // Неизвестная форма — пропускаем, считаем unknown если ни одного этапа.
  }

  if (validStages === 0) return null;

  return {
    baseSeconds,
    incrementSeconds,
    isCorrespondence: false,
    raw: trimmed,
  };
}

export interface TimeControlClassification {
  category: GameCategory;
  isClassical: boolean;
  parsed: TimeControlParsed | null;
}

/**
 * Классифицирует одну строку `TimeControl` по FIDE-порогам (ADR-015 §1.1).
 *
 * Эффективное время = base + 60 × increment (среднеожидаемая партия — 60
 * ходов).
 */
export function classifyTimeControl(
  tc: string | null | undefined,
): TimeControlClassification {
  const parsed = parseTimeControl(tc);
  if (parsed === null) {
    return { category: 'unknown', isClassical: false, parsed: null };
  }
  if (parsed.isCorrespondence) {
    return { category: 'correspondence', isClassical: false, parsed };
  }
  const effective = parsed.baseSeconds + 60 * parsed.incrementSeconds;
  if (effective >= CLASSICAL_THRESHOLD_SEC) {
    return { category: 'classical', isClassical: true, parsed };
  }
  if (effective >= RAPID_THRESHOLD_SEC) {
    return { category: 'rapid', isClassical: false, parsed };
  }
  if (effective >= BLITZ_THRESHOLD_SEC) {
    return { category: 'blitz', isClassical: false, parsed };
  }
  return { category: 'bullet', isClassical: false, parsed };
}

// ─── Site / Event blacklist (ADR-015 §1.3) ──────────────────────────────

/**
 * Сайты онлайн-шахмат — при неизвестном TC на них партия трактуется как
 * `online-unknown`, а не `classical-legacy`. Регистр не важен.
 */
const ONLINE_SITE_BLACKLIST = [
  'chess.com',
  'lichess.org',
  'lichess',
  'chess24.com',
  'chess24',
  'playchess.com',
  'playchess',
  'icc.net',
  'internet chess club',
  'chessbase.com',
  'fide online',
];

/**
 * Событийные маркеры «точно онлайн-блиц/буллет», которые часто приходят
 * без TimeControl тега.
 */
const ONLINE_EVENT_BLACKLIST = [
  'titled tuesday',
  'titled cup',
  'bullet arena',
  'blitz arena',
  'speed chess',
  'arena titled',
  'fide online',
  'online olympiad',
];

function includesAny(haystack: string | null | undefined, needles: string[]): string | null {
  if (!haystack) return null;
  const lower = haystack.toLowerCase();
  for (const n of needles) {
    if (lower.includes(n)) return n;
  }
  return null;
}

export interface GameClassification {
  category: GameCategory;
  isClassical: boolean;
  /** Какое правило «выиграло» — удобно для метрик и отладки. */
  reason:
    | 'explicit_classical_tc'
    | 'explicit_correspondence_tc'
    | 'explicit_rapid_tc'
    | 'explicit_blitz_tc'
    | 'explicit_bullet_tc'
    | 'blacklist_site'
    | 'blacklist_event'
    | 'legacy_otb';
}

/**
 * Итоговая классификация партии с учётом TimeControl, Site и Event
 * (ADR-015 §1.3).
 *
 * Приоритеты:
 *   1. Явный classical TC (`5400+30`) → `classical`, ДАЖЕ если Site — lichess
 *      (кейс COVID Online Olympiad).
 *   2. Явный non-classical TC (rapid/blitz/bullet/correspondence) → своя
 *      категория.
 *   3. TC неизвестен → проверяем blacklist Site, затем Event →
 *      `online-unknown`.
 *   4. TC неизвестен и не-онлайн → `classical-legacy` (OTB до ~2005,
 *      многие TWIC-партии просто не проставляли тег).
 */
export function classifyGame(params: {
  timeControl: string | null | undefined;
  site: string | null | undefined;
  event: string | null | undefined;
}): GameClassification {
  const tc = classifyTimeControl(params.timeControl);

  // 1. Явный classical TC — наивысший приоритет.
  if (tc.category === 'classical') {
    return {
      category: 'classical',
      isClassical: true,
      reason: 'explicit_classical_tc',
    };
  }

  // 2. Остальные явные TC.
  if (tc.parsed !== null) {
    const reasonByCategory: Record<GameCategory, GameClassification['reason']> = {
      classical: 'explicit_classical_tc',
      'classical-legacy': 'legacy_otb',
      rapid: 'explicit_rapid_tc',
      blitz: 'explicit_blitz_tc',
      bullet: 'explicit_bullet_tc',
      correspondence: 'explicit_correspondence_tc',
      'online-unknown': 'blacklist_site',
      unknown: 'legacy_otb',
    };
    return {
      category: tc.category,
      isClassical: false,
      reason: reasonByCategory[tc.category],
    };
  }

  // 3. TC неизвестен — blacklist.
  if (includesAny(params.site, ONLINE_SITE_BLACKLIST)) {
    return { category: 'online-unknown', isClassical: false, reason: 'blacklist_site' };
  }
  if (includesAny(params.event, ONLINE_EVENT_BLACKLIST)) {
    return { category: 'online-unknown', isClassical: false, reason: 'blacklist_event' };
  }

  // 4. Fallback: OTB legacy.
  return {
    category: 'classical-legacy',
    isClassical: true,
    reason: 'legacy_otb',
  };
}
