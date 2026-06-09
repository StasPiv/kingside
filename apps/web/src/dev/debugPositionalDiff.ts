/**
 * KS-4017 / KS-4020 / KS-4021. Отладочная функция консоли: сравнительная
 * таблица позиционных факторов Stockfish (Белые − Чёрные).
 *
 * Применение:
 *   await window.__ksPositionalDiff()
 *
 * KS-4021. Реализация один-в-один с AI-комментарием (`useAiPositionComment`):
 *   1. Берём текущий FEN со страницы анализа (`window.__sfTraceFen`).
 *   2. Зовём `collectAiFactors({ fen, engineProbe })` — ту же чистую
 *      цепочку, что использует AI: `evalTrace(fen)` → engineProbe → PV
 *      → `evalTrace(terminalFen)` → `mergeFactors`.
 *   3. Полученный массив (тот же, что улетает на сервер) пропускаем
 *      через `aggregatePositionalDiff` — суммирование по сторонам и
 *      разница Б−Ч.
 *   4. Печатаем `console.table` и возвращаем строки.
 *
 * `engineProbe` берём из `window.__ksEngineProbe`, который выставляет
 * `AnalysisPage` (тот же callback, что хук получает напрямую). Если
 * страница не открыта или probe ещё не выставился — fallback на
 * один вызов `evalTrace` без терминального прохода (как когда движок
 * ещё не успел отдать линию — поведение KS-3685).
 *
 * Включение:
 *   - В dev (`import.meta.env.DEV`) — всегда.
 *   - В prod — установить `localStorage.setItem('ks:dev','1')` и
 *     перезагрузить страницу.
 */
import type {
  PositionalSubterm,
  PositionalSubtermId,
} from '@kingside/shared';
import {
  collectAiFactors,
  type EngineBestLineInput,
} from '../lib/review/collectAiFactors';

/** Одна строка итоговой таблицы: разница «Белые − Чёрные». */
export interface PositionalDiffRow {
  param: PositionalSubtermId | 'unknown';
  diff_mg: number;
  diff_eg: number;
  white_mg: number;
  black_mg: number;
  white_eg: number;
  black_eg: number;
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

/**
 * Чистая функция-агрегатор. Принимает массив подкомпонент (тот же
 * `mergedFactors`, что улетает на сервер; может содержать нестандартные
 * элементы вроде `sf18_eval`/`sf18_pv` — их мы отфильтровываем по
 * наличию `value_mg`/`value_eg`), возвращает таблицу «Белые − Чёрные».
 *
 * Правила:
 *  - Только записи с числовыми `value_mg` и `value_eg` агрегируются.
 *  - Поля без `color` (side-agnostic — `material`/`imbalance` —
 *    SF трактует как баланс с учётом сторон) суммируются в белые.
 *  - `diff_mg = white_mg − black_mg`, аналогично `diff_eg`.
 *  - Сортировка по убыванию `diff_mg`. На равных — стабильно по `param`.
 *  - Округление до 3 знаков.
 */
export function aggregatePositionalDiff(
  subterms: ReadonlyArray<unknown>,
): PositionalDiffRow[] {
  const byId = new Map<
    string,
    { white_mg: number; black_mg: number; white_eg: number; black_eg: number }
  >();

  for (const raw of subterms) {
    if (!raw || typeof raw !== 'object') continue;
    const s = raw as Partial<PositionalSubterm>;
    if (typeof s.id !== 'string') continue;
    if (typeof s.value_mg !== 'number' || !Number.isFinite(s.value_mg)) continue;
    if (typeof s.value_eg !== 'number' || !Number.isFinite(s.value_eg)) continue;
    const bucket = byId.get(s.id) ?? {
      white_mg: 0,
      black_mg: 0,
      white_eg: 0,
      black_eg: 0,
    };
    if (s.color === 'b') {
      bucket.black_mg += s.value_mg;
      bucket.black_eg += s.value_eg;
    } else {
      bucket.white_mg += s.value_mg;
      bucket.white_eg += s.value_eg;
    }
    byId.set(s.id, bucket);
  }

  const rows: PositionalDiffRow[] = [];
  for (const [id, b] of byId) {
    rows.push({
      param: id as PositionalSubtermId | 'unknown',
      diff_mg: round3(b.white_mg - b.black_mg),
      diff_eg: round3(b.white_eg - b.black_eg),
      white_mg: round3(b.white_mg),
      black_mg: round3(b.black_mg),
      white_eg: round3(b.white_eg),
      black_eg: round3(b.black_eg),
    });
  }

  rows.sort((a, b) => {
    if (a.diff_mg === b.diff_mg) {
      return a.param < b.param ? -1 : a.param > b.param ? 1 : 0;
    }
    return b.diff_mg - a.diff_mg;
  });

  return rows;
}

/**
 * Сама консольная команда. Async — `evalTrace` + probe выполняются
 * асинхронно.
 */
export async function debugPositionalDiff(
  fenArg?: string,
): Promise<PositionalDiffRow[]> {
  const fen = fenArg ?? (typeof window !== 'undefined' ? window.__sfTraceFen : undefined);
  if (!fen) {
    console.warn(
      '[ksPositionalDiff] Откройте /analysis перед вызовом или передайте FEN явно: window.__ksPositionalDiff("<fen>")',
    );
    return [];
  }

  const engineProbe =
    typeof window !== 'undefined' ? window.__ksEngineProbe ?? null : null;
  if (!engineProbe) {
    console.warn(
      '[ksPositionalDiff] window.__ksEngineProbe не выставлен — собираю только исходную позицию без терминального прохода (Stockfish-18 не подключён).',
    );
  }

  let result: Awaited<ReturnType<typeof collectAiFactors>>;
  try {
    result = await collectAiFactors({ fen, engineProbe });
  } catch (err) {
    console.warn('[ksPositionalDiff] collectAiFactors упал:', err);
    return [];
  }

  const rows = aggregatePositionalDiff(result.mergedFactors);
  if (rows.length === 0) {
    console.warn(
      '[ksPositionalDiff] Stockfish не вернул ни одной подкомпоненты с числовыми value_mg/value_eg. fen=',
      fen,
      'bestLine=',
      result.bestLine,
    );
    return [];
  }

  // eslint-disable-next-line no-console
  console.table(
    rows.map((r) => ({
      param: r.param,
      diff_mg: r.diff_mg,
      diff_eg: r.diff_eg,
    })),
  );
  return rows;
}

/**
 * Регистрирует функцию на глобальном объекте `window` под условием
 * dev-режима или явного opt-in через localStorage.
 */
declare global {
  interface Window {
    __ksPositionalDiff?: (fen?: string) => Promise<PositionalDiffRow[]>;
    __ksEngineProbe?:
      | (() => Promise<EngineBestLineInput | null>)
      | undefined;
  }
}

export function maybeRegisterPositionalDiff(): void {
  if (typeof window === 'undefined') return;
  let optedIn = false;
  try {
    optedIn = window.localStorage.getItem('ks:dev') === '1';
  } catch {
    /* localStorage недоступен (private mode) — opt-in не активен */
  }
  if (!import.meta.env.DEV && !optedIn) return;
  window.__ksPositionalDiff = debugPositionalDiff;
  // eslint-disable-next-line no-console
  console.info(
    "[ksPositionalDiff] готово: window.__ksPositionalDiff(fen?) — таблица «Белые − Чёрные» по позиционным факторам Stockfish (тот же массив, что улетает в AI-комментарий).%s",
    import.meta.env.DEV
      ? ''
      : ' (включено через localStorage `ks:dev`=1)',
  );
}

// Авторегистрация при импорте модуля.
maybeRegisterPositionalDiff();
