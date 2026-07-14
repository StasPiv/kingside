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
 * Пороги ветвления соперника и точек выхода (ADR-165 rev4 §3-§4).
 * Ветвим ходы соперника по nucleus-покрытию `pCover` с абсолютным полом
 * `pFloor` и жёстким потолком `kMax`. Выход: `decisive` (наказание
 * ошибки) и `nearEqualBand` (теория) — из WDL.
 */
export interface ReviewThresholds {
  /** Кумулятивная масса покрытия ходов соперника (nucleus). Default 0.90. */
  pCover: number;
  /** Абсолютный пол вероятности хода соперника. Default 0.08. */
  pFloor: number;
  /** Жёсткий потолок ширины (ходов соперника на узел). Default 3. */
  kMax: number;
  /** Ожидаемый счёт за нас ≥ этого → выход `refuted` (наказали ошибку). Default 0.90. */
  decisive: number;
  /** Полуширина зоны near-equal вокруг 0.5 (теория). Default 0.10 → [0.40,0.60]. */
  nearEqualBand: number;
  /** Горизонт дебюта (полуходы): near-equal + глубина ≥ этого → theory. Default 24. */
  openingHorizonPly: number;
}

/**
 * Щедрые предохранители (ADR-165 rev4 §5). Глубину задаёт `exit()`, НЕ
 * фиксированный потолок. При достижении лист помечается `[%exit limit]`.
 */
export interface ReviewLimits {
  /** Предохранитель по глубине (полуходы). Default 30. */
  maxPly: number;
  /** Предохранитель по числу узлов. Default 200. */
  maxNodes: number;
}

export interface ReviewConfig {
  thresholds: ReviewThresholds;
  limits: ReviewLimits;
  /** ELO уровня Maia (= рейтинг игрока или 1500). */
  elo: number;
}

export const DEFAULT_REVIEW_THRESHOLDS: ReviewThresholds = {
  pCover: 0.9,
  pFloor: 0.08,
  kMax: 3,
  decisive: 0.9,
  nearEqualBand: 0.1,
  openingHorizonPly: 24,
};

export const DEFAULT_REVIEW_LIMITS: ReviewLimits = {
  maxPly: 30,
  maxNodes: 200,
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

/** Причина завершения ветки (лист) — ADR-165 rev4 §4. */
export type ReviewExitKind =
  | 'theory' // дебют пройден / вынужденно / позиция стабильна
  | 'refuted' // ошибка соперника наказана до перевеса
  | 'transposition' // нормализованный FEN уже в дереве
  | 'limit' // предохранитель maxPly/maxNodes — ветка НЕ достроена
  | 'terminal'; // мат/пат/нет хода

/** Машинный тег `[%exit …]` в комментарии узла-листа (фронт парсит). */
export function exitTag(kind: ReviewExitKind): string {
  return `[%exit ${kind}]`;
}

export interface ReviewPlanStats {
  /** Число раскрытых узлов. */
  nodes: number;
  /** Число листьев по каждой причине выхода. */
  leaves: Record<ReviewExitKind, number>;
  /** Достигнутая максимальная глубина (полуходы). */
  maxPlyReached: number;
  /** SF был недоступен хотя бы на одном узле. */
  degradedNoSf: boolean;
}

export interface ReviewPlan {
  rootFen: string;
  elo: number;
  ops: ReviewPlanOp[];
  stats: ReviewPlanStats;
}

// ---------------------------------------------------------------------------
// §3 — ветвление соперника по nucleus-покрытию.
// ---------------------------------------------------------------------------

/**
 * ADR-165 rev4 §3. Человеческие ходы соперника через покрытие (nucleus):
 * берём ходы по убыванию вероятности, пока кумулятивно не покрыто
 * `pCover`; каждый ≥ `pFloor`; не более `kMax`. Возвращает UCI'и
 * prob-desc (самый вероятный — первым, он станет главной линией).
 */
export function selectOpponentMoves(
  policy: Record<string, number>,
  thresholds: ReviewThresholds,
): string[] {
  const entries = Object.entries(policy)
    .filter(([, p]) => Number.isFinite(p) && p > 0)
    .sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return [];

  const result: string[] = [];
  let cum = 0;
  for (const [uci, prob] of entries) {
    if (result.length >= thresholds.kMax) break;
    if (prob < thresholds.pFloor) break;
    // Уже покрыли достаточно человеческой массы — хвост не берём.
    if (result.length > 0 && cum >= thresholds.pCover) break;
    result.push(uci);
    cum += prob;
  }
  return result;
}

/**
 * KS-4950: комментарий с оценкой Stockfish. `score` — POV стороны на
 * ходу; приводим к POV белых.
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
// §4 — точки выхода из дебютной ветки.
// ---------------------------------------------------------------------------

/** max(W,D,L)/1000 позиции. */
export function maxOutcomeProb(wdl: Wdl): number {
  return Math.max(wdl.w, wdl.d, wdl.l) / 1000;
}

/** Сторона на ходу по FEN. */
export function sideToMove(fen: string): 'w' | 'b' {
  return fen.split(' ')[1] === 'b' ? 'b' : 'w';
}

/** Оба короля покинули исходные клетки (e1/e8) — развились/рокировали. */
export function bothDeveloped(fen: string): boolean {
  const board = fen.split(' ')[0];
  const ranks = board.split('/');
  if (ranks.length !== 8) return false;
  // ranks[0] = 8-я (чёрные), ranks[7] = 1-я (белые). Файл 'e' = индекс 4.
  const fileOf = (rank: string, target: number): string | null => {
    let file = 0;
    for (const ch of rank) {
      if (ch >= '1' && ch <= '8') file += Number(ch);
      else {
        if (file === target) return ch;
        file += 1;
      }
      if (file > target) return null;
    }
    return null;
  };
  const whiteKingE1 = fileOf(ranks[7], 4) === 'K';
  const blackKingE8 = fileOf(ranks[0], 4) === 'k';
  return !whiteKingE1 && !blackKingE8;
}

/** Ожидаемый счёт (win-prob) в зоне near-equal вокруг 0.5 ± band. */
export function isNearEqual(expScore: number, band: number): boolean {
  return Math.abs(expScore - 0.5) <= band;
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
    leaves: { theory: 0, refuted: 0, transposition: 0, limit: 0, terminal: 0 },
    maxPlyReached: 0,
    degradedNoSf: false,
  };
  // Нормализованные FEN всех позиций после НАШИХ ходов — для транспозиций.
  const visited = new Set<string>();
  let nextNodeId = 0;

  const emit = async (op: ReviewPlanOp): Promise<void> => {
    if (signal?.aborted) throw new ReviewAbortError();
    ops.push(op);
    await onOp?.(op);
  };
  await emit({ type: 'goto', toId: REVIEW_ROOT_ID });

  const markLeaf = (kind: ReviewExitKind) => {
    stats.leaves[kind] += 1;
  };

  /** SF-эвал узла (`null` — SF недоступен). */
  const analyzeNode = async (fen: string): Promise<PositionReviewEval | null> => {
    const e = await engines.analyze(fen, 1);
    if (!e) stats.degradedNoSf = true;
    return e;
  };

  /** Пометить лист причиной выхода: тег [%exit …] + текст в комментарий. */
  const emitExitLeaf = async (
    kind: ReviewExitKind,
    posFen: string,
    scoreForRefuted: { type: 'cp' | 'mate'; value: number } | null,
  ): Promise<void> => {
    let text = '';
    if (kind === 'theory') text = 'дебют пройден';
    else if (kind === 'transposition') text = 'перестановка';
    else if (kind === 'limit') text = 'обрыв по лимиту';
    else if (kind === 'refuted') {
      text = scoreForRefuted
        ? formatSfEvalComment(scoreForRefuted, sideToMove(posFen) === 'w')
        : '+-';
    }
    await emit({
      type: 'annotate',
      comment: `${exitTag(kind)} ${text}`.trim(),
    });
    markLeaf(kind);
  };

  // Наш ход: ровно один сильнейший ход SF. Затем exit ЛИБО ход соперника.
  const buildOur = async (
    fen: string,
    depth: number,
    _parentId: number,
  ): Promise<void> => {
    if (signal?.aborted) throw new ReviewAbortError();
    stats.maxPlyReached = Math.max(stats.maxPlyReached, depth);

    const nodeEval = await analyzeNode(fen);
    const best = nodeEval?.bestUci ?? null;
    if (!best) {
      markLeaf('terminal'); // мат/пат/SF недоступен — редкий лист
      return;
    }
    const childFen = engines.applyMove(fen, best);
    if (childFen === null) {
      markLeaf('terminal');
      return;
    }
    // WDL после нашего хода, POV нас (в childFen ходит соперник).
    const childEval = await analyzeNode(childFen);
    const wdlAfterUs = childEval ? invertWdl(childEval.wdl) : null;

    const ourMoveId = nextNodeId++;
    stats.nodes += 1;
    onProgress?.(stats.nodes);
    await emit({
      type: 'move',
      id: ourMoveId,
      uci: best,
      san: engines.toSan(fen, best),
      source: 'stockfish',
      wdlAfter: wdlAfterUs,
    });

    // Точка выхода — ТОЛЬКО после нашего хода (childFen — ход соперника).
    // Порядок: transposition → refuted → theory → limit.
    const normFen = positionKey(childFen);
    if (visited.has(normFen)) {
      await emitExitLeaf('transposition', childFen, null);
      return;
    }
    visited.add(normFen);

    const ourExp = wdlAfterUs ? expectedScoreFromWdl(wdlAfterUs) : 0.5;
    if (ourExp >= thresholds.decisive) {
      await emitExitLeaf('refuted', childFen, childEval?.score ?? null);
      return;
    }

    // Человеческие ходы соперника (nucleus §3) — нужны и для theory, и далее.
    const oppPolicy = await engines.getMaiaPolicy(childFen, elo);
    const oppMoves = selectOpponentMoves(oppPolicy, thresholds);

    const nearEqual = isNearEqual(ourExp, thresholds.nearEqualBand);
    // Горизонт дебюта: соперник сошёлся к одному ходу, либо оба развились
    // (короли ушли с e1/e8), либо достигнута дебютная глубина.
    const horizon =
      oppMoves.length <= 1 ||
      bothDeveloped(childFen) ||
      depth + 1 >= thresholds.openingHorizonPly;
    if (nearEqual && horizon) {
      await emitExitLeaf('theory', childFen, null);
      return;
    }

    // Предохранитель: щедрый лимит, лист помечается [%exit limit].
    if (depth + 1 >= limits.maxPly || stats.nodes >= limits.maxNodes) {
      await emitExitLeaf('limit', childFen, null);
      return;
    }

    // Иначе — ветвим соперника, дальше ОБЯЗАТЕЛЬНО наш ответ.
    await buildOpp(childFen, depth + 1, ourMoveId, oppPolicy, oppMoves);
  };

  // Ход соперника: ветвление по Maia; каждый ответ → наш ход (buildOur).
  const buildOpp = async (
    fen: string,
    depth: number,
    parentId: number,
    oppPolicy: Record<string, number>,
    oppMovesIn: string[],
  ): Promise<void> => {
    if (signal?.aborted) throw new ReviewAbortError();

    let oppMoves = oppMovesIn;
    let fromMaia = true;
    if (oppMoves.length === 0) {
      // Нет человеческого хода — берём сильнейший SF (одиночный), чтобы
      // сохранить инвариант (у нас всегда есть ответ дальше).
      const e = await analyzeNode(fen);
      oppMoves = e?.bestUci ? [e.bestUci] : [];
      fromMaia = false;
    }
    if (oppMoves.length === 0) {
      markLeaf('terminal'); // пат/нет ходов
      return;
    }

    // Оценка каждого хода соперника (POV соперника) для NAG.
    const evald: Array<{
      uci: string;
      san: string;
      childFen: string;
      oppWdl: Wdl | null;
      oppExp: number;
      maiaProb: number | null;
    }> = [];
    for (const uci of oppMoves) {
      const cf = engines.applyMove(fen, uci);
      if (cf === null) continue;
      const ce = await analyzeNode(cf); // POV нас (cf — наш ход)
      const oppWdl = ce ? invertWdl(ce.wdl) : null; // POV соперника
      evald.push({
        uci,
        san: engines.toSan(fen, uci),
        childFen: cf,
        oppWdl,
        oppExp: oppWdl ? expectedScoreFromWdl(oppWdl) : 0.5,
        maiaProb: Number.isFinite(oppPolicy[uci]) ? oppPolicy[uci] : null,
      });
    }
    if (evald.length === 0) {
      markLeaf('terminal');
      return;
    }

    // Лучший ответ соперника = max его expected-score (сильнейшая защита).
    const bestOppE = Math.max(...evald.map((e) => e.oppExp));

    // Пасс 1 (ширина): все ходы соперника + аннотации Maia%/WDL/NAG.
    const childIds: number[] = [];
    for (let i = 0; i < evald.length; i++) {
      const e = evald[i];
      if (i > 0) await emit({ type: 'goto', toId: parentId });
      const id = nextNodeId++;
      childIds.push(id);
      stats.nodes += 1;
      await emit({
        type: 'move',
        id,
        uci: e.uci,
        san: e.san,
        source: fromMaia ? 'maia' : 'stockfish',
        wdlAfter: e.oppWdl,
      });
      // Аннотация хода соперника: Maia% + WDL, NAG если ошибка.
      const lossE = Math.max(0, bestOppE - e.oppExp);
      const nag = nagForLossE(lossE);
      const maiaPct = e.maiaProb !== null ? Math.round(e.maiaProb * 100) : null;
      const outcomePct = e.oppWdl
        ? Math.round(maxOutcomeProb(e.oppWdl) * 100)
        : null;
      const parts: string[] = [];
      if (maiaPct !== null) parts.push(`Maia ${maiaPct}%`);
      if (outcomePct !== null) parts.push(`${outcomePct}%`);
      if (parts.length > 0 || nag !== null) {
        await emit({
          type: 'annotate',
          nag: nag ?? undefined,
          comment: parts.length > 0 ? `${e.san} (${parts.join(', ')})` : undefined,
        });
      }
    }

    // Пасс 2 (глубина): наш ответ на каждый ход соперника.
    const multi = evald.length > 1;
    for (let i = 0; i < evald.length; i++) {
      if (multi) await emit({ type: 'goto', toId: childIds[i] });
      await buildOur(evald[i].childFen, depth + 1, childIds[i]);
    }
  };

  // Корень = наш ход (разбираемая сторона = кто ходит в корне).
  await buildOur(rootFen, 0, REVIEW_ROOT_ID);
  return { rootFen, elo, ops, stats };
}
