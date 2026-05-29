import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Chess } from 'chess.js';
import {
  compareGuessMove,
  type GuessSide,
  type GuessMoveComparison,
  type Wdl,
} from '@kingside/shared';

import { PuzzleBoard } from '../PuzzleBoard';
import {
  WasmEngineAdapter,
  type EngineAdapter,
  type AnalysisResult,
} from '../../utils/engineAdapter';

/**
 * KS-3410 (ADR-086 §9, F1) — guess-the-move runner.
 *
 * Доска + авто-проигрывание ходов соперника из PGN; на полуходах ВЫБРАННОЙ
 * стороны пользователь вводит ход (drag/click). Клиентский live-анализ
 * (WASM Stockfish, тот же путь что PVE-runner — нужен WDL):
 *   - префетч на guess-полуходе: E_before (analyze fenBefore → wdlBefore +
 *     bestUci) и E_after_played (analyze позиции ПОСЛЕ реального хода —
 *     реальный ход известен заранее);
 *   - после ввода: E_after_user (analyze позиции после хода юзера; только
 *     если userUci !== playedUci).
 * Реакция считается `compareGuessMove` (S2, shared): вердикт
 * (strongest / betterThanPlayer / asPlayer / weaker) + класс хода + стрелки
 * (твой / реальный / лучший) + бейдж.
 *
 * Партия ВСЕГДА идёт по реальной линии: ход пользователя оценивается, но
 * на «Дальше» применяется реально сыгранный ход (ADR-086 §2.2.4).
 *
 * WDL POV: `compareGuessMove` принимает RAW POV side-to-move каждой позиции
 * (fenBefore → выбранная сторона; fenAfter* → соперник) и сам инвертирует
 * after-позиции. Передаём как есть из движка.
 */

export interface GuessPlyEvals {
  wdlBefore: Wdl;
  wdlAfterPlayed: Wdl;
  wdlAfterUser: Wdl | null;
  bestUci: string;
}

export interface GuessSubmission {
  ply: number;
  fenBefore: string;
  playedUci: string;
  userUci: string;
  bestUci: string;
  /** RAW POV side-to-move (как от движка). */
  wdlBefore: Wdl;
  wdlAfterPlayed: Wdl;
  wdlAfterUser: Wdl | null;
  comparison: GuessMoveComparison;
}

export interface GuessRunnerProps {
  /** PGN партии. */
  pgn: string;
  /** Сторона, ходы которой угадывает пользователь. */
  side: GuessSide;
  /** Колбэк на каждый оценённый guess-полуход (для F2 — submit на backend). */
  onGuess?: (submission: GuessSubmission) => void;
  /** Колбэк по завершении партии. */
  onFinish?: () => void;
  /** DI движка для тестов (по умолчанию — WASM Stockfish). */
  engineFactory?: () => EngineAdapter;
  analyzeDepth?: number;
  analyzeMovetimeMs?: number;
}

type Phase =
  | 'init'
  | 'autoplay'
  | 'prefetch'
  | 'awaitGuess'
  | 'analyzingUser'
  | 'reaction'
  | 'finished';

interface ParsedPly {
  ply: number; // 1-based полуход
  color: 'w' | 'b';
  uci: string;
  san: string;
  fenBefore: string;
  fenAfter: string;
}

const ARROW_USER = '#3b82f6'; // синий — твой ход
const ARROW_PLAYED = '#22c55e'; // зелёный — реально сыгранный
const ARROW_BEST = '#eab308'; // золотой — лучший по движку

function parsePgnToPlies(pgn: string): ParsedPly[] {
  const game = new Chess();
  game.loadPgn(pgn);
  const verbose = game.history({ verbose: true });
  return verbose.map((m, i) => ({
    ply: i + 1,
    color: m.color,
    uci: m.lan, // long algebraic = UCI (e2e4, e7e8q)
    san: m.san,
    fenBefore: m.before,
    fenAfter: m.after,
  }));
}

/** PV1 строка + извлечение wdl/bestUci из результата анализа. */
function pickBest(result: AnalysisResult) {
  if (!result.lines.length) return null;
  return [...result.lines].sort((a, b) => a.multipv - b.multipv)[0];
}

function uciToArrow(uci: string, color: string) {
  return {
    startSquare: uci.slice(0, 2),
    endSquare: uci.slice(2, 4),
    color,
  };
}

export function GuessRunner({
  pgn,
  side,
  onGuess,
  onFinish,
  engineFactory,
  analyzeDepth = 16,
  analyzeMovetimeMs = 1200,
}: GuessRunnerProps) {
  const { t } = useTranslation();
  const userColor: 'w' | 'b' = side === 'white' ? 'w' : 'b';

  const plies = useMemo(() => {
    try {
      return parsePgnToPlies(pgn);
    } catch {
      return [];
    }
  }, [pgn]);

  const [plyIndex, setPlyIndex] = useState(0);
  const [phase, setPhase] = useState<Phase>('init');
  const [displayFen, setDisplayFen] = useState<string>(
    () => plies[0]?.fenBefore ?? new Chess().fen(),
  );
  const [lastMoveUci, setLastMoveUci] = useState<string | null>(null);
  const [comparison, setComparison] = useState<GuessMoveComparison | null>(null);
  const [userUci, setUserUci] = useState<string | null>(null);

  // ── Engine (WASM, через ту же сериализованную очередь что PVE) ──────
  const engineRef = useRef<EngineAdapter | null>(null);
  const engineInitRef = useRef<Promise<EngineAdapter> | null>(null);
  const engineQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  // Префетч-замеры текущего guess-полухода.
  const prefetchRef = useRef<{
    fenBefore: string;
    playedUci: string;
    bestUci: string;
    wdlBefore: Wdl;
    wdlAfterPlayed: Wdl;
  } | null>(null);
  // Generation — отмена устаревших async при unmount/смене pgn.
  const genRef = useRef(0);

  const ensureEngine = useCallback((): Promise<EngineAdapter> => {
    if (engineRef.current) return Promise.resolve(engineRef.current);
    if (engineInitRef.current) return engineInitRef.current;
    const promise = (async () => {
      const eng = engineFactory ? engineFactory() : new WasmEngineAdapter();
      await eng.init();
      engineRef.current = eng;
      return eng;
    })();
    engineInitRef.current = promise;
    return promise;
  }, [engineFactory]);

  const queueAnalyze = useCallback(
    (fen: string): Promise<AnalysisResult> => {
      const next = engineQueueRef.current.then(async () => {
        const eng = await ensureEngine();
        return eng.analyze(fen, analyzeDepth, 1, analyzeMovetimeMs);
      });
      engineQueueRef.current = next.catch(() => undefined);
      return next;
    },
    [ensureEngine, analyzeDepth, analyzeMovetimeMs],
  );

  // ── Reset при смене PGN/стороны ────────────────────────────────────
  useEffect(() => {
    genRef.current += 1;
    prefetchRef.current = null;
    setPlyIndex(0);
    setComparison(null);
    setUserUci(null);
    setLastMoveUci(null);
    setDisplayFen(plies[0]?.fenBefore ?? new Chess().fen());
    setPhase(plies.length === 0 ? 'finished' : 'init');
  }, [plies, side]);

  // ── Cleanup движка при unmount ─────────────────────────────────────
  useEffect(() => {
    return () => {
      genRef.current += 1;
      try {
        engineRef.current?.destroy();
      } catch {
        /* ignore */
      }
      engineRef.current = null;
      engineInitRef.current = null;
    };
  }, []);

  const advance = useCallback(() => {
    setPlyIndex((i) => i + 1);
  }, []);

  // ── Оркестрация: реагируем на (plyIndex) в 'init'/'autoplay'/'continue' ─
  useEffect(() => {
    if (phase === 'finished' || phase === 'awaitGuess' || phase === 'reaction'
      || phase === 'analyzingUser' || phase === 'prefetch') {
      return;
    }
    // phase === 'init' либо после advance() (мы выставим phase ниже).
    if (plyIndex >= plies.length) {
      setPhase('finished');
      onFinish?.();
      return;
    }
    const cur = plies[plyIndex];
    setDisplayFen(cur.fenBefore);

    if (cur.color !== userColor) {
      // Ход соперника — авто-проигрываем по реальной линии.
      setPhase('autoplay');
      const gen = genRef.current;
      const timer = window.setTimeout(() => {
        if (gen !== genRef.current) return;
        setDisplayFen(cur.fenAfter);
        setLastMoveUci(cur.uci);
        // Дать анимации проиграться, затем следующий полуход.
        const timer2 = window.setTimeout(() => {
          if (gen !== genRef.current) return;
          setPhase('init');
          advance();
        }, 350);
        // cleanup второго таймера через ref не нужен — gen-guard защищает.
        void timer2;
      }, 250);
      return () => window.clearTimeout(timer);
    }

    // Guess-полуход выбранной стороны — префетч E_before + E_after_played.
    setPhase('prefetch');
    setLastMoveUci(null);
    setComparison(null);
    setUserUci(null);
    const gen = genRef.current;
    void (async () => {
      try {
        const pre = await queueAnalyze(cur.fenBefore);
        if (gen !== genRef.current) return;
        const preBest = pickBest(pre);
        const post = await queueAnalyze(cur.fenAfter);
        if (gen !== genRef.current) return;
        const postBest = pickBest(post);
        if (!preBest || !preBest.wdl || !postBest || !postBest.wdl) {
          // Без WDL сравнение невозможно — пропускаем (играем реальный ход).
          prefetchRef.current = null;
          setPhase('init');
          setDisplayFen(cur.fenAfter);
          setLastMoveUci(cur.uci);
          advance();
          return;
        }
        prefetchRef.current = {
          fenBefore: cur.fenBefore,
          playedUci: cur.uci,
          bestUci: preBest.pv[0] ?? cur.uci,
          wdlBefore: preBest.wdl,
          wdlAfterPlayed: postBest.wdl,
        };
        setPhase('awaitGuess');
      } catch {
        if (gen !== genRef.current) return;
        // Анализ упал — не блокируем партию, идём по реальной линии.
        prefetchRef.current = null;
        setPhase('init');
        setDisplayFen(cur.fenAfter);
        setLastMoveUci(cur.uci);
        advance();
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plyIndex, phase, plies, userColor]);

  // ── Ввод хода пользователем (drag/click) на guess-полуходе ──────────
  const onPieceDrop = useCallback(
    ({ sourceSquare, targetSquare }: { sourceSquare: string; targetSquare: string | null }) => {
      if (phase !== 'awaitGuess' || !targetSquare) return false;
      const pre = prefetchRef.current;
      if (!pre) return false;
      // Валидируем ход на fenBefore. Промоушн по умолчанию — ферзь (F1;
      // полноценный picker — отдельной задачей).
      let probedUci: string;
      try {
        const probe = new Chess(pre.fenBefore);
        const mv = probe.move({ from: sourceSquare, to: targetSquare, promotion: 'q' });
        if (!mv) return false;
        probedUci = mv.lan;
      } catch {
        return false;
      }
      const uUci = probedUci;
      setUserUci(uUci);
      setLastMoveUci(uUci);
      const gen = genRef.current;
      const sameMove = uUci === pre.playedUci;

      const finalize = (wdlAfterUser: Wdl | null) => {
        const cmp = compareGuessMove(pre.playedUci, uUci, {
          wdlBefore: pre.wdlBefore,
          wdlAfterPlayed: pre.wdlAfterPlayed,
          wdlAfterUser: sameMove ? null : wdlAfterUser,
          bestUci: pre.bestUci,
        });
        setComparison(cmp);
        setPhase('reaction');
        onGuess?.({
          ply: plies[plyIndex].ply,
          fenBefore: pre.fenBefore,
          playedUci: pre.playedUci,
          userUci: uUci,
          bestUci: pre.bestUci,
          wdlBefore: pre.wdlBefore,
          wdlAfterPlayed: pre.wdlAfterPlayed,
          wdlAfterUser: sameMove ? null : wdlAfterUser,
          comparison: cmp,
        });
      };

      if (sameMove) {
        // Ход совпал — E_after_user = E_after_played (второй анализ не нужен).
        finalize(null);
        return true;
      }

      // E_after_user: анализ позиции после хода юзера.
      setPhase('analyzingUser');
      void (async () => {
        try {
          const probe = new Chess(pre.fenBefore);
          probe.move({ from: sourceSquare, to: targetSquare, promotion: 'q' });
          const fenAfterUser = probe.fen();
          const r = await queueAnalyze(fenAfterUser);
          if (gen !== genRef.current) return;
          const best = pickBest(r);
          finalize(best?.wdl ?? null);
        } catch {
          if (gen !== genRef.current) return;
          finalize(null);
        }
      })();
      return true;
    },
    [phase, plies, plyIndex, queueAnalyze, onGuess],
  );

  // ── «Дальше»: применяем РЕАЛЬНЫЙ ход и идём к следующему полуходу ────
  const handleContinue = useCallback(() => {
    const cur = plies[plyIndex];
    if (!cur) return;
    setDisplayFen(cur.fenAfter);
    setLastMoveUci(cur.uci);
    prefetchRef.current = null;
    setComparison(null);
    setUserUci(null);
    setPhase('init');
    advance();
  }, [plies, plyIndex, advance]);

  // ── Стрелки реакции: твой / реальный / лучший ──────────────────────
  const arrows = useMemo(() => {
    if (phase !== 'reaction' || !comparison || !userUci) return undefined;
    const pre = prefetchRef.current;
    if (!pre) return undefined;
    const list = [];
    // Лучший (если не совпадает с реальным/твоим) — золотой, рисуем первым.
    if (pre.bestUci && pre.bestUci !== pre.playedUci && pre.bestUci !== userUci) {
      list.push(uciToArrow(pre.bestUci, ARROW_BEST));
    }
    // Реальный ход — зелёный.
    if (pre.playedUci !== userUci) {
      list.push(uciToArrow(pre.playedUci, ARROW_PLAYED));
    }
    // Твой ход — синий (поверх).
    list.push(uciToArrow(userUci, ARROW_USER));
    return list;
  }, [phase, comparison, userUci]);

  const displayGame = useMemo(() => {
    try {
      return new Chess(displayFen);
    } catch {
      return new Chess();
    }
  }, [displayFen]);

  const boardEnabled = phase === 'awaitGuess';

  const verdictText = (v: GuessMoveComparison['verdict']): string => {
    switch (v) {
      case 'strongest':
        return t('guess.verdict.strongest', 'You found the strongest move!');
      case 'betterThanPlayer':
        return t('guess.verdict.betterThanPlayer', 'Stronger than the game move!');
      case 'asPlayer':
        return t('guess.verdict.asPlayer', 'Same as the game move.');
      case 'weaker':
        return t('guess.verdict.weaker', 'Weaker than the game move.');
    }
  };

  return (
    <div
      className="guess-runner"
      data-testid="guess-runner"
      data-phase={phase}
      data-side={side}
      data-ply={plyIndex}
      data-verdict={comparison?.verdict ?? ''}
      data-user-class={comparison?.userClass ?? ''}
    >
      <PuzzleBoard
        game={displayGame}
        boardOrientation={side}
        enabled={boardEnabled}
        onPieceDrop={onPieceDrop}
        lastMoveUci={lastMoveUci}
        status={
          phase === 'prefetch' || phase === 'analyzingUser'
            ? 'checking'
            : phase === 'awaitGuess'
              ? 'thinking'
              : null
        }
        customArrows={arrows}
      />

      <div className="guess-runner__panel" data-testid="guess-runner-panel">
        {phase === 'init' && (
          <p data-testid="guess-runner-loading">
            {t('guess.loading', 'Loading engine…')}
          </p>
        )}
        {phase === 'autoplay' && (
          <p data-testid="guess-runner-opponent">
            {t('guess.opponentMove', 'Opponent is moving…')}
          </p>
        )}
        {phase === 'prefetch' && (
          <p data-testid="guess-runner-analyzing">
            {t('guess.analyzing', 'Analyzing position…')}
          </p>
        )}
        {phase === 'awaitGuess' && (
          <p data-testid="guess-runner-prompt">
            {t('guess.yourMove', 'Your move — guess what was played.')}
          </p>
        )}
        {phase === 'analyzingUser' && (
          <p data-testid="guess-runner-analyzing-user">
            {t('guess.analyzingMove', 'Checking your move…')}
          </p>
        )}
        {phase === 'reaction' && comparison && (
          <div className="guess-runner__reaction" data-testid="guess-runner-reaction">
            <span
              className={`guess-runner__badge guess-runner__badge--${comparison.userClass}`}
              data-testid="guess-runner-badge"
            >
              {t(`guess.class.${comparison.userClass}`, comparison.userClass)}
            </span>
            <p
              className={`guess-runner__verdict guess-runner__verdict--${comparison.verdict}`}
              data-testid="guess-runner-verdict"
            >
              {verdictText(comparison.verdict)}
            </p>
            <button
              type="button"
              className="play-btn"
              onClick={handleContinue}
              data-testid="guess-runner-continue"
            >
              {t('guess.continue', 'Continue →')}
            </button>
          </div>
        )}
        {phase === 'finished' && (
          <p data-testid="guess-runner-finished">
            {t('guess.finished', 'Game finished.')}
          </p>
        )}
      </div>
    </div>
  );
}
