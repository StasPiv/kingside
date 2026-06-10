/**
 * KS-4044. Сборка payload для `POST /analyses/:analysisId/metrics-comment`.
 *
 * Цепочка зависимостей по запросу описания задачи:
 *   1. Считаем «фазу» по FEN — 0..256, где 256 = миттельшпиль, 0 =
 *      эндшпиль (формула tapered из описания: `value_cp =
 *      (mg·phase + eg·(256−phase))/256`).
 *   2. Для каждого из 7 блоков (`METRIC_BLOCKS`) считаем `value_cp` —
 *      сумму tapered-значений всех подкомпонент блока (та же знаковая
 *      конвенция, что в `buildCurrentPositionMetricRows` /
 *      `buildMetricBlockRows`).
 *   3. Опционально прикладываем оценку SF-18 для текущей позиции.
 *
 * Никаких побочных эффектов и сетевых вызовов в этом модуле —
 * чистая функция, легко тестируется.
 */
import type { PositionalSubterm } from '@kingside/shared';
import { METRIC_BLOCKS, type MetricBlockKey } from './metricBlocks';

/** Stockfish-конвенция фаз: knight/bishop = 1, rook = 2, queen = 4. */
const PIECE_PHASE: Readonly<Record<string, number>> = {
  N: 1,
  n: 1,
  B: 1,
  b: 1,
  R: 2,
  r: 2,
  Q: 4,
  q: 4,
};
/** Полный материал на старте: 4·1 + 4·1 + 4·2 + 2·4 = 24. */
const TOTAL_PHASE_UNITS = 24;

/**
 * Посчитать `phase` (0..256) по полю-доске FEN. 256 — миттельшпиль
 * (полный материал), 0 — чистый эндшпиль (одни короли + пешки).
 *
 * Эта формула — конвенция описания KS-4044
 * `value_cp = (mg·phase + eg·(256−phase))/256`. Stockfish-trace
 * напрямую `PositionalTracePly.phase` не отдаёт для произвольной
 * позиции — считаем сами по FEN.
 */
export function computePhaseFromFen(fen: string): number {
  if (typeof fen !== 'string' || fen.length === 0) return 128;
  const board = fen.split(' ')[0] ?? '';
  let units = 0;
  for (const ch of board) {
    const w = PIECE_PHASE[ch];
    if (w) units += w;
  }
  const clamped = Math.min(units, TOTAL_PHASE_UNITS);
  return Math.round((clamped * 256) / TOTAL_PHASE_UNITS);
}

/** Из `phase=0..256` получить tapered-значение для одной подкомпоненты. */
function pickValueWithPhase(
  s: PositionalSubterm,
  phase: number,
): number {
  const mg = s.value_mg;
  const eg = s.value_eg;
  if (!Number.isFinite(mg) || !Number.isFinite(eg)) return 0;
  return (mg * phase + eg * (256 - phase)) / 256;
}

/**
 * Знаковая конвенция SF та же, что в `currentPositionMetricRows.ts`:
 * для `psqt_*`/`material`/`imbalance` SF выдаёт значения со стороны
 * белых (signed sum), для остальных — со стороны владельца (по
 * `color`). В `value_cp` блока эту конвенцию надо сохранить: для
 * белосторонних компонент берём сумму как есть, для остальных —
 * `white_sum − black_sum`.
 */
const WHITE_SIGNED_IDS: ReadonlySet<string> = new Set([
  'psqt_pawn',
  'psqt_knight',
  'psqt_bishop',
  'psqt_rook',
  'psqt_queen',
  'psqt_king',
  'material',
  'imbalance',
]);

function valueCpByBlock(
  subterms: ReadonlyArray<PositionalSubterm>,
  blockIds: ReadonlyArray<string>,
  phase: number,
): number {
  const allowed = new Set(blockIds);
  // По каждому id: накопить white/black/signedSum в зависимости от
  // конвенции. Затем для блока сумма diff по подкомпонентам.
  const byId = new Map<
    string,
    {
      whiteOwner: number;
      blackOwner: number;
      whiteSignedSum: number;
      whiteSigned: boolean;
    }
  >();
  for (const s of subterms) {
    if (typeof s.id !== 'string' || !allowed.has(s.id)) continue;
    const v = pickValueWithPhase(s, phase);
    const whiteSigned = WHITE_SIGNED_IDS.has(s.id);
    const bucket = byId.get(s.id) ?? {
      whiteOwner: 0,
      blackOwner: 0,
      whiteSignedSum: 0,
      whiteSigned,
    };
    if (whiteSigned) {
      bucket.whiteSignedSum += v;
    } else if (s.color === 'b') {
      bucket.blackOwner += v;
    } else {
      bucket.whiteOwner += v;
    }
    byId.set(s.id, bucket);
  }
  let total = 0;
  for (const b of byId.values()) {
    if (b.whiteSigned) {
      total += b.whiteSignedSum;
    } else {
      total += b.whiteOwner - b.blackOwner;
    }
  }
  return total;
}

/** API-маппинг ключа блока (внутренний фронт ↔ контракт LLM). */
const BLOCK_KEY_TO_API: Readonly<Record<MetricBlockKey, string>> = {
  material: 'material',
  'pawn-structure': 'pawn_structure',
  'king-safety': 'king_safety',
  pieces: 'pieces',
  mobility: 'mobility',
  threats: 'threats',
  passed: 'passed_pawns',
  space: 'space',
};

/** Список ключей, которые отправляются (7 блоков по описанию задачи; `space` не входит в контракт LLM). */
const LLM_BLOCK_KEYS: ReadonlyArray<MetricBlockKey> = [
  'material',
  'pawn-structure',
  'king-safety',
  'pieces',
  'mobility',
  'threats',
  'passed',
];

export type MetricsCommentBlockId =
  | 'material'
  | 'pawn_structure'
  | 'king_safety'
  | 'pieces'
  | 'mobility'
  | 'threats'
  | 'passed_pawns';

export interface MetricsCommentRequest {
  fen: string;
  phase: number;
  sf18_eval?: { type: 'cp' | 'mate'; value: number };
  metrics: Record<MetricsCommentBlockId, { value_cp: number }>;
}

export interface MetricsCommentResponseBlock {
  id: MetricsCommentBlockId;
  verdict: string;
  comment: string;
}

export interface MetricsCommentResponse {
  summary: string;
  blocks: ReadonlyArray<MetricsCommentResponseBlock>;
}

export interface BuildMetricsCommentArgs {
  fen: string;
  subterms: ReadonlyArray<PositionalSubterm>;
  /**
   * Опциональная оценка движка для текущей позиции. Передаётся как есть
   * по контракту KS-4044. Если `null`/`undefined` — поле не включается.
   */
  sf18Eval?: { type: 'cp' | 'mate'; value: number } | null;
  /**
   * Опциональный override фазы. Если не задан — считаем по FEN.
   */
  phase?: number;
}

export function buildMetricsCommentRequest(
  args: BuildMetricsCommentArgs,
): MetricsCommentRequest {
  const phase = typeof args.phase === 'number'
    ? Math.max(0, Math.min(256, Math.round(args.phase)))
    : computePhaseFromFen(args.fen);
  const metrics = {} as MetricsCommentRequest['metrics'];
  for (const blockKey of LLM_BLOCK_KEYS) {
    const block = METRIC_BLOCKS.find((b) => b.key === blockKey)!;
    const apiKey = BLOCK_KEY_TO_API[blockKey] as MetricsCommentBlockId;
    const valueCp = valueCpByBlock(args.subterms, block.ids, phase);
    metrics[apiKey] = { value_cp: round3(valueCp) };
  }
  const out: MetricsCommentRequest = {
    fen: args.fen,
    phase,
    metrics,
  };
  if (args.sf18Eval && Number.isFinite(args.sf18Eval.value)) {
    out.sf18_eval = {
      type: args.sf18Eval.type,
      value: args.sf18Eval.value,
    };
  }
  return out;
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}
