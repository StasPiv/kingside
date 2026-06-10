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
import { Chess } from 'chess.js';
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

/**
 * KS-4033 follow-up. Собирает клетки, на которых Stockfish заполнил
 * `square` для подкомпонент с конкретным `id`. Используется для
 * подсветки доски при клике на строку метрики во вкладке «Метрики».
 *
 * Возвращает раздельные списки клеток по сторонам:
 *  - `white` — клетки от `color='w'` подкомпонент (с учётом знаковой
 *    конвенции SF: для `psqt_*`/`material`/`imbalance`, отсортированных
 *    как «сумма со стороны белых», вклад идёт от `color` Stockfish — это
 *    и есть владелец фигуры/пешки на клетке);
 *  - `black` — клетки от `color='b'`.
 *
 * Если для подкомпоненты `square` не заполнен (агрегаты вроде
 * `material`, `king_attackers_count` целиком — без привязки к клетке) —
 * она в результат не попадает; вызывающий код может отдельно сигнализировать
 * «у этой метрики нет конкретной клетки» (например, отсутствием подсветки).
 */
export interface MetricSquares {
  white: string[];
  black: string[];
}

export interface SquaresForMetricOptions {
  /**
   * KS-4038. FEN текущей позиции. Для метрик `pawn_*` (в первую очередь
   * `pawn_connected`) Stockfish выдаёт `square` только для пешек,
   * которым присуждён бонус — соседи цепочки, защищающие/защищаемые,
   * могут не иметь собственной записи. По FEN дополняем подсветку
   * всеми пешками той же стороны, реально входящими в связанную
   * группу (phalanx + supporter + supported).
   * Если `fen` не передан — поведение прежнее, без обогащения.
   */
  fen?: string | null;
}

export function squaresForMetric(
  subterms: ReadonlyArray<PositionalSubterm>,
  id: string,
  options: SquaresForMetricOptions = {},
): MetricSquares {
  const white: string[] = [];
  const black: string[] = [];
  for (const s of subterms) {
    if (s.id !== id) continue;
    if (typeof s.square !== 'string') continue;
    if (!/^[a-h][1-8]$/.test(s.square)) continue;
    if (s.color === 'b') {
      black.push(s.square);
    } else if (s.color === 'w') {
      white.push(s.square);
    }
  }
  // Дедуп — у Stockfish бывает несколько subterm-записей на одну клетку
  // (например, у пешки несколько штрафов одной id). В подсветке клетка
  // должна гореть один раз.
  let whiteSet = new Set(white);
  let blackSet = new Set(black);

  // KS-4038: для `pawn_connected` Stockfish помечает не каждую пешку
  // цепочки — пользователь жаловался, что подсвечена только h3, а
  // соседняя g2 (защищает h3 и сама в phalanx с f2) пропущена. По
  // определению pawn_connected (Stockfish wiki: pawn supported by or
  // forming a phalanx with another pawn of the same colour) добавляем
  // ВСЕ пешки той же стороны, реально связанные с уже отмеченными.
  // Источник — chess.js по `fen`, формальное правило соседства, без
  // эвристики.
  if (id === 'pawn_connected' && options.fen) {
    whiteSet = expandPawnConnected(whiteSet, options.fen, 'w');
    blackSet = expandPawnConnected(blackSet, options.fen, 'b');
  }

  return {
    white: Array.from(whiteSet).sort(),
    black: Array.from(blackSet).sort(),
  };
}

/**
 * KS-4038. Расширить набор клеток-пешек одной стороны до полной
 * связанной группы (transitive closure по правилу соседства).
 *
 * Правило «pawn_connected» (Stockfish):
 *  - phalanx — пешка той же стороны на той же горизонтали и соседнем файле;
 *  - supporter — пешка той же стороны на одну горизонталь сзади (с точки
 *    зрения движения пешки) на соседнем файле — она защищает текущую;
 *  - supported — пешка той же стороны на одну горизонталь впереди на
 *    соседнем файле — текущая защищает её.
 *
 * Итеративно добавляем соседей по этим правилам, пока набор растёт.
 * Максимум 8 итераций (пешек ≤ 8).
 */
function expandPawnConnected(
  seeds: ReadonlySet<string>,
  fen: string,
  color: 'w' | 'b',
): Set<string> {
  const out = new Set<string>(seeds);
  if (seeds.size === 0) return out;
  let chess: Chess;
  try {
    chess = new Chess(fen);
  } catch {
    // Невалидный FEN — возвращаем как есть, без расширения.
    return out;
  }
  // Соберём все клетки с пешкой нужного цвета.
  const pawnSquares = new Set<string>();
  for (let f = 0; f < 8; f++) {
    for (let r = 1; r <= 8; r++) {
      const sq = `${'abcdefgh'[f]}${r}`;
      const piece = chess.get(sq as Parameters<Chess['get']>[0]);
      if (piece && piece.type === 'p' && piece.color === color) {
        pawnSquares.add(sq);
      }
    }
  }
  // forward — направление «вперёд» с точки зрения цвета (для расчёта
  // supporter). Stockfish-определение connected: пешка connected, если
  // у неё есть friendly pawn на adjacent file на той же горизонтали
  // (phalanx) ИЛИ на горизонтали-1 (supporter). Defended-вперёд
  // (supported) НЕ делает текущую пешку connected — это статус
  // защищаемой, не защитника. Поэтому из seed расширяемся только в
  // сторону «назад» (supporter) и «вбок» (phalanx) — иначе цепочка
  // утечёт через защищаемые пешки на лишние клетки (например, e3 в
  // позиции со скриншота: f2 защищает e3, но e3 не входит в группу
  // f2-g2-h3 по определению connected).
  const forward = color === 'w' ? +1 : -1;
  const isNeighbour = (sqA: string, sqB: string): boolean => {
    const fa = sqA.charCodeAt(0);
    const fb = sqB.charCodeAt(0);
    if (Math.abs(fa - fb) !== 1) return false; // соседние файлы
    const ra = Number(sqA[1]);
    const rb = Number(sqB[1]);
    const dr = rb - ra;
    // phalanx (dr=0) или supporter (sqB на горизонталь сзади от sqA).
    return dr === 0 || dr === -forward;
  };
  // Итеративное расширение до фиксированной точки.
  for (let i = 0; i < 8; i++) {
    let added = false;
    for (const sq of pawnSquares) {
      if (out.has(sq)) continue;
      for (const seed of out) {
        if (isNeighbour(seed, sq)) {
          out.add(sq);
          added = true;
          break;
        }
      }
    }
    if (!added) break;
  }
  return out;
}
