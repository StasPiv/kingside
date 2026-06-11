/**
 * KS-4071. Единый источник истины для разбиения позиционных подкомпонент
 * Stockfish на семь блоков, используемых в LLM-комментарии позиции
 * (`POST /analyses/position/comment`).
 *
 * Раньше состав групп и формула агрегации жили в двух местах независимо:
 * клиентская часть (`apps/web/src/lib/review/metricBlocks.ts`,
 * `metricsCommentPayload.ts` — KS-4043 / KS-4044) и серверный
 * диагностический скрипт (`apps/api/src/scripts/test-position-comment.ts`).
 * Реализации разошлись: серверный вариант ошибочно включал в `king_safety`
 * подкомпоненты `king_attackers_*` и `king_safe_check_*`, а в `pieces` —
 * `space`. Эти подкомпоненты эмитятся Stockfish в нелинейных «штрафных
 * единицах» (см. `tools/stockfish-trace/src/evaluate.cpp` — kingDanger
 * формируется как `attackersCount * attackersWeight + Σ safeChecks +
 * 183*… + …`, и только потом нелинейно сворачивается в cp как
 * `kingDanger * kingDanger / 4096`). Сложение их с уже свёрнутым
 * `king_danger` в cp-шкале даёт двойной/тройной учёт — на жалобной
 * позиции из KS-4070 это приводило к расхождению с клиентской
 * формулой в ~7 раз.
 *
 * Канонична клиентская версия (KS-4043, ADR-107). Этот модуль её
 * фиксирует и реэкспортирует — серверная диагностика (`test-position-
 * comment.ts`) переключается на него; клиентская часть после задачи
 * KS-4072 (frontend follow-up) переходит на импорт отсюда.
 *
 * Содержание:
 *  - `METRIC_BLOCKS` — 7 групп с фиксированным составом id;
 *  - `LLM_BLOCK_KEYS` — порядок и имена 7 ключей, идущих в payload LLM;
 *  - `WHITE_SIGNED_IDS` — знаковая конвенция: для перечисленных id
 *    Stockfish уже отдаёт значение со знаком от белых, `color` не
 *    используется (на старте `value_mg = +0.5` для `material` означает
 *    «у белых +0.5 пешки», без учёта поля `color`);
 *  - `computePhaseFromFen` — фаза 0..256 по стандартной конвенции
 *    Stockfish (N/B=1, R=2, Q=4, npm_max=24);
 *  - `pickValueWithPhase` — линейная интерполяция (tapered) между
 *    `value_mg` и `value_eg` по фазе;
 *  - `buildMetricsCommentRequest` — сборка `metrics` для тела запроса
 *    LLM из набора подкомпонент и FEN.
 */
import type { PositionalSubtermId } from '../types/api-contracts.js';

// ─── Типы ───────────────────────────────────────────────────────────

/**
 * Минимально необходимый подмножество `PositionalSubterm`, на которое
 * полагается агрегатор. Совпадает по форме с `PositionalSubterm` из
 * `api-contracts`, но переопределено локально, чтобы не тянуть
 * полный интерфейс (он содержит `square`, который тут не нужен).
 */
export interface PositionalSubtermInput {
  id: string;
  color?: 'w' | 'b';
  value_mg?: number;
  value_eg?: number;
}

/**
 * Имена семи блоков, идущих в `metrics` тела запроса LLM. Совпадают
 * с ключами в `PositionCommentMetrics` (`packages/shared/types/api-contracts.ts`).
 * Порядок зафиксирован — он определяет порядок ключей в JSON, что
 * полезно для воспроизводимости логов и диффов.
 */
export type MetricsCommentBlockKey =
  | 'material'
  | 'pawn_structure'
  | 'king_safety'
  | 'pieces'
  | 'mobility'
  | 'threats'
  | 'passed_pawns';

export const LLM_BLOCK_KEYS: readonly MetricsCommentBlockKey[] = [
  'material',
  'pawn_structure',
  'king_safety',
  'pieces',
  'mobility',
  'threats',
  'passed_pawns',
] as const;

/**
 * Состав каждой группы: список подкомпонент Stockfish, которые
 * входят в неё и в cp-шкале сопоставимы между собой. Сырые
 * нелинейные id (`king_attackers_*`, `king_safe_check_*`) НЕ включены —
 * они уже учтены внутри `king_danger`. `space` НЕ включён ни в одну
 * группу — это отдельный 8-й блок UI, в LLM-payload не передаётся.
 * PSQT-подкомпоненты (`psqt_*`) НЕ включены — это сырая декомпозиция
 * NNUE/classical-материала без шахматной семантики, потребитель
 * (LLM) их в комментарии всё равно не использует.
 */
export const METRIC_BLOCKS: Readonly<
  Record<MetricsCommentBlockKey, readonly PositionalSubtermId[]>
> = {
  material: ['material', 'imbalance'],
  pawn_structure: [
    'pawn_connected',
    'pawn_isolated',
    'pawn_doubled',
    'pawn_backward',
    'pawn_lever_double',
    'pawn_blocked',
    'pawn_doubled_early',
  ],
  // 8 id, без `king_attackers_*` и `king_safe_check_*` — эти живут в
  // штрафной шкале SafeCheck/AttackersWeight и попадают в cp только
  // через нелинейную свёртку kingDanger. Включить их сюда — дать
  // двойной учёт.
  king_safety: [
    'king_danger',
    'king_safety_pawn',
    'king_shelter_strength',
    'king_blocked_storm',
    'king_unblocked_storm',
    'king_on_file',
    'king_pawnless_flank',
    'king_flank_attacks',
  ],
  pieces: [
    'rook_on_open_file',
    'rook_on_closed_file',
    'rook_trapped',
    'rook_on_king_ring',
    'bishop_on_king_ring',
    'bishop_long_diagonal',
    'bishop_pawns',
    'bishop_xray_pawns',
    'bishop_cornered',
    'outpost_knight',
    'outpost_bishop',
    'knight_uncontested_outpost',
    'knight_reachable_outpost',
    'minor_behind_pawn',
    'knight_king_protector_distance',
    'bishop_king_protector_distance',
    'queen_weak',
  ],
  mobility: [
    'mobility_knight',
    'mobility_bishop',
    'mobility_rook',
    'mobility_queen',
  ],
  threats: [
    'threat_by_minor',
    'threat_by_rook',
    'threat_by_king',
    'threat_hanging',
    'threat_weak_queen_protection',
    'threat_restricted_piece',
    'threat_by_safe_pawn',
    'threat_by_pawn_push',
    'threat_knight_on_queen',
    'threat_slider_on_queen',
  ],
  passed_pawns: [
    'passed_rank',
    'passed_king_proximity',
    'passed_path_advance',
    'passed_file_edge',
  ],
};

/**
 * Подкомпоненты, для которых Stockfish уже отдаёт значение со знаком
 * от белых: `value_mg = +0.5` буквально значит «у белых +0.5 пешки»,
 * поле `color` либо отсутствует, либо для них не имеет смысла. При
 * агрегации эти id берутся как есть, без переворачивания знака по
 * `color`. Остальные подкомпоненты — owner-signed: Stockfish даёт
 * значение со стороны владельца, при агрегации `color === 'b'`
 * вычитается из общей суммы.
 */
export const WHITE_SIGNED_IDS: ReadonlySet<string> = new Set<string>([
  'psqt_pawn',
  'psqt_knight',
  'psqt_bishop',
  'psqt_rook',
  'psqt_queen',
  'psqt_king',
  'material',
  'imbalance',
]);

// ─── Phase ──────────────────────────────────────────────────────────

/**
 * Phase ∈ [0..256] по стандартной конвенции Stockfish для tapered
 * eval: N/B = 1, R = 2, Q = 4, максимум 24 (на стартовой позиции —
 * 4 коня + 4 слона + 4 ладьи + 2 ферзя = 24). 256 — миттельшпиль,
 * 0 — эндшпиль (только короли).
 *
 * Чистая функция: разбирает первое поле FEN (доска), фигуры в верхнем
 * и нижнем регистре считаются одинаково.
 */
export function computePhaseFromFen(fen: string): number {
  const board = (fen.split(' ')[0] ?? '').toLowerCase();
  let phaseValue = 0;
  for (const ch of board) {
    if (ch === 'n' || ch === 'b') phaseValue += 1;
    else if (ch === 'r') phaseValue += 2;
    else if (ch === 'q') phaseValue += 4;
  }
  const NPM_MAX = 24;
  const clipped = Math.min(NPM_MAX, phaseValue);
  return Math.round((clipped * 256) / NPM_MAX);
}

/**
 * Tapered eval: `(value_mg * phase + value_eg * (256 - phase)) / 256`.
 * Если у подкомпоненты отсутствует одна из частей (`value_mg`/`value_eg`),
 * она трактуется как 0.
 */
export function pickValueWithPhase(
  subterm: PositionalSubtermInput,
  phase: number,
): number {
  const mg = subterm.value_mg ?? 0;
  const eg = subterm.value_eg ?? 0;
  return (mg * phase + eg * (256 - phase)) / 256;
}

// ─── Aggregation ────────────────────────────────────────────────────

/**
 * Результат сборки: семь блоков `metrics` и фаза, использованная при
 * расчёте (полезна для логов/диагностики и при дальнейшей tapered-обработке
 * других величин).
 */
export interface MetricsCommentBuildResult {
  metrics: Record<MetricsCommentBlockKey, { value_cp: number }>;
  phase: number;
}

/**
 * Опции сборки `metrics`. Либо FEN (тогда phase считается автоматически
 * через `computePhaseFromFen`), либо явная `phase` (для случаев, когда
 * вызывающая сторона уже её знает — например, после ручного override).
 * При наличии обеих величин приоритет у явной `phase`.
 */
export interface BuildMetricsOptions {
  fen?: string;
  phase?: number;
}

function buildIdToBlock(): Map<string, MetricsCommentBlockKey> {
  const out = new Map<string, MetricsCommentBlockKey>();
  for (const block of LLM_BLOCK_KEYS) {
    for (const id of METRIC_BLOCKS[block]) out.set(id, block);
  }
  return out;
}

const ID_TO_BLOCK = buildIdToBlock();

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

/**
 * Собирает `metrics` для тела запроса LLM по списку подкомпонент и
 * либо FEN, либо явной фазе. Алгоритм:
 *
 *  1. Phase = options.phase ?? computePhaseFromFen(options.fen!) — если
 *     ни fen, ни phase не переданы, бросает TypeError.
 *  2. Для каждой подкомпоненты:
 *     - id, не входящий ни в одну из 7 групп → пропускается;
 *     - tapered = pickValueWithPhase(subterm, phase);
 *     - sign = WHITE_SIGNED_IDS.has(id) ? +1
 *              : color === 'b' ? -1 : +1;
 *     - acc[block] += sign * tapered.
 *  3. Округление каждой суммы до 3 знаков (исключает шум double-арифметики
 *     при сборке тестов и диффе с реальным запросом).
 */
export function buildMetricsCommentRequest(
  subterms: readonly PositionalSubtermInput[],
  options: BuildMetricsOptions,
): MetricsCommentBuildResult {
  const phase =
    options.phase ??
    (options.fen !== undefined ? computePhaseFromFen(options.fen) : undefined);
  if (phase === undefined) {
    throw new TypeError(
      'buildMetricsCommentRequest: need either options.fen or options.phase',
    );
  }
  const acc: Record<MetricsCommentBlockKey, number> = {
    material: 0,
    pawn_structure: 0,
    king_safety: 0,
    pieces: 0,
    mobility: 0,
    threats: 0,
    passed_pawns: 0,
  };
  for (const s of subterms) {
    const block = ID_TO_BLOCK.get(s.id);
    if (!block) continue;
    const tapered = pickValueWithPhase(s, phase);
    const sign = WHITE_SIGNED_IDS.has(s.id)
      ? 1
      : s.color === 'b'
        ? -1
        : 1;
    acc[block] += sign * tapered;
  }
  const metrics = {} as Record<MetricsCommentBlockKey, { value_cp: number }>;
  for (const k of LLM_BLOCK_KEYS) {
    metrics[k] = { value_cp: round3(acc[k]) };
  }
  return { metrics, phase };
}
