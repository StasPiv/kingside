/**
 * KS-4043. Группировка `PositionalSubterm` Stockfish 18 по 7 «блокам»
 * на вкладке «Метрики» окна анализа.
 *
 * До KS-4043 вкладка показывала каждый id отдельной строкой —
 * пользователь видел десятки технических подкомпонент со схожей семантикой
 * (`pawn_connected`, `pawn_isolated`, …) и набором сырых индикаторов
 * (`king_safe_check_*`, `king_attackers_*`), которые не сопоставимы между
 * собой по шкале cp. Эта таблица переписана на агрегат-по-блоку:
 *   материал → пешечная структура → безопасность короля → фигуры →
 *   подвижность → угрозы → проходные.
 *
 * Подкомпоненты, не упомянутые ни в одном блоке (например, `space`,
 * `king_attackers_count`/`weight`, `king_safe_check_*`, любые `psqt_*`),
 * сознательно не входят в основную вкладку — это либо служебные
 * единицы шкалы, либо внутренняя декомпозиция движка без шахматной
 * семантики. См. описание задачи KS-4043 и обсуждение KS-4041 по поводу
 * `king_safe_check_*`.
 */
import type { PositionalSubtermId } from '@kingside/shared';

export type MetricBlockKey =
  | 'material'
  | 'pawn-structure'
  | 'king-safety'
  | 'pieces'
  | 'mobility'
  | 'threats'
  | 'passed'
  | 'space';

export interface MetricBlockDescriptor {
  /** Стабильный машинный ключ для UI, i18n, data-testid и localStorage. */
  key: MetricBlockKey;
  /**
   * Идентификаторы подкомпонент Stockfish, входящих в этот блок.
   * Порядок внутри блока не критичен (используется только для
   * подсветки клеток и режима «Подробности»).
   */
  ids: ReadonlyArray<PositionalSubtermId | 'unknown'>;
  /**
   * i18n-ключ для названия блока (используется и в основной строке, и
   * в поповере). Пустого fallback в коде нет — словари en/ru должны
   * содержать ключ. Отдельная задача по локализации более длинных
   * подписей — следующая итерация.
   */
  i18nKey: string;
}

/**
 * Порядок в массиве соответствует Gherkin требованию из KS-4043:
 * материал → структура → безопасность короля → фигуры → подвижность →
 * угрозы → проходные. Сортировка по «весу» на UI не меняет этот порядок
 * для пустых/нулевых блоков, но активные блоки выводятся по убыванию
 * абсолютной разницы (см. UI-логику).
 */
export const METRIC_BLOCKS: ReadonlyArray<MetricBlockDescriptor> = [
  {
    key: 'material',
    i18nKey: 'analysis.metrics.block.material',
    ids: ['material', 'imbalance'],
  },
  {
    key: 'pawn-structure',
    i18nKey: 'analysis.metrics.block.pawnStructure',
    ids: [
      'pawn_connected',
      'pawn_isolated',
      'pawn_doubled',
      'pawn_backward',
      'pawn_lever_double',
      'pawn_blocked',
      'pawn_doubled_early',
    ],
  },
  {
    key: 'king-safety',
    i18nKey: 'analysis.metrics.block.kingSafety',
    ids: [
      'king_danger',
      'king_safety_pawn',
      'king_shelter_strength',
      'king_blocked_storm',
      'king_unblocked_storm',
      'king_on_file',
      'king_pawnless_flank',
      'king_flank_attacks',
    ],
  },
  {
    key: 'pieces',
    i18nKey: 'analysis.metrics.block.pieces',
    ids: [
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
  },
  {
    key: 'mobility',
    i18nKey: 'analysis.metrics.block.mobility',
    ids: [
      'mobility_knight',
      'mobility_bishop',
      'mobility_rook',
      'mobility_queen',
    ],
  },
  {
    key: 'threats',
    i18nKey: 'analysis.metrics.block.threats',
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
    i18nKey: 'analysis.metrics.block.passed',
    ids: [
      'passed_rank',
      'passed_king_proximity',
      'passed_path_advance',
      'passed_file_edge',
    ],
  },
  {
    // KS-4043 follow-up: вернули `space` в основную таблицу отдельным
    // блоком по запросу пользователя. До этого подкомпонента
    // отбрасывалась как «почти всегда около 0, шум» — но в позициях
    // с явным территориальным перевесом она даёт сигнал.
    key: 'space',
    i18nKey: 'analysis.metrics.block.space',
    ids: ['space'],
  },
];

/**
 * Карта `id → key` для быстрого роутинга подкомпоненты в её блок.
 * Подкомпонента, отсутствующая в карте, в основную вкладку не попадает.
 */
export const METRIC_ID_TO_BLOCK: ReadonlyMap<string, MetricBlockKey> = (() => {
  const map = new Map<string, MetricBlockKey>();
  for (const block of METRIC_BLOCKS) {
    for (const id of block.ids) {
      map.set(id, block.key);
    }
  }
  return map;
})();
