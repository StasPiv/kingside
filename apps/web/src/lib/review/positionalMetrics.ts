/**
 * KS-4024 / ADR-122 §4. Группировка позиционных подкомпонент SF по
 * восьми смысловым разделам — для UI-фильтра «MetricGroupCheckboxes»
 * и для агрегатора «один ряд графика на (id, color)».
 *
 * Идея: при просмотре партии пользователю не нужны все 40+ id одним
 * списком — это шум. Поэтому раскладываем в группы:
 *   1. Пешки (pawns_*)
 *   2. Защита короля (king_*)
 *   3. Лёгкие фигуры (knight_*, bishop_*, minor_*)
 *   4. Тяжёлые фигуры (rook_*, queen_*)
 *   5. Угрозы (threat_*)
 *   6. Проходные (passed_*)
 *   7. Пространство и аутпосты (space, outpost_*)
 *   8. Материал и баланс (material, imbalance)
 *
 * Подкомпоненты `psqt_*` намеренно скрыты из дефолтного UI — они
 * декомпозиция оценки без шахматной семантики (см. KS-4017 / ADR-107).
 * При желании дебагить — есть `window.__ksPositionalDiff()` (KS-4017).
 */

import type {
  PositionalSubterm,
  PositionalSubtermId,
} from '@kingside/shared';

export type MetricGroupKey =
  | 'pawns'
  | 'king-safety'
  | 'minor-pieces'
  | 'major-pieces'
  | 'threats'
  | 'passed'
  | 'space-outposts'
  | 'material';

export interface MetricGroupDescriptor {
  key: MetricGroupKey;
  /** KS-4633: i18n-ключ для подписи группы. */
  labelKey: string;
  /** KS-4633: английский fallback на случай отсутствующего ключа. */
  labelEn: string;
  /** Подкомпоненты, входящие в группу. */
  ids: ReadonlyArray<PositionalSubtermId>;
}

/**
 * KS-4633: `label` заменён на `labelKey` (ключ i18n). Источник перевода —
 * `analysis.metrics.groupLabel.<key>` в `i18n/locales/{en,ru}/translation.json`.
 * UI вытягивает строку через `t(group.labelKey, group.labelEn)` —
 * fallback английский.
 */
export const METRIC_GROUPS: ReadonlyArray<MetricGroupDescriptor> = [
  {
    key: 'pawns',
    labelKey: 'analysis.metrics.groupLabel.pawns',
    labelEn: 'Pawns',
    ids: [
      'pawn_doubled_early',
      'pawn_connected',
      'pawn_doubled',
      'pawn_isolated',
      'pawn_backward',
      'pawn_lever_double',
      'pawn_blocked',
    ],
  },
  {
    key: 'king-safety',
    labelKey: 'analysis.metrics.groupLabel.kingSafety',
    labelEn: 'King safety',
    ids: [
      'king_shelter_strength',
      'king_blocked_storm',
      'king_unblocked_storm',
      'king_on_file',
      'king_safety_pawn',
      'king_danger',
      'king_safe_check_rook',
      'king_safe_check_queen',
      'king_safe_check_bishop',
      'king_safe_check_knight',
      'king_pawnless_flank',
      'king_flank_attacks',
      'king_attackers_count',
      'king_attackers_weight',
    ],
  },
  {
    key: 'minor-pieces',
    labelKey: 'analysis.metrics.groupLabel.minorPieces',
    labelEn: 'Minor pieces',
    ids: [
      'knight_uncontested_outpost',
      'knight_reachable_outpost',
      'minor_behind_pawn',
      'knight_king_protector_distance',
      'bishop_king_protector_distance',
      'bishop_pawns',
      'bishop_xray_pawns',
      'bishop_long_diagonal',
      'bishop_cornered',
      'bishop_on_king_ring',
      'mobility_knight',
      'mobility_bishop',
    ],
  },
  {
    key: 'major-pieces',
    labelKey: 'analysis.metrics.groupLabel.majorPieces',
    labelEn: 'Major pieces',
    ids: [
      'rook_on_king_ring',
      'rook_on_open_file',
      'rook_on_closed_file',
      'rook_trapped',
      'queen_weak',
      'mobility_rook',
      'mobility_queen',
    ],
  },
  {
    key: 'threats',
    labelKey: 'analysis.metrics.groupLabel.threats',
    labelEn: 'Threats',
    ids: [
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
  },
  {
    key: 'passed',
    labelKey: 'analysis.metrics.groupLabel.passed',
    labelEn: 'Passed pawns',
    ids: [
      'passed_rank',
      'passed_king_proximity',
      'passed_path_advance',
      'passed_file_edge',
    ],
  },
  {
    key: 'space-outposts',
    labelKey: 'analysis.metrics.groupLabel.spaceOutposts',
    labelEn: 'Space and outposts',
    ids: ['space', 'outpost_knight', 'outpost_bishop'],
  },
  {
    key: 'material',
    labelKey: 'analysis.metrics.groupLabel.material',
    labelEn: 'Material and balance',
    ids: ['material', 'imbalance'],
  },
];

export type MetricPhase = 'mg' | 'eg' | 'mix';
export type MetricMode = 'by-side' | 'diff';

/**
 * Tapered eval (KS-3677, ADR-107): итоговое значение зависит от фазы.
 * `phase=0` — чистый эндшпиль, `phase=256` — миттельшпиль. `mix` =
 * линейная интерполяция. По умолчанию `mix=0.5`.
 */
function pickValue(s: PositionalSubterm, phase: MetricPhase): number {
  if (phase === 'mg') return s.value_mg;
  if (phase === 'eg') return s.value_eg;
  return (s.value_mg + s.value_eg) / 2;
}

/**
 * Агрегация subterms одного ply по парам (id, color) в одну точку
 * графика. Для каждого выбранного id — две точки (белые, чёрные) для
 * режима `by-side`, либо одна (разница) для режима `diff`.
 *
 * `ids` — фильтр: учитываются только подкомпоненты с этими id.
 */
export interface MetricSnapshot {
  /** Карта `id → значение белых` (после суммы и tapered). */
  white: Map<PositionalSubtermId | 'unknown', number>;
  black: Map<PositionalSubtermId | 'unknown', number>;
  /** Карта `id → разница Б−Ч`. */
  diff: Map<PositionalSubtermId | 'unknown', number>;
}

export function aggregatePlySubterms(
  subterms: ReadonlyArray<PositionalSubterm>,
  ids: ReadonlySet<string>,
  phase: MetricPhase,
): MetricSnapshot {
  const white = new Map<string, number>();
  const black = new Map<string, number>();
  const diff = new Map<string, number>();
  for (const s of subterms) {
    if (!ids.has(s.id)) continue;
    const v = pickValue(s, phase);
    const bucket = s.color === 'b' ? black : white;
    bucket.set(s.id, (bucket.get(s.id) ?? 0) + v);
  }
  const allIds = new Set<string>([...white.keys(), ...black.keys()]);
  for (const id of allIds) {
    diff.set(id, (white.get(id) ?? 0) - (black.get(id) ?? 0));
  }
  return {
    white: white as MetricSnapshot['white'],
    black: black as MetricSnapshot['black'],
    diff: diff as MetricSnapshot['diff'],
  };
}

/**
 * Серия для графика: id метрики + label + массив значений по ply.
 */
export interface MetricSeries {
  id: PositionalSubtermId | 'unknown';
  /** Цвет линии: w/b/diff (для UI). */
  variant: 'w' | 'b' | 'diff';
  label: string;
  /** Значение в позиции i-го ply; `null` если данных нет. */
  data: ReadonlyArray<number | null>;
}

/**
 * Преобразовать массив `PositionalTracePly` в массив серий для графика.
 *
 * `mode='by-side'` → две серии на id (w/b).
 * `mode='diff'` → одна серия на id (diff).
 */
export function buildMetricSeries(
  plies: ReadonlyArray<{ ply: number; subterms: ReadonlyArray<PositionalSubterm> }>,
  selectedIds: ReadonlySet<string>,
  mode: MetricMode,
  phase: MetricPhase,
): MetricSeries[] {
  if (plies.length === 0 || selectedIds.size === 0) return [];
  const snapshots = plies.map((p) =>
    aggregatePlySubterms(p.subterms, selectedIds, phase),
  );
  const idsArr = Array.from(selectedIds);
  const series: MetricSeries[] = [];
  for (const id of idsArr) {
    const typedId = id as PositionalSubtermId | 'unknown';
    if (mode === 'by-side') {
      series.push({
        id: typedId,
        variant: 'w',
        label: `${id} (Б)`,
        data: snapshots.map((s) => s.white.get(typedId) ?? null),
      });
      series.push({
        id: typedId,
        variant: 'b',
        label: `${id} (Ч)`,
        data: snapshots.map((s) => s.black.get(typedId) ?? null),
      });
    } else {
      series.push({
        id: typedId,
        variant: 'diff',
        label: `${id} (Б−Ч)`,
        data: snapshots.map((s) => s.diff.get(typedId) ?? null),
      });
    }
  }
  return series;
}
