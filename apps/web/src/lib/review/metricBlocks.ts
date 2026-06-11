/**
 * KS-4043. Группировка `PositionalSubterm` Stockfish 18 по «блокам» на
 * вкладке «Метрики» окна анализа.
 *
 * До KS-4043 вкладка показывала каждый id отдельной строкой —
 * пользователь видел десятки технических подкомпонент со схожей семантикой
 * (`pawn_connected`, `pawn_isolated`, …) и набором сырых индикаторов
 * (`king_safe_check_*`, `king_attackers_*`), которые не сопоставимы между
 * собой по шкале cp. Эта таблица переписана на агрегат-по-блоку:
 *   материал → пешечная структура → безопасность короля → фигуры →
 *   подвижность → угрозы → проходные.
 *
 * Подкомпоненты, не упомянутые ни в одном блоке (`king_attackers_*`,
 * `king_safe_check_*`, любые `psqt_*`), сознательно не входят в основную
 * вкладку — это либо служебные единицы шкалы, либо внутренняя
 * декомпозиция движка без шахматной семантики. См. описание задачи
 * KS-4043 и обсуждение KS-4041 по поводу `king_safe_check_*`.
 *
 * KS-4072. Состав 7 LLM-блоков берётся из `@kingside/shared`
 * (`METRIC_BLOCKS as SHARED_METRIC_BLOCKS`) — единый источник истины,
 * общий с backend (`POST /analyses/position/comment`). Здесь только
 * UI-обёртка: мэппинг snake_case-ключей LLM-контракта в kebab-case
 * UI-ключи + i18n-метки + 8-й блок `space`, который в LLM-payload не
 * уходит, но в UI-таблице нужен (KS-4043 follow-up).
 */
import {
  METRIC_BLOCKS as SHARED_METRIC_BLOCKS,
  type MetricsCommentBlockKey,
  type PositionalSubtermId,
} from '@kingside/shared';

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
 * Соответствие UI-ключа блока (kebab-case) ↔ ключа LLM-контракта
 * (snake_case, из `MetricsCommentBlockKey` в `@kingside/shared`).
 * 8-й блок `space` не имеет пары на стороне shared — он не уходит в
 * LLM, отображается только в UI.
 */
const UI_TO_LLM: Readonly<
  Record<Exclude<MetricBlockKey, 'space'>, MetricsCommentBlockKey>
> = {
  material: 'material',
  'pawn-structure': 'pawn_structure',
  'king-safety': 'king_safety',
  pieces: 'pieces',
  mobility: 'mobility',
  threats: 'threats',
  passed: 'passed_pawns',
};

/**
 * Порядок в массиве соответствует Gherkin требованию из KS-4043:
 * материал → структура → безопасность короля → фигуры → подвижность →
 * угрозы → проходные. Восьмой блок `space` — KS-4043 follow-up: после
 * запроса пользователя вернули отдельной строкой UI; в LLM-payload не
 * уходит. Сортировка по «весу» на UI не меняет этот порядок для
 * пустых/нулевых блоков, но активные блоки выводятся по убыванию
 * абсолютной разницы (см. UI-логику).
 */
export const METRIC_BLOCKS: ReadonlyArray<MetricBlockDescriptor> = [
  {
    key: 'material',
    i18nKey: 'analysis.metrics.block.material',
    ids: SHARED_METRIC_BLOCKS[UI_TO_LLM.material],
  },
  {
    key: 'pawn-structure',
    i18nKey: 'analysis.metrics.block.pawnStructure',
    ids: SHARED_METRIC_BLOCKS[UI_TO_LLM['pawn-structure']],
  },
  {
    key: 'king-safety',
    i18nKey: 'analysis.metrics.block.kingSafety',
    ids: SHARED_METRIC_BLOCKS[UI_TO_LLM['king-safety']],
  },
  {
    key: 'pieces',
    i18nKey: 'analysis.metrics.block.pieces',
    ids: SHARED_METRIC_BLOCKS[UI_TO_LLM.pieces],
  },
  {
    key: 'mobility',
    i18nKey: 'analysis.metrics.block.mobility',
    ids: SHARED_METRIC_BLOCKS[UI_TO_LLM.mobility],
  },
  {
    key: 'threats',
    i18nKey: 'analysis.metrics.block.threats',
    ids: SHARED_METRIC_BLOCKS[UI_TO_LLM.threats],
  },
  {
    key: 'passed',
    i18nKey: 'analysis.metrics.block.passed',
    ids: SHARED_METRIC_BLOCKS[UI_TO_LLM.passed],
  },
  {
    // KS-4043 follow-up: вернули `space` в основную таблицу отдельным
    // блоком по запросу пользователя. До этого подкомпонента
    // отбрасывалась как «почти всегда около 0, шум» — но в позициях
    // с явным территориальным перевесом она даёт сигнал. В LLM-payload
    // `space` не уходит — это UI-only блок.
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
