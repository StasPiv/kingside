/**
 * KS-3442 (ADR-088 §11 F1). Сессионная обёртка blind-board: старт
 * сессии → запоминание (KS-3448) → раунды → wrong-answer → финал-экран.
 * KS-3453: dead-end удалён — backend при отсутствии хода у целевой
 * фигуры берёт другую из 5; сессия завершается только ошибкой игрока.
 *
 * Раннер (`BlindBoardRunner`) отвечает только за пустую доску + клик +
 * промоушн; здесь склейка с API (`blindBoardApi`) и UI-фазы:
 *   - `starting`    — POST /sessions, грузим первый ход + startPosition.
 *   - `memorizing`  — KS-3448: показываем стартовую расстановку 5 фигур
 *     (один раз, до игры) + кнопку «Готов»; HUD скрыт.
 *   - `playing`     — раунды; submitAnswer → следующий ход / финал.
 *   - `awaiting`    — ждём ответ от сервера на свой submitAnswer
 *     (доска заморожена через `disabled`).
 *   - `final`       — wrong-answer; раскрытие позиции +
 *     bestStreak + кнопка «Играть ещё».
 *   - `error`       — startSession упал.
 *
 * KS-3448: backend (api ≥ ea4f77bc) на старте отдаёт
 * `startPosition: BlindBoardPiece[]` — клиент запоминает её и
 * показывает в фазе `memorizing`. После клика «Готов» доска чистится
 * (фаза `playing`, EMPTY_FEN, стрелка первого хода). Анти-чит §5
 * не нарушается: на последующих answer-запросах полная позиция уже
 * не раскрывается — только при wrong-answer.
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
import { BlindBoardFinalScreen } from './BlindBoardFinalScreen';
import { MemoChessboard } from '../MemoChessboard';
import { piecesToFen } from './BlindBoardFinalScreen';
import { blindBoardApi } from '../../api/blindBoardApi';

type Status =
  | 'starting'
  | 'memorizing'
  | 'playing'
  | 'awaiting'
  | 'final'
  | 'error';

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
  // KS-3448: стартовая расстановка для фазы memorize. После клика
  // «Готов» не используется (доска становится пустой), но держим до
  // resets чтобы не плодить лишний state-сброс.
  const [startPosition, setStartPosition] = useState<BlindBoardPiece[]>([]);
  const sessionIdRef = useRef<string | null>(null);
  const genRef = useRef(0);

  // ── Старт сессии ───────────────────────────────────────────────────
  useEffect(() => {
    const gen = ++genRef.current;
    setStatus('starting');
    setSession(null);
    setLastAnswer(null);
    setStartPosition([]);
    void (async () => {
      try {
        const res = await api.startSession();
        if (gen !== genRef.current) return;
        sessionIdRef.current = res.session.id;
        setSession(res.session);
        // KS-3448: запоминание — показываем 5 фигур, ждём «Готов».
        // На случай отсутствия поля (старый backend) сразу в playing.
        setStartPosition(res.startPosition ?? []);
        setStatus(
          res.startPosition && res.startPosition.length > 0
            ? 'memorizing'
            : 'playing',
        );
      } catch {
        if (gen !== genRef.current) return;
        setStatus('error');
      }
    })();
    return () => {
      genRef.current += 1;
    };
  }, [api]);

  // ── KS-3448: переход из memorize в playing ────────────────────────
  const handleReady = useCallback(() => {
    setStatus('playing');
  }, []);

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

  if (status === 'memorizing' && session) {
    // KS-3448: фаза запоминания — доска со стартовой расстановкой
    // (FEN из startPosition) + большая кнопка «Готов» под доской. HUD
    // не показываем — оставляем его до начала игры, чтобы не отвлекать
    // от запоминания. Шкала прогресса / таймер — в M2.
    const fen = piecesToFen(startPosition);
    return (
      <div
        className="blind-board-session blind-board-session--memorizing"
        data-testid="blind-board-session"
        data-status="memorizing"
      >
        <div
          className="blind-board-session__memorize"
          data-testid="blind-board-memorize"
        >
          <h2
            className="blind-board-session__memorize-title"
            data-testid="blind-board-memorize-title"
          >
            {t('blindBoard.memorize.title', 'Memorize the position')}
          </h2>
          <p
            className="blind-board-session__memorize-hint"
            data-testid="blind-board-memorize-hint"
          >
            {t(
              'blindBoard.memorize.hint',
              'After you click "Ready" the pieces disappear and the computer starts moving. Hold the position in your head and each round point at the piece that was attacked or fell under attack.',
            )}
          </p>
          <div
            className="blind-board-session__memorize-board"
            data-testid="blind-board-memorize-board"
            data-fen={fen}
          >
            <MemoChessboard
              options={{
                position: fen,
                boardOrientation: 'white',
                allowDragging: false,
                showNotation: true,
                animationDurationInMs: 0,
              }}
            />
          </div>
          <button
            type="button"
            className="blind-board-session__memorize-ready play-btn"
            data-testid="blind-board-memorize-ready"
            onClick={handleReady}
          >
            {t('blindBoard.memorize.ready', 'Ready')}
          </button>
        </div>
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
            рекордом вынесен в отдельный компонент. */}
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
      {/* KS-3452: HUD-табло. Каждая метрика разбита на label/value
          для CSS-типографики (label uppercase 11/700, value крупное
          tabular-nums) — стили в blindBoard.css. */}
      <div className="blind-board-session__hud" data-testid="blind-board-hud">
        <span
          className="blind-board-session__hud-stat"
          data-testid="blind-board-hud-round"
        >
          <span className="blind-board-session__hud-label">
            {t('blindBoard.hud.round', 'Round')}
          </span>
          <span className="blind-board-session__hud-value">
            {session?.round ?? 1}
          </span>
        </span>
        <span
          className="blind-board-session__hud-stat"
          data-testid="blind-board-hud-streak"
        >
          <span className="blind-board-session__hud-label">
            {t('blindBoard.hud.streak', 'Streak')}
          </span>
          <span className="blind-board-session__hud-value">
            {session?.streak ?? 0}
          </span>
        </span>
        <span
          className="blind-board-session__hud-stat"
          data-testid="blind-board-hud-best"
        >
          <span className="blind-board-session__hud-label">
            {t('blindBoard.hud.bestStreak', 'Best')}
          </span>
          <span className="blind-board-session__hud-value">
            {session?.bestStreak ?? 0}
          </span>
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
