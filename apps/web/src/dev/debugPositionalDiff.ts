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
import { PSQT_EXTRA_IDS } from '../lib/review/stockfishTrace';

/**
 * Одна строка итоговой таблицы. Stockfish-trace использует разные
 * знаковые конвенции для разных id: `psqt_*` и `material`/`imbalance`
 * выходят уже со стороны белых (signed contribution к white POV-оценке,
 * у чёрных значения отрицательные), а большинство остальных
 * подкомпонент (`pawn_connected`, `mobility_*`, `threat_*`, ...) — со
 * стороны владельца (положительные у обеих сторон).
 *
 * Поэтому в таблице есть **обе** колонки:
 *  - `sum_mg`/`sum_eg` — просто сумма всех значений по id. Адекватная
 *    оценка «кто лучше» для параметров со стороны белых (psqt_*,
 *    material/imbalance): около нуля = равноценно.
 *  - `diff_mg`/`diff_eg` — `white_sum − black_sum`. Адекватная оценка
 *    для параметров со стороны владельца (pawn_connected, mobility_*).
 *  - `white_*`/`black_*` — слагаемые для отладки.
 */
export interface PositionalDiffRow {
  param: PositionalSubtermId | 'unknown';
  sum_mg: number;
  sum_eg: number;
  diff_mg: number;
  diff_eg: number;
  white_mg: number;
  black_mg: number;
  white_eg: number;
  black_eg: number;
}

/**
 * KS-4021 follow-up. Одна строка подробной таблицы по клеткам — без
 * суммирования по сторонам. Каждый исходный subterm от SF тут
 * соответствует одной строке (с `square`, если SF её передал, и
 * `color` стороны-обладателя).
 */
export interface PositionalBySquareRow {
  param: PositionalSubtermId | 'unknown';
  color: 'w' | 'b' | '—';
  square: string;
  value_mg: number;
  value_eg: number;
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

/**
 * Чистая функция-агрегатор. Принимает массив подкомпонент (тот же
 * `mergedFactors`, что улетает на сервер; может содержать нестандартные
 * элементы вроде `sf18_eval`/`sf18_pv` — их мы отфильтровываем по
 * наличию числовых значений), возвращает таблицу «Белые − Чёрные».
 *
 * Правила:
 *  - У каждой записи читаем сначала `terminal_value_mg`/`terminal_value_eg`
 *    (терминальная позиция после проигрывания PV — то, что `mergeFactors`
 *    приоритетно кладёт в payload AI), потом fallback на
 *    `value_mg`/`value_eg` (исходная позиция). Это покрывает оба
 *    варианта вывода `mergeFactors`: только исходные, только терминальные,
 *    или и те и другие.
 *  - Только записи, у которых есть числовая пара mg/eg (по любому из
 *    префиксов), агрегируются.
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
    const s = raw as Partial<PositionalSubterm> & {
      terminal_value_mg?: unknown;
      terminal_value_eg?: unknown;
    };
    if (typeof s.id !== 'string') continue;
    // KS-4021. `mergeFactors` (`lib/review/factorsMerge.ts`) переименовывает
    // значения с терминальной позиции в `terminal_value_*`. Если исходный
    // evalTrace вернул пусто (как часто бывает на «холодных» позициях
    // без classical-trace) — в payload остаются только terminal_value_*.
    // Для таблицы читаем их с приоритетом, иначе fallback на value_*.
    const mg =
      typeof s.terminal_value_mg === 'number' && Number.isFinite(s.terminal_value_mg)
        ? s.terminal_value_mg
        : typeof s.value_mg === 'number' && Number.isFinite(s.value_mg)
        ? s.value_mg
        : null;
    const eg =
      typeof s.terminal_value_eg === 'number' && Number.isFinite(s.terminal_value_eg)
        ? s.terminal_value_eg
        : typeof s.value_eg === 'number' && Number.isFinite(s.value_eg)
        ? s.value_eg
        : null;
    if (mg === null || eg === null) continue;
    const bucket = byId.get(s.id) ?? {
      white_mg: 0,
      black_mg: 0,
      white_eg: 0,
      black_eg: 0,
    };
    if (s.color === 'b') {
      bucket.black_mg += mg;
      bucket.black_eg += eg;
    } else {
      bucket.white_mg += mg;
      bucket.white_eg += eg;
    }
    byId.set(s.id, bucket);
  }

  const rows: PositionalDiffRow[] = [];
  for (const [id, b] of byId) {
    rows.push({
      param: id as PositionalSubtermId | 'unknown',
      sum_mg: round3(b.white_mg + b.black_mg),
      sum_eg: round3(b.white_eg + b.black_eg),
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
 * KS-4021 follow-up. Подробный вид по клеткам: каждый subterm от SF —
 * отдельная строка без суммирования. Для psqt_pawn в типичной позиции
 * это даст до 16 строк (8 пешек белых + 8 чёрных), для одиночных
 * параметров (`material`, `imbalance`) — по одной строке. Удобно
 * сверять конкретные клетки и фигуры с реальной доской.
 *
 * Правила:
 *  - Читаем `terminal_value_mg`/`terminal_value_eg` приоритетно (тот же
 *    приоритет, что в `aggregatePositionalDiff`), fallback на `value_*`.
 *  - Пропускаем элементы без числовой пары mg/eg (sf18-метки и т.п.).
 *  - Если SF не передал `square` (агрегаты вроде `king_attackers_count`)
 *    — поле остаётся пустой строкой.
 *  - Сортировка: по `param` (стабильный порядок групп), внутри группы
 *    по `color` (белые сначала), внутри цвета по `square`.
 */
export function buildPositionalBySquare(
  subterms: ReadonlyArray<unknown>,
): PositionalBySquareRow[] {
  const rows: PositionalBySquareRow[] = [];
  for (const raw of subterms) {
    if (!raw || typeof raw !== 'object') continue;
    const s = raw as Partial<PositionalSubterm> & {
      terminal_value_mg?: unknown;
      terminal_value_eg?: unknown;
    };
    if (typeof s.id !== 'string') continue;
    const mg =
      typeof s.terminal_value_mg === 'number' && Number.isFinite(s.terminal_value_mg)
        ? s.terminal_value_mg
        : typeof s.value_mg === 'number' && Number.isFinite(s.value_mg)
        ? s.value_mg
        : null;
    const eg =
      typeof s.terminal_value_eg === 'number' && Number.isFinite(s.terminal_value_eg)
        ? s.terminal_value_eg
        : typeof s.value_eg === 'number' && Number.isFinite(s.value_eg)
        ? s.value_eg
        : null;
    if (mg === null || eg === null) continue;
    const color: 'w' | 'b' | '—' =
      s.color === 'w' || s.color === 'b' ? s.color : '—';
    const square =
      typeof s.square === 'string' && /^[a-h][1-8]$/.test(s.square)
        ? s.square
        : '';
    rows.push({
      param: s.id as PositionalSubtermId | 'unknown',
      color,
      square,
      value_mg: round3(mg),
      value_eg: round3(eg),
    });
  }
  rows.sort((a, b) => {
    if (a.param !== b.param) return a.param < b.param ? -1 : 1;
    // Белые → чёрные → без цвета (агрегаты).
    const colorOrder = (c: 'w' | 'b' | '—'): number =>
      c === 'w' ? 0 : c === 'b' ? 1 : 2;
    const ca = colorOrder(a.color);
    const cb = colorOrder(b.color);
    if (ca !== cb) return ca - cb;
    if (a.square !== b.square) return a.square < b.square ? -1 : 1;
    return 0;
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
    result = await collectAiFactors({
      fen,
      engineProbe,
      // KS-4021. В отладочной таблице показываем и psqt_* —
      // они отфильтрованы в боевой LLM-цепочке, но полезны для
      // разбора структуры оценки SF.
      extraValidIds: PSQT_EXTRA_IDS,
    });
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
      sum_mg: r.sum_mg,
      diff_mg: r.diff_mg,
      sum_eg: r.sum_eg,
      diff_eg: r.diff_eg,
    })),
  );
  return rows;
}

/**
 * Подробная версия команды: возвращает строки по клеткам без
 * суммирования по сторонам. Использует тот же `collectAiFactors` с
 * `PSQT_EXTRA_IDS`, что и `debugPositionalDiff`.
 */
export async function debugPositionalBySquare(
  fenArg?: string,
): Promise<PositionalBySquareRow[]> {
  const fen = fenArg ?? (typeof window !== 'undefined' ? window.__sfTraceFen : undefined);
  if (!fen) {
    console.warn(
      '[ksPositionalBySquare] Откройте /analysis перед вызовом или передайте FEN явно: window.__ksPositionalBySquare("<fen>")',
    );
    return [];
  }
  const engineProbe =
    typeof window !== 'undefined' ? window.__ksEngineProbe ?? null : null;

  let result: Awaited<ReturnType<typeof collectAiFactors>>;
  try {
    result = await collectAiFactors({
      fen,
      engineProbe,
      extraValidIds: PSQT_EXTRA_IDS,
    });
  } catch (err) {
    console.warn('[ksPositionalBySquare] collectAiFactors упал:', err);
    return [];
  }

  const rows = buildPositionalBySquare(result.mergedFactors);
  if (rows.length === 0) {
    console.warn(
      '[ksPositionalBySquare] Stockfish не вернул ни одной подкомпоненты с числовыми значениями. fen=',
      fen,
      'bestLine=',
      result.bestLine,
    );
    return [];
  }

  // eslint-disable-next-line no-console
  console.table(rows);
  return rows;
}

/**
 * Регистрирует функции на глобальном объекте `window` под условием
 * dev-режима или явного opt-in через localStorage.
 */
declare global {
  interface Window {
    __ksPositionalDiff?: (fen?: string) => Promise<PositionalDiffRow[]>;
    __ksPositionalBySquare?: (
      fen?: string,
    ) => Promise<PositionalBySquareRow[]>;
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
  window.__ksPositionalBySquare = debugPositionalBySquare;
  // eslint-disable-next-line no-console
  console.info(
    "[ksPositionalDiff] готово: window.__ksPositionalDiff(fen?) — таблица «Белые − Чёрные» по позиционным факторам Stockfish (тот же массив, что улетает в AI-комментарий). window.__ksPositionalBySquare(fen?) — подробная таблица по клеткам без суммирования.%s",
    import.meta.env.DEV
      ? ''
      : ' (включено через localStorage `ks:dev`=1)',
  );
}

// Авторегистрация при импорте модуля.
maybeRegisterPositionalDiff();
