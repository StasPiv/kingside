/**
 * KS-4945 (ADR-165 §3). Адаптер промис-драйвера `ReviewEngines`
 * (`createDefaultEngines` из useGameReview — SF с UCI_ShowWDL + Maia) к
 * контракту оркестратора `PositionReviewEngines` (`buildReviewPlan`).
 *
 * Деградация `no_coi` (ADR §3.1/§7): без crossOriginIsolated Stockfish
 * (lite-wasm, SharedArrayBuffer) не стартует — при `sfEnabled=false`
 * `analyze` возвращает `null`, оркестратор переходит в Maia-only режим
 * (`degradedNoSf`), а панель показывает явное сообщение.
 */
import { Chess } from 'chess.js';
import { expectedScoreFromWdl, invertWdl, type Wdl } from '@kingside/shared';

import { uciToSan } from '../maia/uciToSan';
import type { EvalLine } from '../../hooks/useStockfish';
import type { ReviewEngines } from '../../hooks/useGameReview';
import type {
  PositionReviewEngines,
  PositionReviewEval,
} from './positionReview';

/** Крутизна сигмоиды cp→% в EvalBar (см. utils/chessFormat.evalToPercent). */
const EVAL_BAR_K = 0.004;

/**
 * KS-4950: строка оценки для EvalBar из WDL хода разбора — ВСЕГДА с точки
 * зрения белых. `wdlAfter` — POV сделавшего ход; приводим к POV белых по
 * цвету ходившего (`moverIsWhite`) и переводим expected-score в cp
 * обратной сигмоидой EvalBar. Строка отдаётся с `isBlackTurn=false` —
 * без повторной инверсии на стороне EvalBar (иначе оценка скачет по
 * чётности полухода).
 */
export function whiteEvalLineFromWdlAfter(
  wdlAfter: Wdl,
  moverIsWhite: boolean,
): EvalLine {
  const whiteWdl = moverIsWhite ? wdlAfter : invertWdl(wdlAfter);
  const eWhite = expectedScoreFromWdl(whiteWdl);
  const clamped = Math.min(0.995, Math.max(0.005, eWhite));
  const cp = Math.round(Math.log(clamped / (1 - clamped)) / EVAL_BAR_K);
  return { depth: 1, multipv: 1, score: { type: 'cp', value: cp }, pv: '' };
}

/**
 * true — Stockfish доступен (crossOriginIsolated + SharedArrayBuffer).
 * Иначе lite-сборка не загрузится (KS-3067) → Maia-only разбор.
 */
export function isStockfishAvailable(): boolean {
  return (
    typeof SharedArrayBuffer !== 'undefined' &&
    typeof crossOriginIsolated !== 'undefined' &&
    crossOriginIsolated === true
  );
}

export interface ReviewEnginesAdapterOptions {
  /** false → SF недоступен (no_coi), analyze всегда null (Maia-only). */
  sfEnabled?: boolean;
}

/** Пустой bestmove Stockfish (терминальная позиция). */
function isNoMove(uci: string): boolean {
  return !uci || uci === '(none)' || uci === '0000';
}

/**
 * Оборачивает `ReviewEngines` в `PositionReviewEngines`. Экземпляр
 * `engines` создаётся и терминируется вызывающим (панелью).
 */
export function createReviewEngines(
  engines: ReviewEngines,
  options: ReviewEnginesAdapterOptions = {},
): PositionReviewEngines {
  const sfEnabled = options.sfEnabled ?? true;

  return {
    async getMaiaPolicy(fen, elo) {
      const policy = await engines.predictMaia(fen, elo);
      return policy.byUci;
    },

    async analyze(fen, multiPv): Promise<PositionReviewEval | null> {
      if (!sfEnabled) return null;
      const r = await engines.analyzeSf(fen, multiPv, 0);
      const best = isNoMove(r.bestUci) ? null : r.bestUci;
      const fromWdlMap = Object.keys(r.wdlByMove ?? {});
      const multipv = best
        ? [best, ...fromWdlMap.filter((m) => m !== best)]
        : fromWdlMap;
      return { bestUci: best, wdl: r.wdlBefore, multipv };
    },

    applyMove(fen, uci) {
      if (uci.length < 4) return null;
      try {
        const chess = new Chess(fen);
        const move = chess.move({
          from: uci.slice(0, 2),
          to: uci.slice(2, 4),
          promotion: uci.length > 4 ? uci[4] : undefined,
        });
        if (!move) return null;
        return chess.fen();
      } catch {
        return null;
      }
    },

    toSan(fen, uci) {
      try {
        return uciToSan(fen, uci) || uci;
      } catch {
        return uci;
      }
    },
  };
}
