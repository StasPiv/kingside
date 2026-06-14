/**
 * KS-4100 / ADR-124 §2.2. Консолидированная оркестрация Maia weak-choice.
 *
 * Один 5-шаговый алгоритм (ADR-106 §2.1), раньше скопированный в двух
 * местах (D2): `apps/tactic-worker/.../maia-annotation.service.ts` и
 * `apps/web/src/utils/maiaWeakChoice.ts`. Теперь — единственная
 * реализация здесь; клиент и сервер подставляют движки через узкие
 * провайдерные интерфейсы (`MaiaPolicySource`, `WeakChoiceAnalysisEngine`).
 *
 * Функция ЧИСТАЯ (без платформенных зависимостей, без node-провайдера),
 * поэтому доступна и из главного entry `@kingside/maia-core`, и из
 * браузер-безопасного `@kingside/maia-core/browser` (инвариант
 * KS-4096/4102: фронт не тянет корневой entry / node-provider).
 *
 * Pure-математика (`buildMaiaSearchMoves`, `computeWeakChoiceProb`) и
 * WDL-утилиты (`@kingside/shared`) переиспользуются как есть — формула
 * не дублируется.
 */
import {
  expectedScoreFromWdl,
  wdlOrMateFallback,
  type Wdl,
  type WdlScoreInfo,
} from '@kingside/shared';
import type { PredictResult } from './engine.js';
import {
  MAIA_WEAK_CHOICE_METRIC_VERSION,
  buildMaiaSearchMoves,
  computeWeakChoiceProb,
} from './weak-choice.js';

/** SF-depth по умолчанию для оценки Maia-кандидатов (ADR-106 §2.4). */
const DEFAULT_SF_DEPTH = 15;

/**
 * ADR-124 §2.2 (2). Источник Maia-policy. Класс `Maia` из этого пакета
 * удовлетворяет интерфейсу как есть; клиент передаёт свой singleton
 * (lib/maia), сервер — движок `MaiaAnnotationService`, тесты — мок.
 */
export interface MaiaPolicySource {
  predictMoves(
    fen: string,
    eloSelf: number,
    eloOpponent: number,
  ): Promise<PredictResult>;
}

/**
 * ADR-124 §2.2 (3). Одна линия Stockfish-оценки для weak-choice.
 * Структурно совместима с серверным `MultiPvLine` (apps/tactic-worker)
 * — поля `bestMove`/`score`/`wdl` те же. `bestMove` — первый UCI-ход
 * линии (ключ в map expectedScores).
 */
export interface WeakChoiceLine {
  bestMove: string;
  score: WdlScoreInfo;
  /** WDL per-mille (0..1000) POV side-to-move; null если SF не отдал. */
  wdl?: Wdl | null;
}

/**
 * ADR-124 §2.2 (3). Stockfish-seam ИМЕННО для weak-choice (с
 * `searchMoves` + WDL) — этого нет в `PuzzleGenEngine`. Клиент
 * адаптирует свой WASM/Bridge-движок, сервер — `StockfishService.
 * analyzePositionWdl`.
 */
export interface WeakChoiceAnalysisEngine {
  analyzeWithWdl(
    fen: string,
    opts: { depth: number; multiPV: number; searchMoves: string[] },
  ): Promise<WeakChoiceLine[]>;
}

/** Результат аннотации (без latency — это забота хоста). */
export interface WeakChoiceAnnotation {
  /** Σ policy «слабых» ходов по ADR-106 §2.1, 0..1. */
  weakChoiceProb: number;
  /** Версия формулы (`MAIA_WEAK_CHOICE_METRIC_VERSION`). */
  metricVersion: number;
  /** ELO, под которым прогнали Maia. */
  elo: number;
}

/**
 * ADR-124 §2.2 (4). Оркестрация weak-choice — 5 шагов ADR-106 §2.1:
 *   1. Maia inference → policy.
 *   2-3. `searchMoves` = MaiaTopK ∪ {firstMovePV1}.
 *   4. SF MultiPV-eval с `searchMoves` → WDL по каждому.
 *   5-7. expectedScores → `computeWeakChoiceProb`.
 *
 * Возврат:
 *   - `null` — Maia вернула пустую policy (нет легальных / inference
 *     не дал распределения). Хост пишет NULL в БД.
 *   - `{ weakChoiceProb: 0, … }` — `searchMoves` пуст (firstMovePV1
 *     пустой И MaiaTopK пуст): слабых нет, ничего не отсеиваем.
 *   - `{ weakChoiceProb, … }` — обычный путь.
 *
 * Исключения движков (Maia/SF) НЕ глушит — пробрасывает наверх; хост
 * (с kill-switch на init-фейле и логированием) решает, что делать.
 */
export async function annotateWeakChoice(args: {
  fen: string;
  firstMovePV1: string;
  maia: MaiaPolicySource;
  engine: WeakChoiceAnalysisEngine;
  elo: number;
  sfDepth?: number;
}): Promise<WeakChoiceAnnotation | null> {
  const { fen, firstMovePV1, maia, engine, elo } = args;
  const sfDepth = args.sfDepth ?? DEFAULT_SF_DEPTH;

  // 1. Maia inference.
  const maiaResult = await maia.predictMoves(fen, elo, elo);
  if (maiaResult.policy.length === 0) return null;

  // 2-3. searchmoves = MaiaTopK ∪ {firstMovePV1}.
  const { searchMoves } = buildMaiaSearchMoves(maiaResult.policy, firstMovePV1);
  if (searchMoves.length === 0) {
    return {
      weakChoiceProb: 0,
      metricVersion: MAIA_WEAK_CHOICE_METRIC_VERSION,
      elo,
    };
  }

  // 4. SF eval с searchmoves (multiPV = число кандидатов).
  const lines = await engine.analyzeWithWdl(fen, {
    depth: sfDepth,
    multiPV: searchMoves.length,
    searchMoves,
  });

  // 5-6. expectedScores: map<uci, expectedScore>, POV side-to-move.
  const expectedScores = new Map<string, number>();
  for (const line of lines) {
    const wdl = wdlOrMateFallback(line.wdl, line.score);
    if (!wdl) continue;
    expectedScores.set(line.bestMove, expectedScoreFromWdl(wdl));
  }

  // 7. Pure-вычисление.
  const result = computeWeakChoiceProb({
    policy: maiaResult.policy,
    firstMovePV1,
    expectedScores,
  });

  return {
    weakChoiceProb: result.weakChoiceProb,
    metricVersion: MAIA_WEAK_CHOICE_METRIC_VERSION,
    elo,
  };
}
