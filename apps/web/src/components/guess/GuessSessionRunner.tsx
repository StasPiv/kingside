import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  GuessSide,
  GuessGameSource,
  GuessMoveDto,
  FinishGuessSessionResponse,
} from '@kingside/shared';

import { GuessRunner, type GuessSubmission } from './GuessRunner';
import { GuessFinalScreen } from './GuessFinalScreen';
import { guessApi } from '../../api/guessApi';

/**
 * KS-3411 (ADR-086 §9, F2) — сессионная обёртка над GuessRunner (F1):
 * wiring start/move/finish + HUD геймификации + финал-экран.
 *
 * Server-trust (ADR-086 §8): клиент шлёт RAW WDL POV side-to-move (как
 * отдаёт движок), сервер сам пересчитывает accuracy/verdict/очки. HUD и
 * финал-экран ОТОБРАЖАЮТ серверные значения из ответов submit/finish —
 * локально ничего не считаем.
 *
 * Move-POST'ы сериализуем (promise-цепочка) и finish ждёт их завершения —
 * чтобы итоги учли последний ход.
 */

export interface GuessSessionRunnerProps {
  pgn: string;
  side: GuessSide;
  gameSource: GuessGameSource;
  gameRef?: string | null;
  engineFactory?: React.ComponentProps<typeof GuessRunner>['engineFactory'];
}

type Status = 'starting' | 'error' | 'playing' | 'finishing' | 'final';

export function GuessSessionRunner({
  pgn,
  side,
  gameSource,
  gameRef = null,
  engineFactory,
}: GuessSessionRunnerProps) {
  const { t } = useTranslation();

  const [status, setStatus] = useState<Status>('starting');
  const sessionIdRef = useRef<string | null>(null);
  // KS-3430: score передаём в GuessFinalScreen (итоги). HUD больше
  // не показывает Очки/Серию/Сильнее — заменено на две live-точности.
  const [score, setScore] = useState(0);
  // KS-3430: live-точности из ответа submitMove (KS-3429 backend).
  // null до первого хода — рисуем «—» вместо «0%», чтобы не выглядело
  // как реальная оценка с самой плохой стороны.
  const [userAccuracy, setUserAccuracy] = useState<number | null>(null);
  const [playerAccuracy, setPlayerAccuracy] = useState<number | null>(null);
  const [moves, setMoves] = useState<GuessMoveDto[]>([]);
  const [final, setFinal] = useState<FinishGuessSessionResponse | null>(null);

  // Цепочка move-POST'ов — finish дождётся её.
  const moveChainRef = useRef<Promise<unknown>>(Promise.resolve());
  const genRef = useRef(0);

  // ── Старт сессии ───────────────────────────────────────────────────
  useEffect(() => {
    const gen = ++genRef.current;
    setStatus('starting');
    sessionIdRef.current = null;
    setScore(0);
    setUserAccuracy(null);
    setPlayerAccuracy(null);
    setMoves([]);
    setFinal(null);
    moveChainRef.current = Promise.resolve();
    void (async () => {
      try {
        const res = await guessApi.startSession({
          gameSource,
          gameRef,
          pgn: gameSource === 'pgn' ? pgn : null,
          side,
        });
        if (gen !== genRef.current) return;
        sessionIdRef.current = res.session.id;
        setScore(res.session.score);
        setStatus('playing');
      } catch {
        if (gen !== genRef.current) return;
        setStatus('error');
      }
    })();
    return () => {
      genRef.current += 1;
    };
  }, [pgn, side, gameSource, gameRef]);

  // ── Submit одного guess-полухода (RAW WDL) ─────────────────────────
  const handleGuess = useCallback(
    (s: GuessSubmission) => {
      const sid = sessionIdRef.current;
      if (!sid) return;
      const gen = genRef.current;
      moveChainRef.current = moveChainRef.current.then(async () => {
        try {
          const res = await guessApi.submitMove(sid, {
            ply: s.ply,
            fenBefore: s.fenBefore,
            playedUci: s.playedUci,
            userUci: s.userUci,
            bestUci: s.bestUci,
            wdlBefore: s.wdlBefore,
            wdlAfterPlayed: s.wdlAfterPlayed,
            wdlAfterUser: s.wdlAfterUser ?? null,
          });
          if (gen !== genRef.current) return;
          // Server-trust: score (для финал-экрана) + live-точности
          // (KS-3430 HUD) — из серверного ответа. KS-3429: backend
          // отдаёт currentUserAccuracy/currentPlayerAccuracy в
          // SubmitGuessMoveResponse.
          setScore(res.score);
          setUserAccuracy(res.currentUserAccuracy);
          setPlayerAccuracy(res.currentPlayerAccuracy);
          setMoves((prev) => [...prev, res.move]);
        } catch {
          /* единичный сбой move не валит партию — продолжаем по реальной линии */
        }
      });
    },
    [],
  );

  // ── Финал: ждём очередь move-POST'ов, затем finish ─────────────────
  const handleFinish = useCallback(() => {
    const sid = sessionIdRef.current;
    if (!sid) {
      setStatus('final');
      return;
    }
    const gen = genRef.current;
    setStatus('finishing');
    void (async () => {
      await moveChainRef.current;
      try {
        const res = await guessApi.finishSession(sid);
        if (gen !== genRef.current) return;
        setFinal(res);
      } catch {
        /* finish упал — покажем финал по накопленным move-DTO без итогов */
      } finally {
        if (gen === genRef.current) setStatus('final');
      }
    })();
  }, []);

  if (status === 'starting') {
    return (
      <div className="guess-session" data-testid="guess-session" data-status="starting">
        <p data-testid="guess-session-starting">
          {t('guess.session.starting', 'Starting session…')}
        </p>
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="guess-session" data-testid="guess-session" data-status="error">
        <p data-testid="guess-session-error">
          {t('guess.session.error', 'Could not start the guess session. Please try again.')}
        </p>
      </div>
    );
  }

  if (status === 'final') {
    return (
      <div className="guess-session" data-testid="guess-session" data-status="final">
        <GuessFinalScreen
          side={side}
          moves={moves}
          finalResult={final}
          score={score}
        />
      </div>
    );
  }

  // playing | finishing — раннер + HUD.
  return (
    <div className="guess-session" data-testid="guess-session" data-status={status}>
      {/* KS-3430: HUD — две live-точности из серверных ответов
          submitMove (currentUserAccuracy / currentPlayerAccuracy,
          добавлены в KS-3429 backend). Заменили Очки/Серия/Сильнее
          партии — пользователь просил более информативную картинку
          (см. ADR-086 §9 follow-up). До первого хода — «—» вместо
          0%, чтобы не выглядело как реальная плохая оценка. Поля
          score/streak/betterCount всё ещё считаются сервером и
          используются на финал-экране — здесь просто не показываем. */}
      <div className="guess-session__hud" data-testid="guess-session-hud">
        <span
          className="guess-session__stat guess-session__stat--accuracy-user"
          data-testid="guess-hud-user-accuracy"
        >
          {t('guess.hud.userAccuracy', 'Your accuracy')}:{' '}
          {userAccuracy === null ? '—' : `${Math.round(userAccuracy)}%`}
        </span>
        <span
          className="guess-session__stat guess-session__stat--accuracy-player"
          data-testid="guess-hud-player-accuracy"
        >
          {t('guess.hud.playerAccuracy', 'Player accuracy')}:{' '}
          {playerAccuracy === null ? '—' : `${Math.round(playerAccuracy)}%`}
        </span>
      </div>
      <GuessRunner
        pgn={pgn}
        side={side}
        onGuess={handleGuess}
        onFinish={handleFinish}
        engineFactory={engineFactory}
      />
      {status === 'finishing' && (
        <p data-testid="guess-session-finishing">
          {t('guess.session.finishing', 'Tallying results…')}
        </p>
      )}
    </div>
  );
}
