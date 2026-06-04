/**
 * KS-3682 / KS-3687. Утилиты для проверки stockfish-16-trace и LLM-
 * комментариев из консоли браузера, независимо от полного разбора партии.
 *
 *   await window.__sfTrace()         // массив PositionalSubterm[] для
 *                                    // текущей позиции на странице анализа
 *   await window.__sfTrace('<fen>')  // произвольная позиция
 *
 *   await window.__sfReviewProbe()         // собрать факт по текущему FEN
 *                                          // и отправить POST /analyses/
 *                                          // review/comments одним
 *                                          // элементом — то же, что делает
 *                                          // useGameReview на одном ходе.
 *   await window.__sfReviewProbe('<fen>')  // произвольная позиция
 *
 * Текущий FEN со страницы анализа выставляется в `window.__sfTraceFen`
 * из AnalysisPage (useEffect на смену позиции).
 */
import { evalTrace } from '../stockfishTrace';
import { batchReviewComment } from '../../../api/reviewComment';
import type { FactsInput } from '../extractFacts';
import type { PositionalSubterm } from '@kingside/shared';

interface ReviewProbeResult {
  fen: string;
  subterms: PositionalSubterm[];
  comment: string;
  rawComments: string[];
}

declare global {
  interface Window {
    __sfTrace?: (fen?: string) => Promise<PositionalSubterm[]>;
    __sfReviewProbe?: (
      fen?: string,
      opts?: { userElo?: number; userLanguage?: 'en' | 'ru' },
    ) => Promise<ReviewProbeResult>;
    __sfTraceFen?: string;
  }
}

function sideFromFen(fen: string): 'white' | 'black' {
  const parts = fen.split(' ');
  return parts[1] === 'b' ? 'black' : 'white';
}

/**
 * KS-3687. Минимальный валидный FactsInput для отправки на бэкенд с
 * единственной нагрузкой `positional_subterms`. Поля, которые в обычном
 * разборе заполняются движком SF/Maia/детекторами, выставлены в
 * нейтральные значения, чтобы LLM-комментатор работал — он использует
 * `classification='good'` как «по сути нечего сказать», и реагирует на
 * `positional_subterms`/`material_balance`/`stage`.
 */
function buildProbeFact(
  fen: string,
  subterms: PositionalSubterm[],
  userElo: number,
  userLanguage: 'en' | 'ru',
): FactsInput {
  const side = sideFromFen(fen);
  // Псевдо-ход — не используется LLM (classification='good' + sf_best=null
  // означают «пользователь не делал заметного хода», на бэке в подсказке
  // идёт только то, что есть). Все поля FactsMove заполнены нейтрально,
  // чтобы DTO-валидатор бэкенда (class-validator) пропустил факт.
  const dummyMove: FactsInput['move'] = {
    uci: 'e2e4',
    san: 'e4',
    capture: null,
    check: false,
    mate: null,
    castling: null,
    promotion: null,
    en_passant: false,
  };
  return {
    ply: 1,
    fen,
    fen_after: fen,
    side,
    move: dummyMove,
    classification: 'good',
    delta_e: 0,
    sf_best: null,
    maia_alternative: null,
    stage: 'middlegame',
    opening_name: null,
    material_balance: 0,
    material_change: null,
    hanging_piece: null,
    mate_threat_after: null,
    tactical_motifs: [],
    threats_created: {},
    threats_missed: {},
    positional_shifts: [],
    positional_subterms: subterms,
    user_elo: userElo,
    user_language: userLanguage,
  };
}

if (typeof window !== 'undefined') {
  window.__sfTrace = (fen?: string) => {
    const target = fen ?? window.__sfTraceFen;
    if (!target) {
      return Promise.reject(
        new Error(
          'window.__sfTraceFen не выставлен (открой страницу анализа) или передай fen явно: window.__sfTrace("<fen>")',
        ),
      );
    }
    return evalTrace(target);
  };

  window.__sfReviewProbe = async (
    fen?: string,
    opts?: { userElo?: number; userLanguage?: 'en' | 'ru' },
  ): Promise<ReviewProbeResult> => {
    const target = fen ?? window.__sfTraceFen;
    if (!target) {
      throw new Error(
        'window.__sfTraceFen не выставлен (открой страницу анализа) или передай fen явно: window.__sfReviewProbe("<fen>")',
      );
    }
    const userElo = opts?.userElo ?? 1500;
    const userLanguage = opts?.userLanguage ?? 'ru';

    // eslint-disable-next-line no-console
    console.info(`[sfReviewProbe] eval trace for ${target}…`);
    const subterms = await evalTrace(target);
    // eslint-disable-next-line no-console
    console.info(
      `[sfReviewProbe] got ${subterms.length} subterms; building fact and POST /analyses/review/comments`,
    );

    const fact = buildProbeFact(target, subterms, userElo, userLanguage);
    const rawComments = await batchReviewComment(
      [fact],
      userElo,
      userLanguage,
      undefined,
    );
    const comment = (rawComments[0] ?? '').trim();
    // eslint-disable-next-line no-console
    console.info(
      `[sfReviewProbe] comment (${comment.length} chars):`,
      comment || '(empty)',
    );

    return { fen: target, subterms, comment, rawComments };
  };

  // eslint-disable-next-line no-console
  console.info(
    '[sfTraceConsole] готово: window.__sfTrace(fen?) и window.__sfReviewProbe(fen?, { userElo?, userLanguage? })',
  );
}
