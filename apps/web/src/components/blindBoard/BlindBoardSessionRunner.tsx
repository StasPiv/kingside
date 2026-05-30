/**
 * KS-3442 (ADR-088 §11 F1). Сессионная обёртка blind-board: старт
 * сессии → раунды → wrong-answer / dead-end → финал-экран.
 *
 * Раннер (`BlindBoardRunner`) отвечает только за пустую доску + клик +
 * промоушн; здесь склейка с API (`blindBoardApi`) и UI-фазы:
 *   - `starting` — POST /sessions, грузим первый ход.
 *   - `playing`  — раунды; submitAnswer → следующий ход / финал.
 *   - `awaiting` — ждём ответ от сервера на свой submitAnswer
 *     (доска заморожена через `disabled`).
 *   - `final`    — wrong-answer или dead-end; раскрытие позиции +
 *     bestStreak + кнопка «Играть ещё».
 *   - `error`    — startSession упал.
 *
 * Сохранение полной позиции на финал-экране сервер шлёт только при
 * wrong-answer / dead-end (анти-чит §5) — мы её просто отрисовываем
 * через FEN, собранный из `BlindBoardPiece[]`.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  BlindBoardMove,
  BlindBoardPieceType,
  BlindBoardSessionDto,
  BlindBoardSquare,
  SubmitBlindBoardAnswerResponse,
} from '@kingside/shared';

import { BlindBoardRunner } from './BlindBoardRunner';
import { BlindBoardFinalScreen } from './BlindBoardFinalScreen';
import { blindBoardApi } from '../../api/blindBoardApi';

type Status = 'starting' | 'playing' | 'awaiting' | 'final' | 'error';

export interface BlindBoardSessionRunnerProps {
  /** DI для тестов — позволяет подменить blindBoardApi на моки. */
  api?: typeof blindBoardApi;
  /** Колбэк «вернуться на лобби» — caller (landing) сбрасывает state. */
  onExit?: () => void;
}

export function BlindBoardSessionRunner({
  api = blindBoardApi,
  onExit,
}: BlindBoardSessionRunnerProps) {
  const { t } = useTranslation();

  const [status, setStatus] = useState<Status>('starting');
  const [session, setSession] = useState<BlindBoardSessionDto | null>(null);
  const [lastAnswer, setLastAnswer] =
    useState<SubmitBlindBoardAnswerResponse | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const genRef = useRef(0);

  // ── Старт сессии ───────────────────────────────────────────────────
  useEffect(() => {
    const gen = ++genRef.current;
    setStatus('starting');
    setSession(null);
    setLastAnswer(null);
    void (async () => {
      try {
        const res = await api.startSession();
        if (gen !== genRef.current) return;
        sessionIdRef.current = res.session.id;
        setSession(res.session);
        setStatus('playing');
      } catch {
        if (gen !== genRef.current) return;
        setStatus('error');
      }
    })();
    return () => {
      genRef.current += 1;
    };
  }, [api]);

  // ── Submit ответа ─────────────────────────────────────────────────
  const handleSubmit = useCallback(
    (answer: { square: BlindBoardSquare; pieceType: BlindBoardPieceType }) => {
      const sid = sessionIdRef.current;
      if (!sid || status !== 'playing') return;
      const gen = genRef.current;
      setStatus('awaiting');
      void (async () => {
        try {
          const res = await api.submitAnswer(sid, answer);
          if (gen !== genRef.current) return;
          setLastAnswer(res);
          setSession(res.session);
          if (res.session.status === 'finished') {
            setStatus('final');
          } else {
            // correct — следующий раунд, доска перерисуется новым move.
            setStatus('playing');
          }
        } catch {
          if (gen !== genRef.current) return;
          setStatus('error');
        }
      })();
    },
    [api, status],
  );

  const nextMove: BlindBoardMove | null = useMemo(() => {
    return session?.nextMove ?? null;
  }, [session]);

  if (status === 'starting') {
    return (
      <div
        className="blind-board-session"
        data-testid="blind-board-session"
        data-status="starting"
      >
        <p data-testid="blind-board-session-starting">
          {t('blindBoard.session.starting', 'Starting session…')}
        </p>
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div
        className="blind-board-session"
        data-testid="blind-board-session"
        data-status="error"
      >
        <p data-testid="blind-board-session-error">
          {t(
            'blindBoard.session.error',
            'Could not start the blind-board session. Please try again.',
          )}
        </p>
        {onExit && (
          <button
            type="button"
            className="blind-board-session__exit"
            data-testid="blind-board-session-exit"
            onClick={onExit}
          >
            {t('blindBoard.session.back', 'Back')}
          </button>
        )}
      </div>
    );
  }

  if (status === 'final' && session) {
    return (
      <div
        className="blind-board-session"
        data-testid="blind-board-session"
        data-status="final"
        data-finish-reason={session.finishReason ?? ''}
      >
        {/* KS-3443 (F2): полный финал-экран с лидербордом, личным
            рекордом и бейджем dead-end вынесен в отдельный компонент. */}
        <BlindBoardFinalScreen
          session={session}
          lastAnswer={lastAnswer}
          onPlayAgain={onExit}
          api={api}
        />
      </div>
    );
  }

  // playing | awaiting
  return (
    <div
      className="blind-board-session"
      data-testid="blind-board-session"
      data-status={status}
    >
      <div className="blind-board-session__hud" data-testid="blind-board-hud">
        <span data-testid="blind-board-hud-round">
          {t('blindBoard.hud.round', 'Round')}: {session?.round ?? 1}
        </span>
        <span data-testid="blind-board-hud-streak">
          {t('blindBoard.hud.streak', 'Streak')}: {session?.streak ?? 0}
        </span>
        <span data-testid="blind-board-hud-best">
          {t('blindBoard.hud.bestStreak', 'Best')}: {session?.bestStreak ?? 0}
        </span>
      </div>
      <BlindBoardRunner
        move={nextMove}
        onSubmit={handleSubmit}
        disabled={status === 'awaiting'}
      />
      {status === 'awaiting' && (
        <p
          className="blind-board-session__awaiting"
          data-testid="blind-board-session-awaiting"
        >
          {t('blindBoard.session.checking', 'Checking…')}
        </p>
      )}
    </div>
  );
}
