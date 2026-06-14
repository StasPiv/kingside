/**
 * KS-4096 / KS-4100 (ADR-124 фаза 3). Клиентский шаг Maia weak-choice
 * для генерации precision-пазлов — тонкая обёртка над общей оркестрацией
 * `annotateWeakChoice` из `@kingside/maia-core/browser`.
 *
 * Раньше (KS-4096) этот модуль держал собственную копию 5-шагового
 * алгоритма (Maia policy → buildMaiaSearchMoves → SF MultiPV WDL →
 * computeWeakChoiceProb), дублируя серверный `MaiaAnnotationService`.
 * ADR-124 свёл оркестрацию в единственную реализацию в `@kingside/maia-core`
 * (`annotateWeakChoice`), куда движки подставляются через провайдеры —
 * клиент и сервер считают по одному коду. Здесь остаются только
 * клиентские адаптеры:
 *  - `MaiaPolicySource` = браузерная Maia (`predictMoves` из lib/maia,
 *    onnxruntime-web);
 *  - `WeakChoiceAnalysisEngine` = Stockfish WASM/Bridge через
 *    `EngineAdapter.analyze` с `searchmoves`.
 *
 * Импорт строго из `@kingside/maia-core/browser` (не из корня — корень
 * тянет node-провайдер и ломает браузерный бандл, см. KS-4096/4102).
 */
import {
  annotateWeakChoice,
  type WeakChoiceAnalysisEngine,
  type WeakChoiceLine,
} from '@kingside/maia-core/browser';

// `predict` (не `predictMoves`) — возвращает полный PredictResult
// ({ policy, winProbability }), как требует MaiaPolicySource.predictMoves.
import { predict } from '../lib/maia';
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

export type MaiaAnnotation = {
  maiaWeakChoiceProb: number;
  maiaMetricVersion: number;
  maiaTop1Elo: number;
};

/**
 * Адаптер `EngineAdapter` (SF WASM/Bridge) → `WeakChoiceAnalysisEngine`
 * (seam общей оркестрации). `analyzeWithWdl` запускает `go ... searchmoves`
 * и отдаёт линии с WDL по кандидатам.
 */
function toWeakChoiceEngine(engine: EngineAdapter): WeakChoiceAnalysisEngine {
  return {
    async analyzeWithWdl(
      fen: string,
      opts: { depth: number; multiPV: number; searchMoves: string[] },
    ): Promise<WeakChoiceLine[]> {
      const { lines } = await engine.analyze(
        fen,
        opts.depth,
        opts.multiPV,
        undefined,
        undefined,
        opts.searchMoves,
      );
      return lines.map((l) => ({
        bestMove: l.pv[0],
        score: l.score,
        wdl: l.wdl ?? null,
      }));
    },
  };
}

/**
 * Считает Maia weak-choice для одной позиции через общую
 * `annotateWeakChoice`. Возвращает `null`, если метрику посчитать нельзя
 * (нет firstMovePV1, пустая Maia-policy, ошибка движка) — тогда пазл
 * сохранится с `null` (как раньше), генерация не падает.
 */
export async function computeMaiaAnnotation(
  fen: string,
  firstMovePV1: string | undefined,
  engine: EngineAdapter,
  elo: number = MAIA_ANNOTATION_ELO,
): Promise<MaiaAnnotation | null> {
  if (!firstMovePV1) return null;
  try {
    const result = await annotateWeakChoice({
      fen,
      firstMovePV1,
      elo,
      sfDepth: MAIA_SF_DEPTH,
      maia: { predictMoves: predict },
      engine: toWeakChoiceEngine(engine),
    });
    if (!result) return null;
    return {
      maiaWeakChoiceProb: result.weakChoiceProb,
      maiaMetricVersion: result.metricVersion,
      maiaTop1Elo: result.elo,
    };
  } catch (e) {
    // annotateWeakChoice пробрасывает исключения движков — глушим здесь
    // (best-effort): пазл сохранится без метрики, генерация не падает.
    console.warn('[MaiaWeakChoice] annotate failed:', (e as Error).message);
    return null;
  }
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
