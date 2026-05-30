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
  BlindBoardConfig,
  BlindBoardMove,
  BlindBoardPiece,
  BlindBoardPieceType,
  BlindBoardSessionDto,
  BlindBoardSquare,
  SubmitBlindBoardAnswerResponse,
} from '@kingside/shared';

import { BlindBoardRunner } from './BlindBoardRunner';
import { BlindBoardFinalScreen } from './BlindBoardFinalScreen';
import { BlindBoardLevelUpOverlay } from './BlindBoardLevelUpOverlay';
import { MemoChessboard } from '../MemoChessboard';
import { piecesToFen } from './BlindBoardFinalScreen';
import { blindBoardApi } from '../../api/blindBoardApi';
import { ApiError } from '../../ApiError';

/**
 * KS-3464: «kind»-ошибки startSession, чтобы UI показал понятный
 * текст вместо generic «Не удалось запустить». На 401 caller'у
 * показывать ошибку не нужно — api.ts уже триггерит
 * `kingside:session-expired` → AuthContext делает redirect на /login.
 */
type StartError =
  | 'session-expired'
  | 'network'
  | 'timeout'
  | 'server'
  | 'unknown';

function classifyStartError(e: unknown): StartError {
  if (e instanceof ApiError) {
    if (e.errorCode === 'SESSION_EXPIRED' || e.status === 401)
      return 'session-expired';
    if (e.errorCode === 'REQUEST_TIMEOUT') return 'timeout';
    if (e.errorCode === 'NETWORK_ERROR') return 'network';
    if (typeof e.status === 'number' && e.status >= 500) return 'server';
  }
  return 'unknown';
}

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
  /**
   * KS-3488 (ADR-088 V2 §15 F1): конфиг прогрессивной сложности. Если
   * не передан — backend применит `DEFAULT_BLIND_BOARD_CONFIG`.
   */
  config?: BlindBoardConfig;
}

export function BlindBoardSessionRunner({
  api = blindBoardApi,
  onExit,
  config,
}: BlindBoardSessionRunnerProps) {
  const { t } = useTranslation();

  const [status, setStatus] = useState<Status>('starting');
  const [session, setSession] = useState<BlindBoardSessionDto | null>(null);
  const [lastAnswer, setLastAnswer] =
    useState<SubmitBlindBoardAnswerResponse | null>(null);
  // KS-3464: тип последней ошибки старта (для дифференцированного
  // текста в error-фазе). `null` пока нет ошибки.
  const [startError, setStartError] = useState<StartError | null>(null);
  // KS-3448: стартовая расстановка для фазы memorize. После клика
  // «Готов» не используется (доска становится пустой), но держим до
  // resets чтобы не плодить лишний state-сброс.
  const [startPosition, setStartPosition] = useState<BlindBoardPiece[]>([]);
  // KS-3489 (V2 §15 F2): snapshot фактически применённого конфига
  // (с дефолтом для backwards-compat если backend ещё не отдал).
  const [startConfig, setStartConfig] = useState<BlindBoardConfig | null>(null);
  // Полная текущая расстановка на доске = startPosition + накопленные
  // фигуры из levelUp'ов (нужна для overlay). Клиент знает только то,
  // что сам видел — анти-чит сохранён.
  const [piecesOnBoard, setPiecesOnBoard] = useState<BlindBoardPiece[]>([]);
  // Текущий level-up для overlay; null — overlay не показан.
  const [levelUpEvent, setLevelUpEvent] = useState<NonNullable<
    SubmitBlindBoardAnswerResponse['levelUp']
  > | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const genRef = useRef(0);

  // ── Старт сессии ───────────────────────────────────────────────────
  useEffect(() => {
    const gen = ++genRef.current;
    setStatus('starting');
    setSession(null);
    setLastAnswer(null);
    setStartPosition([]);
    setStartConfig(null);
    setPiecesOnBoard([]);
    setLevelUpEvent(null);
    setStartError(null);
    void (async () => {
      try {
        const res = await api.startSession(
          config ? { config } : undefined,
        );
        if (gen !== genRef.current) return;
        sessionIdRef.current = res.session.id;
        setSession(res.session);
        // KS-3448: запоминание — показываем 5 фигур, ждём «Готов».
        // На случай отсутствия поля (старый backend) сразу в playing.
        setStartPosition(res.startPosition ?? []);
        setPiecesOnBoard(res.startPosition ?? []);
        // KS-3489: snapshot конфига для HUD pill / level-up overlay.
        setStartConfig(res.config ?? null);
        setStatus(
          res.startPosition && res.startPosition.length > 0
            ? 'memorizing'
            : 'playing',
        );
      } catch (e) {
        if (gen !== genRef.current) return;
        // KS-3464: logging для диагностики (catch раньше глотал
        // ошибку без следа в консоли). ApiError тоже печатается —
        // полезно видеть `errorCode` и `status` при разборе жалоб.
        // eslint-disable-next-line no-console
        console.error('[blindBoard] startSession failed:', e);
        const kind = classifyStartError(e);
        setStartError(kind);
        // На 401 api.ts уже задиспатчил kingside:session-expired —
        // AuthContext выполнит hard-redirect на /login. Локально
        // тоже выставим status='error' с понятным сообщением, на
        // случай если listener успеет пропустить event.
        setStatus('error');
      }
    })();
    return () => {
      genRef.current += 1;
    };
  }, [api, config]);

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
            // KS-3489 (V2 §15 F2): backend сообщил о level-up — добавляем
            // фигуру локально и показываем overlay. Анти-чит §5: клиент
            // знает только тот square и тип, которые ему сейчас прислал
            // сервер; остальные фигуры на доске он видел в memorize.
            if (res.levelUp) {
              setPiecesOnBoard((prev) => [
                ...prev,
                { square: res.levelUp!.newSquare, type: res.levelUp!.newPiece },
              ]);
              setLevelUpEvent(res.levelUp);
            }
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
    // KS-3464: дифференцированный текст по типу ошибки. На SESSION_EXPIRED
    // показываем подсказку про логин — visible до того, как redirect
    // успеет случиться (race с listener'ом AuthContext'a).
    const errorMessage =
      startError === 'session-expired'
        ? t(
            'blindBoard.session.errorAuth',
            'Session expired. Please sign in again.',
          )
        : startError === 'network' || startError === 'timeout'
          ? t(
              'blindBoard.session.errorNetwork',
              'The server is not responding. Please try again.',
            )
          : startError === 'server'
            ? t(
                'blindBoard.session.errorServer',
                'Server error. Please try again later.',
              )
            : t(
                'blindBoard.session.error',
                'Could not start the blind-board session. Please try again.',
              );
    return (
      <div
        className="blind-board-session"
        data-testid="blind-board-session"
        data-status="error"
        data-error-kind={startError ?? ''}
      >
        <p data-testid="blind-board-session-error">{errorMessage}</p>
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
      {/* KS-3452: HUD-табло. Каждая метрика разбита на label/value.
          KS-3489 (V2 §15 F2): добавлен pill уровня «L{level}» + хинт
          о следующей фигуре из addOrder. */}
      <div className="blind-board-session__hud" data-testid="blind-board-hud">
        <span
          className="blind-board-session__hud-stat blind-board-session__hud-stat--level"
          data-testid="blind-board-hud-level"
        >
          <span className="blind-board-session__hud-label">
            {t('blindBoard.hud.level', 'Level')}
          </span>
          <span className="blind-board-session__hud-value">
            L{session?.level ?? 1}
          </span>
          {(() => {
            // Подсказка про следующий level-up: считаем сколько раундов
            // до следующего level-up'а и тип фигуры из addOrder.
            const lvl = session?.level ?? 1;
            const streak = session?.streak ?? 0;
            const nextPiece = startConfig?.addOrder?.[lvl - 1];
            const stepsToLvl = 10 - (streak % 10);
            if (!nextPiece) return null;
            return (
              <span
                className="blind-board-session__hud-hint"
                data-testid="blind-board-hud-level-hint"
                data-next-piece={nextPiece}
                data-steps={stepsToLvl}
              >
                {t(
                  'blindBoard.hud.levelHint',
                  '+{{piece}} on L{{nextLevel}} ({{steps}} to go)',
                  {
                    piece: t(`blindBoard.piece.${nextPiece}`, nextPiece),
                    nextLevel: lvl + 1,
                    steps: stepsToLvl,
                  },
                )}
              </span>
            );
          })()}
        </span>
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

      {/* KS-3489 (V2 §15 F2): overlay при level-up. memorizeTimeSec
          берётся из snapshot'а конфига (или 5 если не известен). */}
      {levelUpEvent && (
        <BlindBoardLevelUpOverlay
          piecesOnBoard={piecesOnBoard}
          newLevel={levelUpEvent.newLevel}
          newPiece={levelUpEvent.newPiece}
          newSquare={levelUpEvent.newSquare}
          memorizeTimeSec={startConfig?.memorizeTimeSec ?? 5}
          onClose={() => setLevelUpEvent(null)}
        />
      )}
    </div>
  );
}
