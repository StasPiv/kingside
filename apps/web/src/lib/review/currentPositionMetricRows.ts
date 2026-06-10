/**
 * KS-4033. Чистая функция-агрегатор «строки таблицы метрик одной позиции».
 *
 * Получает на вход `PositionalSubterm[]` от `evalTrace(fen)` для одной
 * позиции и возвращает массив строк-метрик: на каждый `id` —
 * значения для белых, чёрных и разница, плюс «вес» для сортировки.
 *
 * Знаковая конвенция Stockfish (та же, что в KS-4017 / `debugPositionalDiff`):
 *  - У `psqt_*`, `material`, `imbalance` Stockfish выдаёт значения уже
 *    со знаком со стороны белых (у белых положительные, у чёрных
 *    отрицательные). В таблице правильно показывать сумму всех
 *    `value_*` по `id` — она и есть «преимущество белых».
 *  - У остальных подкомпонент (`pawn_*`, `mobility_*`, `threat_*`,
 *    `king_*`, и т.д.) значения идут со стороны владельца
 *    (положительные у обеих сторон). Правильная метрика — разница
 *    `white_sum − black_sum`.
 *
 * В этом модуле обе группы приводятся к единому виду «значение белых,
 * значение чёрных, разница». Для `WHITE_SIGNED_IDS`:
 *  - `white = sum положительных`;
 *  - `black = |sum отрицательных|`;
 *  - `diff = white − black` (для них совпадает с сырой суммой
 *    `value_mg` по id).
 * Для остальных — естественные суммы по `color`.
 *
 * `score` для сортировки = `|diff|` — модуль разницы. Самая весомая
 * метрика идёт первой.
 *
 * Tapered: тестируем по фазе `mg`/`eg`/`mix` (см. `MetricPhase`),
 * аналогично `aggregatePlySubterms`. По умолчанию `mix`.
 */
import type {
  PositionalSubterm,
  PositionalSubtermId,
} from '@kingside/shared';
import type { MetricPhase } from './positionalMetrics';

/**
 * Идентификаторы подкомпонент, для которых Stockfish выдаёт значения
 * уже со стороны белых. Совпадает с `WHITE_SIGNED_IDS` в
 * `dev/debugPositionalDiff.ts`. Дублируется здесь намеренно — модуль
 * `dev/*` помечен как dev-обвязка и не должен импортироваться
 * production-компонентами.
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

export interface CurrentPositionMetricRow {
  /** Идентификатор подкомпоненты Stockfish. */
  id: PositionalSubtermId | 'unknown';
  /** Значение со стороны белых (после tapered и нормализации знаков). */
  white: number;
  /** Значение со стороны чёрных (после tapered и нормализации знаков). */
  black: number;
  /** Разница Б − Ч. Положительная — преимущество белых. */
  diff: number;
  /** Модуль `diff` — «вес» метрики для сортировки. */
  score: number;
  /** Знаковая конвенция SF для этого id (для визуализации/тестов). */
  whiteSigned: boolean;
}

function pickValue(s: PositionalSubterm, phase: MetricPhase): number {
  if (phase === 'mg') return s.value_mg;
  if (phase === 'eg') return s.value_eg;
  return (s.value_mg + s.value_eg) / 2;
}

/**
 * Построить строки таблицы для текущей позиции.
 *
 * @param subterms Подкомпоненты Stockfish для одной позиции
 *                 (результат `evalTrace(fen)`).
 * @param phase    Фаза tapered eval. По умолчанию `mix`.
 */
export function buildCurrentPositionMetricRows(
  subterms: ReadonlyArray<PositionalSubterm>,
  phase: MetricPhase = 'mix',
): CurrentPositionMetricRow[] {
  // По каждому id собираем сырые суммы по сторонам (для не-белосторонних)
  // и сырую сумму всех значений (для белосторонних).
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
    if (typeof s.id !== 'string') continue;
    const v = pickValue(s, phase);
    if (!Number.isFinite(v)) continue;
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

  const rows: CurrentPositionMetricRow[] = [];
  for (const [id, b] of byId) {
    let white: number;
    let black: number;
    if (b.whiteSigned) {
      // Все положительные слагаемые — вклад белых, отрицательные — чёрных.
      // У psqt разбиение даёт корректное соотношение «у кого больше».
      // Считаем непосредственно из суммированного значения: знак суммы
      // — преимущество стороны. Для столбиков-таблицы делим симметрично:
      // если sum > 0 → white=sum, black=0; если sum < 0 → white=0,
      // black=|sum|. Это даёт ровно один столбик в режиме «Параллельно»
      // и корректный `diff` для режима «Разница».
      if (b.whiteSignedSum >= 0) {
        white = b.whiteSignedSum;
        black = 0;
      } else {
        white = 0;
        black = -b.whiteSignedSum;
      }
    } else {
      white = b.whiteOwner;
      black = b.blackOwner;
    }
    const diff = white - black;
    rows.push({
      id: id as PositionalSubtermId | 'unknown',
      white,
      black,
      diff,
      score: Math.abs(diff),
      whiteSigned: b.whiteSigned,
    });
  }

  // Сортировка по убыванию score. На равных — стабильно по id для
  // воспроизводимого порядка между перерендерами.
  rows.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  return rows;
}
