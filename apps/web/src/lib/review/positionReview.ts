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
  /** Кумулятивная масса покрытия ходов соперника (nucleus). */
  pCover: number;
  /** Абсолютный пол вероятности хода соперника (P_min). */
  pFloor: number;
  /** Жёсткий потолок ширины (ходов соперника на узел). */
  kMax: number;
  /** Ожидаемый счёт за нас ≥ этого → выход `refuted`. Default 0.90. */
  decisive: number;
  /** Полуширина зоны near-equal вокруг 0.5 (теория). Default 0.10. */
  nearEqualBand: number;
  /** Горизонт дебюта (полуходы): near-equal + глубина ≥ этого → theory. Default 24. */
  openingHorizonPly: number;
  /**
   * ADR-165 rev5 §4. Порог редкости линии: pathProb (произведение
   * вероятностей ходов соперника по пути) < этого → выход `rare`. Default 0.03.
   */
  pathProbMin: number;
}

/**
 * Границы конечности (ADR-165 rev5 §4). `dTarget` — целевая глубина в
 * ПОЛНЫХ ходах (главная граница); `maxNodes` — глобальный предохранитель
 * (budget). Глубину линии задаёт dTarget/theory/refuted, а не режущий maxPly.
 */
export interface ReviewLimits {
  /** Целевая глубина репертуара в полных ходах. Default 10. */
  dTarget: number;
  /** Глобальный предохранитель по числу узлов (budget N_max). Default 300. */
  maxNodes: number;
}

export interface ReviewConfig {
  thresholds: ReviewThresholds;
  limits: ReviewLimits;
  /** ELO уровня Maia (= рейтинг игрока или 1500). */
  elo: number;
}

/** Пресеты глубины/ширины (ADR-165 rev5 §6). */
export type ReviewPreset = 'brief' | 'standard' | 'detailed';

/** Пороги пресета: (dTarget, pFloor=P_min, pCover, kMax). */
export const REVIEW_PRESETS: Record<
  ReviewPreset,
  { dTarget: number; pFloor: number; pCover: number; kMax: number }
> = {
  brief: { dTarget: 8, pFloor: 0.15, pCover: 0.85, kMax: 2 },
  standard: { dTarget: 10, pFloor: 0.1, pCover: 0.9, kMax: 3 },
  detailed: { dTarget: 12, pFloor: 0.07, pCover: 0.92, kMax: 4 },
};

export const DEFAULT_REVIEW_THRESHOLDS: ReviewThresholds = {
  pCover: REVIEW_PRESETS.standard.pCover,
  pFloor: REVIEW_PRESETS.standard.pFloor,
  kMax: REVIEW_PRESETS.standard.kMax,
  decisive: 0.9,
  nearEqualBand: 0.1,
  openingHorizonPly: 24,
  pathProbMin: 0.03,
};

export const DEFAULT_REVIEW_LIMITS: ReviewLimits = {
  dTarget: REVIEW_PRESETS.standard.dTarget,
  maxNodes: 300,
};

export const DEFAULT_REVIEW_ELO = 1500;

export function defaultReviewConfig(elo: number = DEFAULT_REVIEW_ELO): ReviewConfig {
  return {
    thresholds: { ...DEFAULT_REVIEW_THRESHOLDS },
    limits: { ...DEFAULT_REVIEW_LIMITS },
    elo,
  };
}

/** Конфиг под пресет (§6). Прочие пороги — из умолчаний. */
export function reviewConfigForPreset(
  preset: ReviewPreset,
  elo: number = DEFAULT_REVIEW_ELO,
): ReviewConfig {
  const p = REVIEW_PRESETS[preset];
  return {
    thresholds: {
      ...DEFAULT_REVIEW_THRESHOLDS,
      pFloor: p.pFloor,
      pCover: p.pCover,
      kMax: p.kMax,
    },
    limits: { ...DEFAULT_REVIEW_LIMITS, dTarget: p.dTarget },
    elo,
  };
}

/**
 * ADR-165 rev5 §6/§8.3. Оценка ожидаемого числа позиций ДО построения —
 * из `dTarget`, ширины (`kMax`, `pCover`, `pFloor`) и отсечения по
 * `pathProbMin`. Грубая верхняя оценка для подписи «~Y позиций».
 */
export function estimateReviewSize(config: ReviewConfig): number {
  const { kMax, pCover, pathProbMin } = config.thresholds;
  const { dTarget } = config.limits;
  // Репрезентативная вероятность частого хода соперника (около половины
  // массы покрытия). Близка у всех пресетов → монотонность оценки задают
  // ширина `kMax` и глубина `dTarget`, а не побочная зависимость от них.
  const repProb = Math.min(0.9, Math.max(0.05, pCover / 2));
  // Глубина (полные ходы), где pathProb падает ниже порога редкости.
  const rareDepth = Math.max(
    1,
    Math.floor(Math.log(pathProbMin) / Math.log(repProb)),
  );
  const effDepth = Math.max(1, Math.min(dTarget, rareDepth));
  // На каждом полном ходу: наш ход (1) + соперник (до kMax ветвей).
  let positions = 0;
  let level = 1;
  for (let d = 0; d < effDepth; d++) {
    positions += level * 2;
    level *= Math.max(1, kMax);
  }
  return positions;
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

/** Причина завершения ветки (лист) — ADR-165 rev4/rev5 §4. */
export type ReviewExitKind =
  | 'theory' // дебют пройден / вынужденно / позиция стабильна
  | 'refuted' // ошибка соперника наказана до перевеса
  | 'transposition' // нормализованный FEN уже в дереве
  | 'depth' // достигнута целевая глубина D_target (rev5)
  | 'rare' // pathProb < P_path_min — редкая линия опущена (rev5)
  | 'budget' // глобальный предохранитель N_max (rev5)
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
    leaves: {
      theory: 0,
      refuted: 0,
      transposition: 0,
      depth: 0,
      rare: 0,
      budget: 0,
      terminal: 0,
    },
    maxPlyReached: 0,
    degradedNoSf: false,
  };
  const visited = new Set<string>(); // норм. FEN после наших ходов
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

  const analyzeNode = async (fen: string): Promise<PositionReviewEval | null> => {
    const e = await engines.analyze(fen, 1);
    if (!e) stats.degradedNoSf = true;
    return e;
  };

  const emitExitLeaf = async (
    kind: ReviewExitKind,
    posFen: string,
    opts?: {
      score?: { type: 'cp' | 'mate'; value: number } | null;
      fullMove?: number;
    },
  ): Promise<void> => {
    let text = '';
    switch (kind) {
      case 'theory':
        text = 'дебют пройден';
        break;
      case 'transposition':
        text = 'перестановка';
        break;
      case 'depth':
        text = opts?.fullMove
          ? `конец репертуара, ход ${opts.fullMove}`
          : 'конец репертуара';
        break;
      case 'rare':
        text = 'редкая линия, опущена';
        break;
      case 'budget':
        text = 'лимит объёма';
        break;
      case 'terminal':
        text = 'конец игры';
        break;
      case 'refuted':
        text = opts?.score
          ? formatSfEvalComment(opts.score, sideToMove(posFen) === 'w')
          : '+-';
        break;
    }
    await emit({ type: 'annotate', comment: `${exitTag(kind)} ${text}`.trim() });
    markLeaf(kind);
  };

  // ---- Приоритетная очередь по pathProb (ADR-165 rev5 §8.2) ----
  type Task =
    | { kind: 'our'; fen: string; depth: number; parentId: number; pathProb: number }
    | {
        kind: 'opp';
        fen: string;
        depth: number;
        parentId: number;
        pathProb: number;
        oppPolicy: Record<string, number>;
        oppMoves: string[];
      };
  const frontier: Task[] = [];
  const pushTask = (t: Task) => frontier.push(t);
  const popMaxTask = (): Task | undefined => {
    if (frontier.length === 0) return undefined;
    // Частые линии первыми: max pathProb, tie — меньшая глубина.
    let best = 0;
    for (let i = 1; i < frontier.length; i++) {
      const a = frontier[i];
      const b = frontier[best];
      if (a.pathProb > b.pathProb + 1e-12) best = i;
      else if (Math.abs(a.pathProb - b.pathProb) <= 1e-12 && a.depth < b.depth)
        best = i;
    }
    return frontier.splice(best, 1)[0];
  };

  const processOur = async (task: Extract<Task, { kind: 'our' }>) => {
    stats.maxPlyReached = Math.max(stats.maxPlyReached, task.depth);
    await emit({ type: 'goto', toId: task.parentId });

    const nodeEval = await analyzeNode(task.fen);
    const best = nodeEval?.bestUci ?? null;
    if (!best) {
      // Наш король под матом/пат — реальный конец игры (редко в дебюте).
      await emitExitLeaf('terminal', task.fen);
      return;
    }
    const childFen = engines.applyMove(task.fen, best);
    if (childFen === null) {
      await emitExitLeaf('terminal', task.fen);
      return;
    }
    const childEval = await analyzeNode(childFen);
    const wdlAfterUs = childEval ? invertWdl(childEval.wdl) : null;

    const ourMoveId = nextNodeId++;
    stats.nodes += 1;
    onProgress?.(stats.nodes);
    await emit({
      type: 'move',
      id: ourMoveId,
      uci: best,
      san: engines.toSan(task.fen, best),
      source: 'stockfish',
      wdlAfter: wdlAfterUs,
    });

    // Выход — только после нашего хода. Порядок §4:
    // transposition → refuted → theory → depth → rare → budget.
    const normFen = positionKey(childFen);
    if (visited.has(normFen)) {
      await emitExitLeaf('transposition', childFen);
      return;
    }
    visited.add(normFen);

    const ourExp = wdlAfterUs ? expectedScoreFromWdl(wdlAfterUs) : 0.5;
    if (ourExp >= thresholds.decisive) {
      await emitExitLeaf('refuted', childFen, { score: childEval?.score ?? null });
      return;
    }

    const oppPolicy = await engines.getMaiaPolicy(childFen, elo);
    const oppMoves = selectOpponentMoves(oppPolicy, thresholds);

    // ADR-165 §4 theory: позиция near-equal И «у соперника нет расходящихся
    // альтернатив выше порога» — т.е. ровно ОДИН разумный ответ (forced).
    //
    // KS-4975 (репро в positionReview.repro.test.ts): раньше условие было
    //   `oppMoves.length <= 1 || bothDeveloped(childFen) || depth >= horizon`.
    //   1) `<= 1` трактовал ПУСТОЙ список кандидатов (0) как «forced/понятно»,
    //      хотя 0 кандидатов = деградация Maia (на проде policy приходила
    //      пустой). Итог — мусор «Готово: 1 вариант, глубина 0» + ложная метка
    //      «[%exit theory] дебют пройден» после одного хода SF.
    //   2) `bothDeveloped`/`openingHorizonPly` — эвристики «дебют пройден по
    //      контексту», не входящие в определение theory ADR §4. При запуске
    //      разбора из ПРОИЗВОЛЬНОЙ (миттельшпильной) позиции они срабатывают
    //      сразу → та же ложная метка вне реального дебюта.
    // Теперь: theory только при РОВНО одном кандидате соперника. При 0
    // кандидатов (Maia пусто) НЕ выходим — ход уходит сопернику, где
    // processOpp даёт SF-fallback и строит осмысленную линию (движок
    // задействован, результат не пустой).
    const nearEqual = isNearEqual(ourExp, thresholds.nearEqualBand);
    const opponentForced = oppMoves.length === 1;
    if (nearEqual && opponentForced) {
      await emitExitLeaf('theory', childFen);
      return;
    }

    // depth: наш ход № ≥ D_target (полные ходы) → конец репертуара.
    const ourMoveNumber = Math.floor(task.depth / 2) + 1;
    if (ourMoveNumber >= limits.dTarget) {
      await emitExitLeaf('depth', childFen, { fullMove: ourMoveNumber });
      return;
    }

    // rare: путь к позиции реже порога → опускаем редкий хвост.
    if (task.pathProb < thresholds.pathProbMin) {
      await emitExitLeaf('rare', childFen);
      return;
    }

    // budget: глобальный предохранитель.
    if (stats.nodes >= limits.maxNodes) {
      await emitExitLeaf('budget', childFen);
      return;
    }

    // Иначе — ход соперника (в очередь, тот же pathProb).
    pushTask({
      kind: 'opp',
      fen: childFen,
      depth: task.depth + 1,
      parentId: ourMoveId,
      pathProb: task.pathProb,
      oppPolicy,
      oppMoves,
    });
  };

  const processOpp = async (task: Extract<Task, { kind: 'opp' }>) => {
    // budget-предохранитель: родительский наш ход становится листом budget.
    if (stats.nodes >= limits.maxNodes) {
      await emit({ type: 'goto', toId: task.parentId });
      await emitExitLeaf('budget', task.fen);
      return;
    }

    let oppMoves = task.oppMoves;
    let fromMaia = true;
    if (oppMoves.length === 0) {
      const e = await analyzeNode(task.fen);
      oppMoves = e?.bestUci ? [e.bestUci] : [];
      fromMaia = false;
    }
    if (oppMoves.length === 0) {
      await emit({ type: 'goto', toId: task.parentId });
      await emitExitLeaf('terminal', task.fen);
      return;
    }

    const evald: Array<{
      uci: string;
      san: string;
      childFen: string;
      oppWdl: Wdl | null;
      oppExp: number;
      prob: number;
    }> = [];
    for (const uci of oppMoves) {
      const cf = engines.applyMove(task.fen, uci);
      if (cf === null) continue;
      const ce = await analyzeNode(cf); // POV нас
      const oppWdl = ce ? invertWdl(ce.wdl) : null; // POV соперника
      const prob = Number.isFinite(task.oppPolicy[uci])
        ? task.oppPolicy[uci]
        : 1;
      evald.push({
        uci,
        san: engines.toSan(task.fen, uci),
        childFen: cf,
        oppWdl,
        oppExp: oppWdl ? expectedScoreFromWdl(oppWdl) : 0.5,
        prob,
      });
    }
    if (evald.length === 0) {
      await emit({ type: 'goto', toId: task.parentId });
      await emitExitLeaf('terminal', task.fen);
      return;
    }

    const bestOppE = Math.max(...evald.map((e) => e.oppExp));

    for (const e of evald) {
      await emit({ type: 'goto', toId: task.parentId });
      const id = nextNodeId++;
      stats.nodes += 1;
      await emit({
        type: 'move',
        id,
        uci: e.uci,
        san: e.san,
        source: fromMaia ? 'maia' : 'stockfish',
        wdlAfter: e.oppWdl,
      });
      const lossE = Math.max(0, bestOppE - e.oppExp);
      const nag = nagForLossE(lossE);
      const maiaPct = fromMaia ? Math.round(e.prob * 100) : null;
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
      // Наш ответ — в очередь, pathProb домножается на частоту хода.
      pushTask({
        kind: 'our',
        fen: e.childFen,
        depth: task.depth + 1,
        parentId: id,
        pathProb: task.pathProb * e.prob,
      });
    }
  };

  // Корень = наш ход. Строим по приоритету pathProb (частые линии первыми).
  pushTask({ kind: 'our', fen: rootFen, depth: 0, parentId: REVIEW_ROOT_ID, pathProb: 1 });
  for (;;) {
    if (signal?.aborted) throw new ReviewAbortError();
    const task = popMaxTask();
    if (!task) break;
    if (task.kind === 'our') await processOur(task);
    else await processOpp(task);
  }
  return { rootFen, elo, ops, stats };
}
