/**
 * KS-4943 (ADR-165 §2-§4, §3.1). Оркестратор «разбора позиции как
 * симуляции человеческого анализа» (Maia × Stockfish, без LLM).
 *
 * Чистая логика: рекурсивно строит сериализуемый `ReviewPlan` (список
 * операций goto/move/annotate) от корневой позиции. Кандидаты каждого
 * узла = объединение человеческих ходов Maia (§3.1) и сильнейших ходов
 * Stockfish (MultiPV). Рекурсия останавливается по стоп-условию §4
 * («позиция понята») либо по аварийным лимитам (глубина/узлы/повтор).
 *
 * Движки инъектируются через `PositionReviewEngines` — как в
 * `buildStabilizedLine` (ADR-101). Хук `usePositionReview` подставит
 * реальные worker-обёртки (useMaiaAnalysis / useStockfish); тесты —
 * детерминированные mock-адаптеры. Движки работают ФАЗАМИ
 * (последовательно, await каждого), не одновременно — контракт ADR §3.1.
 *
 * WDL везде per-mille (0..1000), POV стороны на ходу. Конверсия
 * cp→WDL (когда сборка SF без UCI_ShowWDL) — обязанность адаптера
 * (`wdlFromCp` здесь как готовый хелпер, ADR-066).
 */
import {
  expectedScoreFromWdl,
  invertWdl,
  winPctFromCp,
  WDL_LOSS_THRESHOLDS,
  type Wdl,
} from '@kingside/shared';

import {
  NAG_DUBIOUS,
  NAG_MISTAKE,
  NAG_BLUNDER,
} from './buildAnnotations';

// ---------------------------------------------------------------------------
// Конфиг: пороги Maia (§3.1) и аварийные лимиты (§2/§4).
// ---------------------------------------------------------------------------

/**
 * Порог «человеческого» хода Maia (ADR-165 §3.1). Ход `m` —
 * кандидат, если выполнены ВСЕ условия: `prob ≥ pFloor`, входит в
 * top-p ядро (`≥ pNucleus` кумулятивной массы), `prob ≥ rel·probTop`,
 * и не превышен лимит `nMax` ходов на узел.
 */
export interface ReviewThresholds {
  /** Абсолютный пол вероятности хода. Default 0.10. */
  pFloor: number;
  /** Кумулятивная масса ядра (top-p). Default 0.85. */
  pNucleus: number;
  /** Относительный пол: доля от вероятности топ-хода. Default 0.4. */
  rel: number;
  /** Максимум Maia-кандидатов на узел. Default 2. */
  nMax: number;
}

/**
 * Аварийные лимиты против взрыва дерева (ADR-165 §2/§4) — безопасность,
 * не суть алгоритма.
 */
export interface ReviewLimits {
  /** Максимальная глубина в полуходах. Default 6. */
  maxDepth: number;
  /** Максимум узлов плана (жёсткий стоп). Default 40. */
  maxNodes: number;
  /** Максимум ходов на источник (Maia / SF) на узел. Default 2. */
  maxBranchPerSource: number;
  /**
   * Порог «стабильности исхода» §4.2: max(W,D,L)/1000 > this →
   * позиция decided. Default 0.95.
   */
  decidedWdl: number;
  /** MultiPV для Stockfish на узле. Default 2. */
  stockfishMultiPv: number;
}

export interface ReviewConfig {
  thresholds: ReviewThresholds;
  limits: ReviewLimits;
  /** ELO уровня Maia (= рейтинг игрока или 1500). */
  elo: number;
}

export const DEFAULT_REVIEW_THRESHOLDS: ReviewThresholds = {
  pFloor: 0.1,
  pNucleus: 0.85,
  rel: 0.4,
  nMax: 2,
};

export const DEFAULT_REVIEW_LIMITS: ReviewLimits = {
  maxDepth: 6,
  maxNodes: 40,
  maxBranchPerSource: 2,
  decidedWdl: 0.95,
  stockfishMultiPv: 2,
};

export const DEFAULT_REVIEW_ELO = 1500;

export function defaultReviewConfig(elo: number = DEFAULT_REVIEW_ELO): ReviewConfig {
  return {
    thresholds: { ...DEFAULT_REVIEW_THRESHOLDS },
    limits: { ...DEFAULT_REVIEW_LIMITS },
    elo,
  };
}

// ---------------------------------------------------------------------------
// Инъектируемые движки (фазы).
// ---------------------------------------------------------------------------

/** Результат SF-прогона позиции. `null` bestUci / пустой multipv —
 *  терминальная позиция (мат/пат) или SF недоступен (см. `analyze`). */
export interface PositionReviewEval {
  /** SF PV1 (bestmove) для позиции. `null` — терминал/нет ответа. */
  bestUci: string | null;
  /** WDL позиции, POV стороны на ходу. */
  wdl: Wdl;
  /** Первые ходы top-MultiPV линий, best-first (для SF-кандидатов). */
  multipv: string[];
  /** cp/mate оценка позиции POV стороны на ходу (для «оценки SF» на конце ветки). */
  score?: { type: 'cp' | 'mate'; value: number } | null;
}

/**
 * Контракт оркестратора над реальными движками. Все методы —
 * последовательные фазы (await по одному). `analyze` возвращает `null`
 * при недоступности SF (`no_coi`) → деградация до Maia-only.
 */
export interface PositionReviewEngines {
  /** Maia policy `{uci → prob}` для `fen` на уровне `elo`. */
  getMaiaPolicy: (fen: string, elo: number) => Promise<Record<string, number>>;
  /** SF-оценка `fen`. `null` — SF недоступен на этом узле. */
  analyze: (fen: string, multiPv: number) => Promise<PositionReviewEval | null>;
  /** Применить UCI-ход. `null` — нелегальный ход / терминал. */
  applyMove: (fen: string, uci: string) => string | null;
  /** UCI → SAN для подписи хода. */
  toSan: (fen: string, uci: string) => string;
}

// ---------------------------------------------------------------------------
// Сериализуемый план разбора.
// ---------------------------------------------------------------------------

export type ReviewMoveSource = 'maia' | 'stockfish' | 'both';

/** Идентификатор корня разбора (текущая позиция) в потоке операций. */
export const REVIEW_ROOT_ID = -1;

export type ReviewPlanOp =
  /**
   * Навигация к узлу-развилке по стабильному id узла плана (НЕ по FEN —
   * при транспозициях одна позиция = несколько узлов, поиск по FEN дал бы
   * неоднозначность). `toId === REVIEW_ROOT_ID` — корень разбора.
   */
  | { type: 'goto'; toId: number }
  /**
   * Применить ход в дерево (makeVariantMove) от текущего узла. `id` —
   * стабильный идентификатор создаваемого узла; goto к нему возвращает
   * ровно сюда.
   */
  | {
      type: 'move';
      id: number;
      uci: string;
      san: string;
      source: ReviewMoveSource;
      /** WDL после хода, POV сделавшего ход. `null` — SF недоступен. */
      wdlAfter: Wdl | null;
    }
  /** Аннотировать текущий узел (NAG + комментарий). */
  | { type: 'annotate'; nag?: number; comment?: string }
  /**
   * KS-4950: повысить текущий узел до главной линии (promoteVariation).
   * Эмитится, когда среди кандидатов-сиблингов этот ход сильнее по оценке,
   * чем первый (ставший главным) — сильнейший ход становится основным.
   */
  | { type: 'promote' };

export type ReviewStopReason =
  | 'understood'
  | 'max_depth'
  | 'max_nodes'
  | 'repetition'
  | 'terminal';

export interface ReviewPlanStats {
  /** Число раскрытых (expand'нутых) узлов. */
  nodes: number;
  /** Число листьев по каждой причине остановки. */
  leaves: Record<ReviewStopReason, number>;
  /** Достигнутая максимальная глубина (полуходы). */
  maxDepthReached: number;
  /** true — обход упёрся в maxNodes (план, возможно, неполон). */
  truncatedByNodes: boolean;
  /** true — SF был недоступен хотя бы на одном узле (Maia-only деградация). */
  degradedNoSf: boolean;
}

export interface ReviewPlan {
  rootFen: string;
  elo: number;
  ops: ReviewPlanOp[];
  stats: ReviewPlanStats;
}

// ---------------------------------------------------------------------------
// §3.1 — отбор человеческих кандидатов Maia.
// ---------------------------------------------------------------------------

/**
 * ADR-165 §3.1. Отбирает человеческие ходы из policy Maia по порогам
 * `pFloor` / `pNucleus` / `rel` / `nMax`. Возвращает UCI'и best-first.
 *
 * policy отсортирована по убыванию; кандидат проходит, пока: не превышен
 * `nMax`, `prob ≥ pFloor`, `prob ≥ rel·probTop`, и кумулятивная масса
 * ДО хода < `pNucleus` (ход внутри top-p ядра). Первое нарушение любого
 * из порогов обрывает добор (policy монотонна).
 */
export function selectMaiaCandidates(
  policy: Record<string, number>,
  thresholds: ReviewThresholds,
): string[] {
  const entries = Object.entries(policy)
    .filter(([, p]) => Number.isFinite(p) && p > 0)
    .sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return [];

  const probTop = entries[0][1];
  const relFloor = thresholds.rel * probTop;
  const result: string[] = [];
  let cumBefore = 0;

  for (const [uci, prob] of entries) {
    if (result.length >= thresholds.nMax) break;
    if (prob < thresholds.pFloor) break;
    if (prob < relFloor) break;
    if (cumBefore >= thresholds.pNucleus) break;
    result.push(uci);
    cumBefore += prob;
  }
  return result;
}

/** argmax policy Maia (топ-ход человека). `null` — пустая policy. */
export function maiaTopMove(policy: Record<string, number>): string | null {
  let best: string | null = null;
  let bestProb = -Infinity;
  for (const [uci, prob] of Object.entries(policy)) {
    if (Number.isFinite(prob) && prob > bestProb) {
      bestProb = prob;
      best = uci;
    }
  }
  return best;
}

/**
 * KS-4950: комментарий с оценкой Stockfish для конца ветки (нет ходов
 * Maia ≥ порога). `score` — POV стороны на ходу; приводим к POV белых.
 */
export function formatSfEvalComment(
  score: { type: 'cp' | 'mate'; value: number },
  whiteToMove: boolean,
): string {
  const sign = whiteToMove ? 1 : -1;
  if (score.type === 'mate') {
    const m = sign * score.value;
    return m >= 0 ? `SF #${m}` : `SF #-${Math.abs(m)}`;
  }
  const cp = (sign * score.value) / 100;
  return `SF ${cp >= 0 ? '+' : ''}${cp.toFixed(2)}`;
}

// ---------------------------------------------------------------------------
// §4 — стоп-условие «позиция понята».
// ---------------------------------------------------------------------------

/** max(W,D,L)/1000 позиции. */
export function maxOutcomeProb(wdl: Wdl): number {
  return Math.max(wdl.w, wdl.d, wdl.l) / 1000;
}

/**
 * ADR-165 §4. Позиция «понята» ⟺ ОБА: (1) SF-best == Maia-top,
 * (2) max(W,D,L) > decidedWdl. Если SF недоступен (`bestUci == null`)
 * — понять нельзя (углубляемся до лимитов).
 */
export function isUnderstood(
  maiaTop: string | null,
  sfBest: string | null,
  wdl: Wdl,
  decidedWdl: number,
): boolean {
  if (!maiaTop || !sfBest) return false;
  if (maiaTop !== sfBest) return false;
  return maxOutcomeProb(wdl) > decidedWdl;
}

// ---------------------------------------------------------------------------
// Аннотации (§2/§5) — NAG по WDL-loss (шкала ADR-066).
// ---------------------------------------------------------------------------

/**
 * NAG по WDL-loss относительно лучшего кандидата (ADR-066 §3.2 шкала).
 * best/good → без метки; inaccuracy → `?!`; mistake → `?`; blunder → `??`.
 * `null` — метки нет.
 */
export function nagForLossE(lossE: number): number | null {
  if (lossE <= WDL_LOSS_THRESHOLDS.good) return null; // best/good
  if (lossE <= WDL_LOSS_THRESHOLDS.inaccuracy) return NAG_DUBIOUS; // ?!
  if (lossE <= WDL_LOSS_THRESHOLDS.mistake) return NAG_MISTAKE; // ?
  return NAG_BLUNDER; // ??
}

/**
 * Конверсия SF `score cp` → per-mille WDL (ADR-066 §6.1, кривая
 * Lichess `winPctFromCp`). Fallback, когда сборка SF без `UCI_ShowWDL`.
 * Draw-массы модель не даёт — раскладываем симметрично: `d` тем больше,
 * чем ближе win% к 50% (позиция равная → ничейная). POV стороны на ходу.
 */
export function wdlFromCp(cp: number): Wdl {
  const winPct = winPctFromCp(cp); // 0..100, POV side-to-move
  const w = winPct / 100; // 0..1
  // Ничейная масса максимальна при равенстве (win%=50) и убывает к краям.
  const d = 1 - Math.abs(2 * w - 1);
  const rawW = Math.max(0, w - d / 2);
  const rawL = Math.max(0, 1 - w - d / 2);
  const sum = rawW + d + rawL || 1;
  return {
    w: Math.round((rawW / sum) * 1000),
    d: Math.round((d / sum) * 1000),
    l: Math.round((rawL / sum) * 1000),
  };
}

// ---------------------------------------------------------------------------
// Утилиты.
// ---------------------------------------------------------------------------

/** Ключ позиции для детекции повтора: первые 4 поля FEN (без часов). */
export function positionKey(fen: string): string {
  return fen.split(' ').slice(0, 4).join(' ');
}

/** Объединение кандидатов Maia ∪ SF с пометкой источника, best-first. */
export function unionCandidates(
  maia: string[],
  sf: string[],
): Array<{ uci: string; source: ReviewMoveSource }> {
  const sfSet = new Set(sf);
  const maiaSet = new Set(maia);
  const seen = new Set<string>();
  const out: Array<{ uci: string; source: ReviewMoveSource }> = [];
  // Maia-ходы первыми (человеческий кандидат — основной по ADR).
  for (const uci of maia) {
    if (seen.has(uci)) continue;
    seen.add(uci);
    out.push({ uci, source: sfSet.has(uci) ? 'both' : 'maia' });
  }
  for (const uci of sf) {
    if (seen.has(uci)) continue;
    seen.add(uci);
    out.push({ uci, source: maiaSet.has(uci) ? 'both' : 'stockfish' });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Оркестратор.
// ---------------------------------------------------------------------------

/**
 * ADR-165 §2. Рекурсивно строит `ReviewPlan` от `rootFen`. Обход в
 * глубину: на каждом узле — фазовые прогоны Maia+SF, объединение
 * кандидатов, оценка+WDL каждого хода, аннотация резких падений WDL,
 * рекурсия вглубь до стоп-условия §4 либо аварийных лимитов.
 *
 * План — линейный поток операций с `goto` для возврата к точкам
 * ветвления (дерево иммутабельно, player резолвит FEN в globalIndex).
 */
export interface BuildReviewPlanOptions {
  /** Отмена расчёта до записи в дерево (ADR §7 «Отмена»). */
  signal?: AbortSignal;
  /** Прогресс построения: вызывается после раскрытия каждого узла. */
  onProgress?: (nodes: number) => void;
  /**
   * KS-4950: вызывается на КАЖДУЮ операцию по мере её появления (не после
   * полной сборки). Caller применяет ход к доске сразу и держит паузу —
   * фигуры двигаются в процессе разбора, а не «накопили → проиграли».
   * Если вернёт промис — `buildReviewPlan` его дождётся (пауза задаёт темп).
   */
  onOp?: (op: ReviewPlanOp) => void | Promise<void>;
}

/** Бросается `buildReviewPlan` при отмене через `signal`. */
export class ReviewAbortError extends Error {
  constructor() {
    super('Review build aborted');
    this.name = 'AbortError';
  }
}

export async function buildReviewPlan(
  rootFen: string,
  engines: PositionReviewEngines,
  config: ReviewConfig = defaultReviewConfig(),
  options: BuildReviewPlanOptions = {},
): Promise<ReviewPlan> {
  const { thresholds, limits, elo } = config;
  const { signal, onProgress, onOp } = options;
  const ops: ReviewPlanOp[] = [];
  const stats: ReviewPlanStats = {
    nodes: 0,
    leaves: {
      understood: 0,
      max_depth: 0,
      max_nodes: 0,
      repetition: 0,
      terminal: 0,
    },
    maxDepthReached: 0,
    truncatedByNodes: false,
    degradedNoSf: false,
  };
  const visited = new Set<string>();
  // Счётчик стабильных id узлов плана (0,1,2…). goto ссылается на id,
  // а не на FEN — иначе транспозиции ломают навигацию к развилке.
  let nextNodeId = 0;
  // Разбираемая сторона = кто ходит в корне. За неё берём сильнейшие ходы
  // Stockfish; за соперника — вероятные человеческие ходы Maia.
  const rootSide = rootFen.split(' ')[1] === 'b' ? 'b' : 'w';

  // Добавить операцию в план и сразу отдать её caller'у (streaming на
  // доску). Пауза внутри onOp задаёт темп проигрывания.
  const emit = async (op: ReviewPlanOp): Promise<void> => {
    if (signal?.aborted) throw new ReviewAbortError();
    ops.push(op);
    await onOp?.(op);
  };

  // Позиционируемся на корне разбора (текущая позиция пользователя).
  await emit({ type: 'goto', toId: REVIEW_ROOT_ID });

  const markLeaf = (reason: ReviewStopReason) => {
    stats.leaves[reason] += 1;
  };

  /** Оценка узла: WDL POV сделавшего ход (инверсия raw SF POV соперника). */
  const evalAfterMove = async (
    childFen: string,
  ): Promise<Wdl | null> => {
    const childEval = await engines.analyze(childFen, 1);
    if (!childEval) return null;
    // childEval.wdl — POV стороны на ходу в childFen (= соперник
    // сделавшего ход). Инвертируем к POV сделавшего ход.
    return invertWdl(childEval.wdl);
  };

  // `parentId` — id узла, чья позиция = `fen` (REVIEW_ROOT_ID для корня).
  // Возврат к развилке между сиблингами делается goto именно к нему.
  const expand = async (
    fen: string,
    depth: number,
    parentId: number,
  ): Promise<void> => {
    if (signal?.aborted) throw new ReviewAbortError();
    stats.maxDepthReached = Math.max(stats.maxDepthReached, depth);

    if (stats.nodes >= limits.maxNodes) {
      stats.truncatedByNodes = true;
      markLeaf('max_nodes');
      return;
    }
    if (depth >= limits.maxDepth) {
      markLeaf('max_depth');
      return;
    }
    const key = positionKey(fen);
    if (visited.has(key)) {
      markLeaf('repetition');
      return;
    }
    visited.add(key);
    stats.nodes += 1;
    onProgress?.(stats.nodes);

    // Фаза 1: SF-оценка узла (bestmove, WDL, MultiPV-кандидаты).
    const nodeEval = await engines.analyze(fen, limits.stockfishMultiPv);
    if (!nodeEval) stats.degradedNoSf = true;

    // Терминал: SF есть, но ходов нет (мат/пат).
    if (nodeEval && nodeEval.bestUci === null && nodeEval.multipv.length === 0) {
      markLeaf('terminal');
      return;
    }

    // Академичность: за разбираемую сторону берём СИЛЬНЕЙШИЕ ходы
    // Stockfish (мы играем лучшее); за соперника — вероятные человеческие
    // ходы Maia (как он реально может ответить).
    const ourTurn = (fen.split(' ')[1] === 'b' ? 'b' : 'w') === rootSide;

    // policy Maia нужна только на ходе соперника (и для % в комментарии).
    let policy: Record<string, number> = {};
    let candidates: Array<{ uci: string; source: ReviewMoveSource }>;
    if (ourTurn) {
      // За разбираемую сторону — РОВНО один сильнейший ход SF, без
      // альтернатив (ветвление только у соперника).
      const best = nodeEval?.bestUci ?? nodeEval?.multipv[0] ?? null;
      candidates = best ? [{ uci: best, source: 'stockfish' }] : [];
    } else {
      policy = await engines.getMaiaPolicy(fen, elo);
      const maiaCands = selectMaiaCandidates(policy, thresholds).slice(
        0,
        limits.maxBranchPerSource,
      );
      const sfSet = new Set(nodeEval?.multipv ?? []);
      candidates = maiaCands.map((uci) => ({
        uci,
        source: sfSet.has(uci) ? 'both' : 'maia',
      }));
    }
    if (candidates.length === 0) {
      // Нет человеческого хода ≥ порога — обрываем ветку и ставим оценку SF
      // на текущем узле (конец разбора этой линии).
      if (nodeEval?.score) {
        const whiteToMove = fen.split(' ')[1] === 'w';
        await emit({
          type: 'annotate',
          comment: formatSfEvalComment(nodeEval.score, whiteToMove),
        });
      }
      markLeaf('terminal');
      return;
    }

    // Фаза 3: оценка+WDL каждого кандидата (последовательно).
    const evaluated: Array<{
      uci: string;
      san: string;
      source: ReviewMoveSource;
      childFen: string;
      wdlAfter: Wdl | null;
      maiaProb: number | null;
    }> = [];
    for (const cand of candidates) {
      const childFen = engines.applyMove(fen, cand.uci);
      if (childFen === null) continue; // нелегальный — пропуск
      const wdlAfter = await evalAfterMove(childFen);
      evaluated.push({
        uci: cand.uci,
        san: engines.toSan(fen, cand.uci),
        source: cand.source,
        childFen,
        wdlAfter,
        maiaProb: Number.isFinite(policy[cand.uci]) ? policy[cand.uci] : null,
      });
    }
    if (evaluated.length === 0) {
      markLeaf('terminal');
      return;
    }

    // Лучший кандидат = max expected-score POV сделавшего ход (для ΔWDL).
    // Заодно индекс сильнейшего — его повысим до главной линии (§ повышение).
    let bestE = -Infinity;
    let strongestIdx = -1;
    let strongestE = -Infinity;
    evaluated.forEach((e, idx) => {
      if (!e.wdlAfter) return;
      const es = expectedScoreFromWdl(e.wdlAfter);
      bestE = Math.max(bestE, es);
      if (es > strongestE + 1e-9) {
        strongestE = es;
        strongestIdx = idx;
      }
    });

    // Фаза 4: сначала ШИРИНА — выводим ВСЕ ходы-альтернативы этого узла
    // (они не тратят бюджет узлов и появляются всегда, даже при исчерпании
    // лимита в глубоких ветках), затем ГЛУБИНА — рекурсия по каждому.
    // Иначе первая ветка уходила бы в глубину до конца, съедая maxNodes, и
    // альтернативы 1-го хода не появлялись бы вовсе.
    const childIds: number[] = [];

    // Пасс 1 (ширина): все сиблинги как варианты от развилки.
    for (let i = 0; i < evaluated.length; i++) {
      const e = evaluated[i];
      if (i > 0) await emit({ type: 'goto', toId: parentId });
      const childId = nextNodeId++;
      childIds.push(childId);
      await emit({
        type: 'move',
        id: childId,
        uci: e.uci,
        san: e.san,
        source: e.source,
        wdlAfter: e.wdlAfter,
      });
      // Аннотация: резкое падение WDL относительно лучшего кандидата.
      if (e.wdlAfter && bestE > -Infinity) {
        const lossE = Math.max(0, bestE - expectedScoreFromWdl(e.wdlAfter));
        const nag = nagForLossE(lossE);
        if (nag !== null) {
          const maiaPct =
            e.maiaProb !== null ? Math.round(e.maiaProb * 100) : null;
          const outcomePct = Math.round((maxOutcomeProb(e.wdlAfter) || 0) * 100);
          const maiaPart = maiaPct !== null ? `Maia ${maiaPct}%, ` : '';
          await emit({
            type: 'annotate',
            nag,
            comment: `${e.san} (${maiaPart}${outcomePct}%)`,
          });
        }
      }
      // Повышение: сильнейший по оценке ход становится главной линией
      // (первый сиблинг уже главный — повышаем, только если сильнее он).
      if (i === strongestIdx && strongestIdx > 0) {
        await emit({ type: 'promote' });
      }
    }

    // Пасс 2 (глубина): углубляемся в каждый сиблинг по очереди. При
    // единственном кандидате currentMove уже на нём — goto не нужен.
    const multi = evaluated.length > 1;
    for (let i = 0; i < evaluated.length; i++) {
      if (multi) await emit({ type: 'goto', toId: childIds[i] });
      await expand(evaluated[i].childFen, depth + 1, childIds[i]);
    }
  };

  await expand(rootFen, 0, REVIEW_ROOT_ID);
  return { rootFen, elo, ops, stats };
}
