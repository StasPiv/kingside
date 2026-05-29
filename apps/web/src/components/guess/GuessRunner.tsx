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
import { WdlChancesBar } from '../WdlChancesBar';
import {
  WasmEngineAdapter,
  type EngineAdapter,
  type AnalysisResult,
  type WdlDistribution,
} from '../../utils/engineAdapter';

/**
 * KS-3410 (ADR-086 §9, F1) — guess-the-move runner.
 * KS-3424 (UX): убраны стрелки реакции и кнопка «Дальше»; вердикт
 * сжат до «Лучше/Равно/Хуже» с автопереходом через короткую паузу.
 * Анализ позиции переведён на live `go infinite` со шкалой
 * `WdlChancesBar` (как в /precision, KS-3391/3394) — пользователь
 * видит, как W/D/L уточняются по мере роста глубины.
 *
 * Доска + авто-проигрывание ходов соперника из PGN; на полуходах ВЫБРАННОЙ
 * стороны пользователь вводит ход (drag/click). Клиентский анализ
 * (WASM Stockfish):
 *   - префетч на guess-полуходе: E_before (analyze fenBefore → wdlBefore +
 *     bestUci) и E_after_played (analyze позиции ПОСЛЕ реального хода —
 *     реальный ход известен заранее). Префетч даёт фиксированные WDL для
 *     `compareGuessMove` (S2);
 *   - после ввода: E_after_user (analyze позиции после хода юзера; только
 *     если userUci !== playedUci);
 *   - параллельно: `analyzeLive(displayFen, …)` стримит промежуточные
 *     WDL в `setLiveWdl` для шкалы — НЕ блокирует префетч (очередь
 *     `engineQueueRef` сериализует analyze и analyzeLive на одном
 *     worker'е; live запускается ПОСЛЕ префетча в фазе `awaitGuess` и
 *     останавливается `stop()` при смене фазы).
 *
 * Реакция считается `compareGuessMove` (S2, shared): вердикт
 * (strongest / betterThanPlayer / asPlayer / weaker) + класс хода + бейдж.
 *
 * Партия ВСЕГДА идёт по реальной линии: ход пользователя оценивается, но
 * на автопереходе применяется реально сыгранный ход (ADR-086 §2.2.4).
 *
 * WDL POV: `compareGuessMove` принимает RAW POV side-to-move каждой позиции
 * (fenBefore → выбранная сторона; fenAfter* → соперник) и сам инвертирует
 * after-позиции. Передаём как есть из движка. Шкала `WdlChancesBar`
 * показывает live-оценку текущей `displayFen` (POV side-to-move в этой
 * позиции) — на guess-полуходе это POV выбранной стороны, что и нужно.
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
  /**
   * KS-3424: пауза перед автопереходом в reaction-фазе, мс. Дефолт 1500 —
   * хватает увидеть вердикт. В тестах задаём 0, чтобы не зависеть от
   * fake-таймеров.
   */
  reactionHoldMs?: number;
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

export function GuessRunner({
  pgn,
  side,
  onGuess,
  onFinish,
  engineFactory,
  analyzeDepth = 16,
  analyzeMovetimeMs = 1200,
  reactionHoldMs = 1500,
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
  // KS-3424: live-WDL для шкалы. Сбрасываем в null при каждой смене
  // displayFen — рисуется нейтральная «loading»-полоса до первого
  // обновления от движка.
  const [liveWdl, setLiveWdl] = useState<WdlDistribution | null>(null);

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

  // KS-3424: live infinite — стримит WDL в шкалу. Сериализуется через
  // ту же `engineQueueRef`, чтобы не конкурировать с блокирующими
  // analyze (один worker, конкурентные `go` ломают движок). Возвращает
  // функцию stop: дёргает `engine.stop()` → bestmove → analyzeLive
  // resolves → очередь освобождается для следующего analyze.
  const startLiveAnalyze = useCallback(
    (fen: string): (() => void) => {
      const localGen = genRef.current;
      let stopped = false;
      const next = engineQueueRef.current.then(async () => {
        if (stopped || localGen !== genRef.current) return;
        const eng = await ensureEngine();
        await eng.analyzeLive(fen, 1, (info) => {
          if (localGen !== genRef.current) return;
          if (info.wdl) setLiveWdl(info.wdl);
        });
      });
      engineQueueRef.current = next.catch(() => undefined);
      return () => {
        stopped = true;
        try {
          engineRef.current?.stop();
        } catch {
          /* ignore */
        }
      };
    },
    [ensureEngine],
  );

  // ── Reset при смене PGN/стороны ────────────────────────────────────
  useEffect(() => {
    genRef.current += 1;
    prefetchRef.current = null;
    setPlyIndex(0);
    setComparison(null);
    setUserUci(null);
    setLastMoveUci(null);
    setLiveWdl(null);
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
    setLiveWdl(null);

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
        // KS-3424: фиксируем WDL_before как стартовое значение шкалы —
        // не дожидаемся первого live-info, чтобы не было «прыжка» от
        // пустоты к live-числу.
        setLiveWdl(preBest.wdl);
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

  // ── KS-3424: live infinite на displayFen в фазах awaitGuess/reaction.
  //    Стримит WDL в шкалу. Стоп через cleanup при смене фазы/fen.
  useEffect(() => {
    if (phase !== 'awaitGuess' && phase !== 'reaction') return;
    const stop = startLiveAnalyze(displayFen);
    return () => {
      stop();
    };
  }, [phase, displayFen, startLiveAnalyze]);

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

  // ── Автопереход после reaction (KS-3424: вместо кнопки «Дальше») ───
  const handleContinue = useCallback(() => {
    const cur = plies[plyIndex];
    if (!cur) return;
    setDisplayFen(cur.fenAfter);
    setLastMoveUci(cur.uci);
    prefetchRef.current = null;
    setComparison(null);
    setUserUci(null);
    setLiveWdl(null);
    setPhase('init');
    advance();
  }, [plies, plyIndex, advance]);

  useEffect(() => {
    if (phase !== 'reaction') return;
    const t = window.setTimeout(() => {
      handleContinue();
    }, Math.max(0, reactionHoldMs));
    return () => window.clearTimeout(t);
  }, [phase, handleContinue, reactionHoldMs]);

  const displayGame = useMemo(() => {
    try {
      return new Chess(displayFen);
    } catch {
      return new Chess();
    }
  }, [displayFen]);

  const boardEnabled = phase === 'awaitGuess';

  // KS-3424: короткий вердикт. strongest+betterThanPlayer → «Лучше»,
  // asPlayer → «Равно», weaker → «Хуже». Длинные фразы оставлены в
  // i18n под `guess.verdict.*` (M2 при необходимости — иконка/бейдж).
  const verdictShortText = (
    v: GuessMoveComparison['verdict'],
  ): { label: string; tone: 'better' | 'equal' | 'worse' } => {
    switch (v) {
      case 'strongest':
      case 'betterThanPlayer':
        return {
          label: t('guess.verdictShort.better', 'Better'),
          tone: 'better',
        };
      case 'asPlayer':
        return {
          label: t('guess.verdictShort.equal', 'Same'),
          tone: 'equal',
        };
      case 'weaker':
        return {
          label: t('guess.verdictShort.worse', 'Worse'),
          tone: 'worse',
        };
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
        /* KS-3424: стрелки реакции (твой/реальный/лучший) убраны — лишний
           визуальный шум; вердикт и шкала WDL дают достаточно сигнала. */
      />

      {/* KS-3424: live-шкала WDL под доской. POV = side-to-move в
          displayFen (на awaitGuess это выбранная сторона, что и нужно).
          Скрываем на autoplay/init — там осмысленного контекста для
          оценки нет (или анимация хода соперника). */}
      {(phase === 'prefetch' ||
        phase === 'awaitGuess' ||
        phase === 'analyzingUser' ||
        phase === 'reaction') && (
        <div
          className="guess-runner__wdl"
          data-testid="guess-runner-wdl-wrapper"
        >
          <WdlChancesBar
            wdl={liveWdl}
            testId="guess-runner-wdl"
          />
        </div>
      )}

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
        {phase === 'reaction' && comparison && (() => {
          const v = verdictShortText(comparison.verdict);
          return (
            <div
              className="guess-runner__reaction"
              data-testid="guess-runner-reaction"
            >
              <span
                className={`guess-runner__verdict-short guess-runner__verdict-short--${v.tone}`}
                data-testid="guess-runner-verdict-short"
                data-tone={v.tone}
              >
                {v.label}
              </span>
            </div>
          );
        })()}
        {phase === 'finished' && (
          <p data-testid="guess-runner-finished">
            {t('guess.finished', 'Game finished.')}
          </p>
        )}
      </div>
    </div>
  );
}
