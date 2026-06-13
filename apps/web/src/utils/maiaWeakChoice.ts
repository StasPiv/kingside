/**
 * KS-4096. Клиентский шаг Maia weak-choice для генерации precision-пазлов.
 *
 * До этой задачи клиентский генератор (`PuzzleGeneratorModal` →
 * `generatePuzzlesFromPgn`) НЕ вычислял метрику `maiaWeakChoiceProb` —
 * все client-generated PVE-пазлы уходили в `POST /puzzles/batch` с
 * `maiaWeakChoiceProb=null`, расходясь с серверной генерацией и не
 * попадая в выдачу `/precision/next?minMaiaWeakChoiceProb=…`.
 *
 * Этот модуль повторяет серверный алгоритм (см.
 * `tools/maia-puzzle-annotation/src/index.ts` и ADR-106 §2.1) полностью
 * на клиенте — Maia уже работает в браузере (KS-3577,
 * `apps/web/src/lib/maia/`, onnxruntime-web + IndexedDB), Stockfish WASM
 * тоже клиентский (им идёт сама генерация), формула общая и чистая:
 *
 *   1. Maia.predictMoves(fen, elo, elo) → policy.
 *   2. buildMaiaSearchMoves(policy, firstMovePV1) → searchMoves
 *      (Maia top-K по policy > 0.10, max K=8, плюс firstMovePV1).
 *   3. Stockfish `go depth N searchmoves …` (MultiPV = |searchMoves|,
 *      cap 10) → линии с WDL.
 *   4. expectedScores из WDL через `expectedScoreFromWdl`
 *      (+ `wdlOrMateFallback` для mate-без-WDL).
 *   5. computeWeakChoiceProb({policy, firstMovePV1, expectedScores}).
 *
 * KS-4098: чистые функции метрики импортируются из браузер-безопасного
 * входа `@kingside/maia-core/browser` — он НЕ тянет node-провайдер
 * (onnxruntime-node / node:fs), поэтому production vite build не падает.
 * Корневой `@kingside/maia-core` во фронте использовать НЕЛЬЗЯ (реэкспорт
 * node-provider ломает браузерный бандл — см. KS-4096). Сама формула —
 * ровно та же, что на сервере (без дублирования математики). Сведение
 * клиентской копии движка `apps/web/src/lib/maia/` к maia-core —
 * отдельная будущая задача.
 */
import {
  MAIA_WEAK_CHOICE_METRIC_VERSION,
  buildMaiaSearchMoves,
  computeWeakChoiceProb,
} from '@kingside/maia-core/browser';
import { expectedScoreFromWdl, wdlOrMateFallback } from '@kingside/shared';

import { predictMoves } from '../lib/maia';
import type { EngineAdapter } from './engineAdapter';
import type { GeneratedPuzzleData } from './puzzleGenerator';

/**
 * ELO разметки. Совпадает с серверным дефолтом
 * (`PRECISION_MAIA_ANNOTATION_ELO`, 1500) — иначе метрика клиентских и
 * серверных пазлов считалась бы под разным «уровнем игрока».
 */
export const MAIA_ANNOTATION_ELO = 1500;

/**
 * Глубина Stockfish для оценки кандидатов. Совпадает с серверным
 * дефолтом `--sf-depth=15` (ADR-106 §2.4). На WASM ≈0.5–1.5с на пазл.
 */
const MAIA_SF_DEPTH = 15;

/** Cap MultiPV, как в серверной обёртке (tools/.../stockfish.ts). */
const MULTIPV_CAP = 10;

export type MaiaAnnotation = {
  maiaWeakChoiceProb: number;
  maiaMetricVersion: number;
  maiaTop1Elo: number;
};

/**
 * Считает Maia weak-choice для одной позиции. Возвращает `null`, если
 * метрику посчитать нельзя (нет firstMovePV1, пустая policy, ошибка
 * движка) — тогда пазл сохранится с `null` (как раньше), генерация не
 * падает.
 */
export async function computeMaiaAnnotation(
  fen: string,
  firstMovePV1: string | undefined,
  engine: EngineAdapter,
  elo: number = MAIA_ANNOTATION_ELO,
): Promise<MaiaAnnotation | null> {
  if (!firstMovePV1) return null;

  let policy: { move: string; probability: number }[];
  try {
    policy = await predictMoves(fen, elo, elo);
  } catch (e) {
    console.warn('[MaiaWeakChoice] predictMoves failed:', (e as Error).message);
    return null;
  }
  if (policy.length === 0) return null;

  const { searchMoves } = buildMaiaSearchMoves(policy, firstMovePV1);
  // Слабая policy (все < 0.10) и пустой firstMovePV1 — нечего считать
  // слабым. Симметрично серверу: weakChoiceProb=0.
  if (searchMoves.length === 0) {
    return {
      maiaWeakChoiceProb: 0,
      maiaMetricVersion: MAIA_WEAK_CHOICE_METRIC_VERSION,
      maiaTop1Elo: elo,
    };
  }

  let lines;
  try {
    lines = (
      await engine.analyze(
        fen,
        MAIA_SF_DEPTH,
        Math.min(MULTIPV_CAP, searchMoves.length),
        undefined,
        undefined,
        searchMoves,
      )
    ).lines;
  } catch (e) {
    console.warn('[MaiaWeakChoice] SF analyze failed:', (e as Error).message);
    return null;
  }

  const expectedScores = new Map<string, number>();
  for (const line of lines) {
    const wdl = wdlOrMateFallback(line.wdl ?? null, line.score);
    if (!wdl) continue;
    const move = line.pv[0];
    if (!move) continue;
    expectedScores.set(move, expectedScoreFromWdl(wdl));
  }

  const { weakChoiceProb } = computeWeakChoiceProb({
    policy,
    firstMovePV1,
    expectedScores,
  });

  return {
    maiaWeakChoiceProb: weakChoiceProb,
    maiaMetricVersion: MAIA_WEAK_CHOICE_METRIC_VERSION,
    maiaTop1Elo: elo,
  };
}

/**
 * Аннотирует все сгенерированные пазлы Maia-метрикой in-place (мутирует
 * элементы массива, проставляя `maiaWeakChoiceProb` и т.д.). Считает
 * последовательно — Maia-инференс и SF-анализ делят один WASM-поток,
 * параллелить нельзя. Прогресс через `onProgress(done, total)`.
 *
 * Best-effort: ошибка на конкретном пазле не валит весь проход — он
 * остаётся без метрики (`null` на сервере).
 */
export async function annotatePuzzlesWithMaia(
  puzzles: GeneratedPuzzleData[],
  engine: EngineAdapter,
  onProgress?: (done: number, total: number) => void,
  options: { elo?: number; abortSignal?: AbortSignal } = {},
): Promise<void> {
  const elo = options.elo ?? MAIA_ANNOTATION_ELO;
  for (let i = 0; i < puzzles.length; i++) {
    if (options.abortSignal?.aborted) break;
    const p = puzzles[i];
    const annotation = await computeMaiaAnnotation(
      p.fen,
      p.sourceMetadata?.firstMovePV1,
      engine,
      elo,
    );
    if (annotation) {
      p.maiaWeakChoiceProb = annotation.maiaWeakChoiceProb;
      p.maiaMetricVersion = annotation.maiaMetricVersion;
      p.maiaTop1Elo = annotation.maiaTop1Elo;
    }
    onProgress?.(i + 1, puzzles.length);
  }
}
