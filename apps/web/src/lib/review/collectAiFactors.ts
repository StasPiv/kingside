/**
 * KS-4021. Чистая функция-копия цепочки сбора позиционных факторов из
 * `useAiPositionComment` (KS-3699 / ADR-108 §5). Используется из
 * `debugPositionalDiff` (`window.__ksPositionalDiff`), чтобы отладочная
 * консольная функция возвращала те же данные, что улетают на сервер
 * для AI-комментария — без дублирования логики через React-хук.
 *
 * Последовательность шагов (один-в-один с `useAiPositionComment.request`):
 *   1. `factors = await evalTrace(fen)` — позиционные подкомпоненты
 *      Stockfish-16-trace по исходной позиции.
 *   2. `bestLine = await engineProbe()` (с потолком `probeTimeoutMs`).
 *      `engineProbe` — это callback из AnalysisPage, который
 *      запускает Stockfish-18-lite и возвращает первую линию.
 *   3. Если у `bestLine.pv` есть ходы — проигрываем линию через chess.js
 *      до терминального FEN, делаем второй `evalTrace(terminalFen)`,
 *      объединяем массивы через `mergeFactors`.
 *   4. Если probe вернул null/таймаут или PV пустой — возвращаем
 *      исходные `factors` без объединения. На любой ошибке внутри
 *      шага 3 — graceful fallback на исходные.
 *
 * Возвращаемый объект совпадает с тем, что в `useAiPositionComment`
 * собирается перед POST `/analyses/position/comment`:
 *   - `mergedFactors` — массив, который улетает в теле запроса как
 *     `factors` (после добавления `sf18_eval` / `sf18_pv` в самом хуке).
 *   - `factors` — исходные подкомпоненты только для исходной позиции
 *     (без терминала).
 *   - `bestLine` — что вернул probe.
 */
import type { PositionalSubterm } from '@kingside/shared';
import { mergeFactors, playOutPv } from './factorsMerge';
import { evalTrace } from './stockfishTrace';

export interface EngineBestLineInput {
  depth: number;
  multipv: number;
  score: { type: 'cp' | 'mate'; value: number };
  /** UCI-строка, пробелы между ходами. */
  pv: string;
}

export interface CollectAiFactorsOptions {
  /** FEN текущей позиции. */
  fen: string;
  /**
   * Колбэк, запускающий Stockfish-18-lite и возвращающий первую линию.
   * Если не передан — собираем только `factors` на исходной позиции,
   * без терминального второго прохода (поведение KS-3685 для случая,
   * когда движок ещё не успел отдать линию).
   */
  engineProbe?: (() => Promise<EngineBestLineInput | null>) | null;
  /** Потолок ожидания probe. По умолчанию 8 секунд (KS-3703). */
  probeTimeoutMs?: number;
}

export interface CollectAiFactorsResult {
  /** Подкомпоненты на исходной позиции (без `sf18_*`-меток). */
  factors: PositionalSubterm[];
  /**
   * Полный массив, как уходит на сервер: объединение исходных и
   * терминальных через `mergeFactors`, если probe дал линию.
   * Может содержать невалидные элементы — это смешанный тип
   * (`ReadonlyArray<unknown>`), как в исходном хуке.
   */
  mergedFactors: ReadonlyArray<PositionalSubterm | { id: string }>;
  /** Результат probe — для дебага. */
  bestLine: EngineBestLineInput | null;
}

const DEFAULT_PROBE_TIMEOUT_MS = 8_000;

export async function collectAiFactors(
  opts: CollectAiFactorsOptions,
): Promise<CollectAiFactorsResult> {
  // 1. Исходная позиция.
  const factors = await evalTrace(opts.fen);

  // 2. Probe лучшей линии (с потолком).
  let bestLine: EngineBestLineInput | null = null;
  if (opts.engineProbe) {
    const probe = opts.engineProbe;
    const timeoutMs = opts.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    try {
      bestLine = await Promise.race<EngineBestLineInput | null>([
        probe(),
        new Promise<EngineBestLineInput | null>((resolve) =>
          setTimeout(() => resolve(null), timeoutMs),
        ),
      ]);
    } catch {
      bestLine = null;
    }
  }

  // 3. Terminal eval + merge.
  let mergedFactors: ReadonlyArray<PositionalSubterm | { id: string }> = factors;
  if (bestLine && bestLine.pv && bestLine.pv.trim().length > 0) {
    const terminalFen = playOutPv(opts.fen, bestLine.pv);
    if (terminalFen) {
      try {
        const terminalFactors = await evalTrace(terminalFen);
        mergedFactors = mergeFactors(
          factors,
          terminalFactors,
        ) as ReadonlyArray<PositionalSubterm | { id: string }>;
      } catch {
        // Терминал не собрался — остаёмся с исходными.
      }
    }
  }

  return { factors, mergedFactors, bestLine };
}
