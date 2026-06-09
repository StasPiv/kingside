/**
 * KS-4017. Отладочная функция консоли: сравнительная таблица позиционных
 * факторов Stockfish (Белые − Чёрные).
 *
 * Применение:
 *   await window.__ksPositionalDiff()
 *
 * Функция берёт текущий FEN со страницы анализа (`window.__sfTraceFen`,
 * выставляется в `AnalysisPage` при каждой смене позиции — см. KS-3682
 * / `sfTraceConsole.ts`), запрашивает позиционные подкомпоненты Stockfish
 * через ту же `evalTrace(fen)`, что используется в боевом разборе
 * (ADR-107 §6 F1), агрегирует по `id` отдельно для белых и чёрных
 * (включая случай, когда у одной стороны несколько строк с одним и тем
 * же `id` — например `pawn_connected` на двух полях), считает разницу
 * `Белые − Чёрные` для `value_mg` и `value_eg`, сортирует по убыванию
 * `diff_mg` и печатает таблицу через `console.table`. Возвращает тот
 * же массив, чтобы из консоли его можно было сохранить в переменную:
 *
 *   const rows = await window.__ksPositionalDiff()
 *   rows.filter(r => r.diff_mg < 0)
 *
 * Включение:
 *   - В dev (`import.meta.env.DEV`) — всегда.
 *   - В prod — установить `localStorage.setItem('ks:dev','1')` и
 *     перезагрузить страницу. После этого функция появляется на
 *     `window.__ksPositionalDiff`.
 */
import type {
  PositionalSubterm,
  PositionalSubtermId,
} from '@kingside/shared';
import { evalTrace, StockfishTraceEngineError } from '../lib/review/stockfishTrace';

/**
 * Одна строка итоговой таблицы: разница «Белые − Чёрные» по конкретному
 * параметру в пешечных-cp единицах SF. `white_mg`/`black_mg` —
 * промежуточные суммы (полезны при отладке, видны в таблице как
 * раскрытые поля при `console.dir`).
 */
export interface PositionalDiffRow {
  /** id параметра, как в `PositionalSubterm.id`. */
  param: PositionalSubtermId | 'unknown';
  /** Разница `value_mg` Белые − Чёрные, округлено до 3 знаков. */
  diff_mg: number;
  /** Разница `value_eg` Белые − Чёрные, округлено до 3 знаков. */
  diff_eg: number;
  /** Сумма value_mg всех записей с этим id у белых. */
  white_mg: number;
  /** Сумма value_mg всех записей с этим id у чёрных. */
  black_mg: number;
  /** Сумма value_eg всех записей с этим id у белых. */
  white_eg: number;
  /** Сумма value_eg всех записей с этим id у чёрных. */
  black_eg: number;
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

/**
 * Чистая функция, отделённая ради тестирования. Берёт массив подкомпонент
 * и возвращает агрегированную сравнительную таблицу.
 *
 * Правила:
 *  - Поля без `color` (side-agnostic, например `material`/`imbalance` —
 *    SF их трактует как баланс уже с учётом сторон) суммируются в белые,
 *    в чёрные ничего не добавляется. Это сохраняет смысл: «к балансу
 *    белых», знак уже корректный относительно белых.
 *  - Подкомпонент с `color='w'` суммируется в `white_*`, `color='b'` —
 *    в `black_*`.
 *  - `diff_mg = white_mg − black_mg`, аналогично `diff_eg`.
 *  - Сортировка по убыванию `diff_mg`. На равных — стабильно по `param`.
 */
export function aggregatePositionalDiff(
  subterms: ReadonlyArray<PositionalSubterm>,
): PositionalDiffRow[] {
  const byId = new Map<
    string,
    {
      white_mg: number;
      black_mg: number;
      white_eg: number;
      black_eg: number;
    }
  >();

  for (const s of subterms) {
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
      // 'w' и side-agnostic (color === undefined) — относим к белым.
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
 * KS-4018. Время полного прогрева WASM-движка от первого `evalTrace`
 * до получения непустого массива subterms. Внутри `evalTrace` уже есть
 * ожидание `uciok` (см. `INIT_TIMEOUT_MS=8s` в `stockfishTrace.ts`), но
 * на первом вызове внутренние таблицы SF (Pawns/Material) могут ещё
 * не быть прогреты, и `eval json` возвращает JSON без `subterms`. Это
 * не системная ошибка, а нормальная задержка инициализации.
 *
 * Стратегия: цикл-ретрай по 200 мс, потолок 5 секунд. По задаче — этого
 * достаточно для типичного прогрева. Если не успели — выводим осмысленное
 * предупреждение и возвращаем `[]`.
 */
const WARMUP_TOTAL_MS = 5_000;
const WARMUP_RETRY_DELAY_MS = 200;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Сама консольная команда. Async — eval-trace WASM запускается асинхронно.
 *
 * Поведение:
 *  - Если `window.__sfTraceFen` не выставлен (страница анализа не открыта
 *    или ещё не успела) — `console.warn` с инструкцией, возвращает `[]`.
 *  - Если eval-trace упал по системной причине загрузки
 *    (`factory-timeout`, `factory-error` — см. `StockfishTraceEngineError`)
 *    — `console.warn` с понятным текстом, возвращает `[]` без ретрая.
 *  - Если eval-trace вернул `[]` (или бросил `eval-timeout`) — это
 *    обычно прогрев SF не успел; ретраим каждые 200 мс до 5 секунд.
 *    После таймаута — `console.warn` с осмысленным сообщением.
 *  - При успехе — `console.table` + `return rows`.
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

  const deadline = Date.now() + WARMUP_TOTAL_MS;
  let attempt = 0;
  let subterms: PositionalSubterm[] = [];
  while (Date.now() < deadline) {
    attempt += 1;
    try {
      subterms = await evalTrace(fen);
    } catch (err) {
      if (err instanceof StockfishTraceEngineError) {
        // factory-timeout / factory-error — WASM реально не загружается,
        // повторы не помогут. eval-timeout — может быть прогрев, ретраим.
        if (err.reason === 'eval-timeout') {
          if (Date.now() + WARMUP_RETRY_DELAY_MS < deadline) {
            await sleep(WARMUP_RETRY_DELAY_MS);
            continue;
          }
          console.warn(
            `[ksPositionalDiff] eval-timeout сохраняется ${Math.round(WARMUP_TOTAL_MS / 1000)} секунд — попробуйте ещё раз позже.`,
          );
          return [];
        }
        console.warn(
          `[ksPositionalDiff] Stockfish не загружается (${err.reason}). Проверьте сеть и перезагрузите страницу.`,
        );
        return [];
      }
      console.warn('[ksPositionalDiff] eval-trace упал:', err);
      return [];
    }
    if (subterms.length > 0) {
      if (attempt > 1) {
        console.info(
          `[ksPositionalDiff] Stockfish прогрелся за ${attempt} попыток (~${attempt * WARMUP_RETRY_DELAY_MS} мс).`,
        );
      }
      break;
    }
    // Пустой ответ — прогрев ещё не завершён. Подождём и попробуем снова.
    if (Date.now() + WARMUP_RETRY_DELAY_MS < deadline) {
      await sleep(WARMUP_RETRY_DELAY_MS);
    } else {
      break;
    }
  }
  if (subterms.length === 0) {
    console.warn(
      `[ksPositionalDiff] За ${Math.round(WARMUP_TOTAL_MS / 1000)} секунд Stockfish не выдал ни одной подкомпоненты. Возможные причины: WASM-движок не загрузился, нет SharedArrayBuffer в окружении, FEN невалиден. Попробуйте перезагрузить страницу.`,
    );
    return [];
  }

  const rows = aggregatePositionalDiff(subterms);
  // Печатаем только три колонки в самой таблице — остальные доступны
  // через возвращаемое значение для углублённой отладки.
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
 * dev-режима или явного opt-in через localStorage. Сразу же печатает
 * подсказку в консоль — пользователю не нужно лезть в документацию.
 */
declare global {
  interface Window {
    __ksPositionalDiff?: (fen?: string) => Promise<PositionalDiffRow[]>;
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
    "[ksPositionalDiff] готово: window.__ksPositionalDiff(fen?) — таблица «Белые − Чёрные» по позиционным факторам Stockfish.%s",
    import.meta.env.DEV
      ? ''
      : ' (включено через localStorage `ks:dev`=1)',
  );
}

// Авторегистрация при импорте модуля.
maybeRegisterPositionalDiff();
