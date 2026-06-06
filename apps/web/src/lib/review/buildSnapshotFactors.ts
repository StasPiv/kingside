/**
 * KS-3712. Сборка `factors` для одного снимка позиции (`before` или
 * `after`) в теле POST `/analyses/review/move-comment`.
 *
 * Формат идентичен `position-comment` (одиночная оценка позиции):
 *   factors = [
 *     ...positionalSubterms,           // подкомпоненты от stockfish-16-trace
 *     { id: 'sf18_eval', score, ... }, // оценка позиции от SF 18
 *     { id: 'sf18_pv',   pv, ... },    // первая линия от SF 18 (UCI)
 *   ]
 *
 * Знак `score` нормализуется со стороны белых для обоих типов (`cp`
 * и `mate`), как в `useAiPositionComment` (KS-3702):
 *   value(white-pov) = sideToMove === 'b' ? -value(stm) : value(stm)
 *
 * Логика инверсии совпадает с `formatEval`/`evalToPercent` в
 * `chessFormat.ts` — той, что рисует число в `EvalBar`. Если число
 * относится к другой позиции (рассинхрон FEN), caller не должен звать
 * эту функцию — это его ответственность.
 *
 * KS-3815 (ADR-114 §3). Опциональный пре-фильтр позиционных
 * подкомпонент: под feature-flag отбрасываем «шумные» subterms
 * (обе |value_mg|, |value_eg| < `minAbs`) и оставляем top-N
 * по `max(|value_mg|, |value_eg|)`. Hard-include список id игнорирует
 * фильтр — такие subterms всегда едут в payload. Цель — снизить
 * объём запроса к LLM, не теряя важные сигналы. При выключенном
 * флаге поведение прежнее, тесты остаются зелёными.
 */
import type { PositionalSubterm, PositionalSubtermId } from '@kingside/shared';

import type {
  MoveCommentFactor,
  MoveCommentSnapshot,
} from '../../api/moveComment';

export interface SnapshotEngineLine {
  /** SF top-1 score POV ходящей стороны на `fen` (cp или mate). */
  score: { type: 'cp' | 'mate'; value: number } | null;
  /** Глубина info-строки (информационное поле). */
  depth: number;
  /** UCI-список ходов первой линии. */
  pv: string[];
}

export interface BuildSnapshotFactorsInput {
  fen: string;
  subterms: PositionalSubterm[];
  engine: SnapshotEngineLine | null;
}

/**
 * KS-3815: настройки пре-фильтра позиционных подкомпонент. Все поля
 * опциональны; отсутствующие значения берутся из дефолтов или из env
 * (`VITE_AI_SUBTERM_PREFILTER_*`). `enabled=false` отключает фильтр
 * (поведение до KS-3815).
 */
export interface SubtermPrefilterOptions {
  /** Включить пре-фильтр. Дефолт — `VITE_AI_SUBTERM_PREFILTER === '1'`. */
  enabled?: boolean;
  /** Максимальное количество soft-subterms в выдаче. По умолчанию 8. */
  topN?: number;
  /**
   * Порог «шумных» subterms: запись отбрасывается, если оба
   * `|value_mg|` и `|value_eg|` строго меньше `minAbs`. По умолчанию 0.1.
   */
  minAbs?: number;
  /**
   * Id подкомпонент, которые нельзя отбрасывать и которые не
   * расходуют топ-N бюджет — едут как hard-include. Пусто по
   * умолчанию: список hard-include id из ADR-114 §3 (sf18_eval,
   * hanging_piece, mate_threat_after, threats_*, material_change,
   * sf_best.square, tactical_motifs) относится к factors-уровню за
   * пределами `PositionalSubterm`. Дополнительные позиционные
   * подкомпоненты, которые нужно сохранять, добавляются через этот
   * параметр.
   */
  hardIncludeIds?: ReadonlyArray<PositionalSubtermId>;
}

export interface BuildSnapshotFactorsOptions {
  prefilter?: SubtermPrefilterOptions;
}

const DEFAULT_TOP_N = 8;
const DEFAULT_MIN_ABS = 0.1;

/**
 * Достаём дефолты пре-фильтра из env. Vite пробрасывает `VITE_*`
 * переменные в `import.meta.env` на этапе сборки.
 */
function readEnvDefaults(): Required<
  Pick<SubtermPrefilterOptions, 'enabled' | 'topN' | 'minAbs'>
> {
  const env =
    typeof import.meta !== 'undefined' &&
    (import.meta as unknown as { env?: Record<string, string | undefined> })
      .env;
  const raw = env || {};
  const enabled = raw.VITE_AI_SUBTERM_PREFILTER === '1';
  const topNRaw = Number(raw.VITE_AI_SUBTERM_PREFILTER_TOP_N);
  const minAbsRaw = Number(raw.VITE_AI_SUBTERM_PREFILTER_MIN_ABS);
  return {
    enabled,
    topN:
      Number.isFinite(topNRaw) && topNRaw > 0 ? Math.floor(topNRaw) : DEFAULT_TOP_N,
    minAbs:
      Number.isFinite(minAbsRaw) && minAbsRaw >= 0 ? minAbsRaw : DEFAULT_MIN_ABS,
  };
}

function sideToMoveFromFen(fen: string): 'w' | 'b' {
  return fen.split(/\s+/)[1] === 'b' ? 'b' : 'w';
}

/**
 * KS-3815: применяет пре-фильтр к массиву подкомпонент. Hard-include
 * id идут как есть; остальные сортируются по убыванию
 * `max(|value_mg|, |value_eg|)`, отбрасываются «шумные» (обе |value|
 * меньше `minAbs`) и обрезаются по `topN`.
 */
function applySubtermPrefilter(
  subterms: PositionalSubterm[],
  options: Required<
    Pick<SubtermPrefilterOptions, 'topN' | 'minAbs'>
  > & { hardIncludeIds: ReadonlySet<string> },
): PositionalSubterm[] {
  const hard: PositionalSubterm[] = [];
  const soft: PositionalSubterm[] = [];
  for (const s of subterms) {
    if (options.hardIncludeIds.has(s.id)) {
      hard.push(s);
    } else {
      soft.push(s);
    }
  }
  const filtered = soft.filter((s) => {
    const mg = Math.abs(s.value_mg);
    const eg = Math.abs(s.value_eg);
    return mg >= options.minAbs || eg >= options.minAbs;
  });
  filtered.sort((a, b) => {
    const ma = Math.max(Math.abs(a.value_mg), Math.abs(a.value_eg));
    const mb = Math.max(Math.abs(b.value_mg), Math.abs(b.value_eg));
    return mb - ma;
  });
  return [...hard, ...filtered.slice(0, options.topN)];
}

/**
 * Собирает массив `factors` для одного снимка позиции и оборачивает
 * его в `MoveCommentSnapshot` (`fen` + `factors`).
 */
export function buildSnapshotFactors(
  input: BuildSnapshotFactorsInput,
  options?: BuildSnapshotFactorsOptions,
): MoveCommentSnapshot {
  const envDefaults = readEnvDefaults();
  const prefilter = options?.prefilter ?? {};
  const enabled = prefilter.enabled ?? envDefaults.enabled;
  const topN = prefilter.topN ?? envDefaults.topN;
  const minAbs = prefilter.minAbs ?? envDefaults.minAbs;
  const hardIncludeIds = new Set<string>(prefilter.hardIncludeIds ?? []);

  const subterms = enabled
    ? applySubtermPrefilter(input.subterms, { topN, minAbs, hardIncludeIds })
    : input.subterms;

  const factors: MoveCommentFactor[] = [...subterms];
  const sideToMove = sideToMoveFromFen(input.fen);
  const engine = input.engine;

  if (engine && engine.score && Number.isFinite(engine.score.value)) {
    const normalizedScore = {
      type: engine.score.type,
      value:
        sideToMove === 'b' ? -engine.score.value : engine.score.value,
    };
    factors.push({
      id: 'sf18_eval',
      engine: 'stockfish-18',
      depth: engine.depth,
      multipv: 1,
      score: normalizedScore,
      side_to_move: sideToMove,
    });
    if (engine.pv && engine.pv.length > 0) {
      factors.push({
        id: 'sf18_pv',
        engine: 'stockfish-18',
        depth: engine.depth,
        multipv: 1,
        pv: engine.pv,
      });
    }
  }

  return { fen: input.fen, factors };
}
