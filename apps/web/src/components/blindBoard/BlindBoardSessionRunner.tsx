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
  BlindBoardPiece,
  BlindBoardPieceType,
  BlindBoardSessionDto,
  BlindBoardSquare,
  SubmitBlindBoardAnswerResponse,
} from '@kingside/shared';

import { BlindBoardRunner } from './BlindBoardRunner';
import { MemoChessboard } from '../MemoChessboard';
import { blindBoardApi } from '../../api/blindBoardApi';

type Status = 'starting' | 'playing' | 'awaiting' | 'final' | 'error';

export interface BlindBoardSessionRunnerProps {
  /** DI для тестов — позволяет подменить blindBoardApi на моки. */
  api?: typeof blindBoardApi;
  /** Колбэк «вернуться на лобби» — caller (landing) сбрасывает state. */
  onExit?: () => void;
}

const EMPTY_FEN = '8/8/8/8/8/8/8/8 w - - 0 1';

/** Собрать FEN из набора фигур (только белые — цвет в M1 не важен,
 *  фон один; используем upper-case для всех). */
function piecesToFen(pieces: BlindBoardPiece[]): string {
  if (pieces.length === 0) return EMPTY_FEN;
  // 8x8 grid, индексация: row=8..1 (top to bottom), col=a..h
  const grid: string[][] = Array.from({ length: 8 }, () =>
    Array.from({ length: 8 }, () => ''),
  );
  for (const p of pieces) {
    const file = p.square.charCodeAt(0) - 'a'.charCodeAt(0); // 0..7
    const rank = parseInt(p.square[1], 10) - 1; // 0..7
    const row = 7 - rank; // 0 — топ
    grid[row][file] = p.type; // 'Q'/'R'/'B'/'N'
  }
  const rows = grid.map((row) => {
    let s = '';
    let empty = 0;
    for (const cell of row) {
      if (cell === '') {
        empty += 1;
      } else {
        if (empty > 0) {
          s += String(empty);
          empty = 0;
        }
        s += cell;
      }
    }
    if (empty > 0) s += String(empty);
    return s;
  });
  return `${rows.join('/')} w - - 0 1`;
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

  const finalFen = useMemo(() => {
    if (!lastAnswer?.revealedPosition) return EMPTY_FEN;
    return piecesToFen(lastAnswer.revealedPosition);
  }, [lastAnswer]);

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
    const reason = session.finishReason;
    const reasonText =
      reason === 'wrong-answer'
        ? t('blindBoard.final.wrongAnswer', 'Wrong answer — game over.')
        : reason === 'dead-end'
          ? t(
              'blindBoard.final.deadEnd',
              'Dead end — no more legal moves for the target piece. You drove the computer into a corner!',
            )
          : t('blindBoard.final.abandoned', 'Session finished.');
    return (
      <div
        className="blind-board-session"
        data-testid="blind-board-session"
        data-status="final"
        data-finish-reason={reason ?? ''}
      >
        <div
          className="blind-board-session__final"
          data-testid="blind-board-final"
        >
          <h2 data-testid="blind-board-final-title">
            {t('blindBoard.final.title', 'Game finished')}
          </h2>
          <p
            className="blind-board-session__final-reason"
            data-testid="blind-board-final-reason"
          >
            {reasonText}
          </p>
          <div
            className="blind-board-session__final-board"
            data-testid="blind-board-final-board"
          >
            <MemoChessboard
              options={{
                position: finalFen,
                boardOrientation: 'white',
                allowDragging: false,
                showNotation: true,
                animationDurationInMs: 0,
              }}
            />
          </div>
          {lastAnswer?.expectedSquare && lastAnswer.expectedPieceType && (
            <p
              className="blind-board-session__final-expected"
              data-testid="blind-board-final-expected"
            >
              {t('blindBoard.final.expected', 'Expected')}:{' '}
              <strong>
                {lastAnswer.expectedPieceType}
                {lastAnswer.expectedSquare}
              </strong>
            </p>
          )}
          <div
            className="blind-board-session__final-stats"
            data-testid="blind-board-final-stats"
          >
            <span data-testid="blind-board-final-streak">
              {t('blindBoard.final.streak', 'Streak')}: {session.streak}
            </span>
            <span data-testid="blind-board-final-best">
              {t('blindBoard.final.bestStreak', 'Best streak')}:{' '}
              {session.bestStreak}
            </span>
          </div>
          {onExit && (
            <button
              type="button"
              className="blind-board-session__final-again"
              data-testid="blind-board-final-again"
              onClick={onExit}
            >
              {t('blindBoard.final.playAgain', 'Play again')}
            </button>
          )}
        </div>
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
