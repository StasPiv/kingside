import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Chess } from 'chess.js';
import type {
  GuessSide,
  GuessGameSource,
  GuessMoveDto,
  FinishGuessSessionResponse,
} from '@kingside/shared';

import { GuessRunner, type GuessSubmission } from './GuessRunner';
import { GuessFinalScreen } from './GuessFinalScreen';
import { WdlChancesBar } from '../WdlChancesBar';
import type { WdlDistribution } from '../../utils/engineAdapter';
import { guessApi } from '../../api/guessApi';
import { useAuth } from '../../context/AuthContext';

/**
 * KS-3458: разобрать PGN headers через chess.js, вытащить имя/Elo
 * нужного игрока (по `side`). Возвращает строку «Carlsen, Magnus 2828»
 * или просто «Carlsen, Magnus» если рейтинга нет; `null` — если в
 * заголовке имя пусто/«?» (anonymous PGN).
 */
function buildPlayerLabel(pgn: string, side: GuessSide): string | null {
  try {
    const g = new Chess();
    g.loadPgn(pgn);
    const headers = g.header();
    const nameKey = side === 'white' ? 'White' : 'Black';
    const eloKey = side === 'white' ? 'WhiteElo' : 'BlackElo';
    const rawName = headers[nameKey]?.trim();
    if (!rawName || rawName === '?') return null;
    const rawElo = headers[eloKey]?.trim();
    const eloNum = rawElo && /^\d+$/.test(rawElo) ? rawElo : null;
    return eloNum ? `${rawName} ${eloNum}` : rawName;
  } catch {
    return null;
  }
}

/**
 * KS-3458: обрезать длинный ник многоточием. По умолчанию 14 символов —
 * на узких mobile-экранах табло не разъезжается.
 */
function truncate(s: string, max = 14): string {
  return s.length > max ? `${s.slice(0, Math.max(1, max - 1))}…` : s;
}

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
  const { user } = useAuth();

  // KS-3458: имена для HUD-табло. Юзер — username из AuthContext,
  // обрезанный до 14 символов; player — имя+Elo из PGN headers по
  // выбранной стороне. Гость / отсутствующие заголовки → fallback
  // на старые i18n-ключи `guess.hud.{you,player}`.
  const userLabel = useMemo<string | null>(() => {
    if (!user?.username) return null;
    return truncate(user.username, 14);
  }, [user]);
  const playerLabel = useMemo<string | null>(
    () => buildPlayerLabel(pgn, side),
    [pgn, side],
  );

  const [status, setStatus] = useState<Status>('starting');
  const sessionIdRef = useRef<string | null>(null);
  // KS-3430: score передаём в GuessFinalScreen (итоги). HUD больше
  // не показывает Очки/Серию/Сильнее — заменено на две live-точности.
  const [score, setScore] = useState(0);
  // KS-3436: HUD-табло «ты : игрок» (matchup-счёт). Поля
  // userPoints/playerPoints приходят в SubmitGuessMoveResponse
  // (KS-3435 backend, api:325). На старте 0:0 — фактическое значение
  // партии до первого submitMove.
  const [userPoints, setUserPoints] = useState(0);
  const [playerPoints, setPlayerPoints] = useState(0);
  // KS-3432: live-WDL для шкалы НАД доской. GuessRunner стримит наружу
  // через `onLiveWdl`. null до первого info — рисуется loading-полоса.
  const [liveWdl, setLiveWdl] = useState<WdlDistribution | null>(null);
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
    setUserPoints(0);
    setPlayerPoints(0);
    setLiveWdl(null);
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
          // Server-trust: score (для финал-экрана) + табло
          // userPoints/playerPoints (KS-3436 HUD) — из серверного
          // ответа. KS-3435: backend отдаёт userPoints/playerPoints в
          // SubmitGuessMoveResponse.
          setScore(res.score);
          setUserPoints(res.userPoints);
          setPlayerPoints(res.playerPoints);
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
      {/* KS-3432: WDL-шкала live-анализа НАД HUD/доской. Порядок
          сверху вниз: WDL → HUD → доска → verdict. Источник — стрим
          из GuessRunner через `onLiveWdl`. POV = side-to-move в
          displayFen (на guess-полуходе это выбранная сторона юзера). */}
      <div
        className="guess-session__wdl"
        data-testid="guess-session-wdl-wrapper"
      >
        <WdlChancesBar wdl={liveWdl} testId="guess-session-wdl" />
      </div>
      {/* KS-3436: HUD — табло счёта (matchup-вид). KS-3458: вместо
          обезличенных «Ты / Игрок» — ник пользователя и имя+Elo
          игрока партии (по `side`). Гость / партия без player-headers
          → fallback на старые i18n-ключи `guess.hud.{you,player}`.
          Очки приходят с сервера в submitMove (KS-3435 backend):
          userPoints = ходы с verdict ∈ {strongest, betterThanPlayer};
          playerPoints = ходы с verdict='weaker'. asPlayer никому очко
          не даёт. Финал-экран (точности/звёзды) — отдельная сцена. */}
      <div
        className="guess-session__hud guess-session__hud--scoreboard"
        data-testid="guess-session-hud"
      >
        <div
          className="guess-session__score guess-session__score--user"
          data-testid="guess-hud-user-score"
        >
          <span
            className="guess-session__score-label"
            data-testid="guess-hud-user-label"
            title={user?.username ?? undefined}
          >
            {userLabel ?? t('guess.hud.you', 'You')}
          </span>
          <span
            className="guess-session__score-value"
            data-testid="guess-hud-user-points"
          >
            {userPoints}
          </span>
        </div>
        <span className="guess-session__score-sep" aria-hidden="true">
          :
        </span>
        <div
          className="guess-session__score guess-session__score--player"
          data-testid="guess-hud-player-score"
        >
          <span
            className="guess-session__score-value"
            data-testid="guess-hud-player-points"
          >
            {playerPoints}
          </span>
          <span
            className="guess-session__score-label"
            data-testid="guess-hud-player-label"
            title={playerLabel ?? undefined}
          >
            {playerLabel ?? t('guess.hud.player', 'Game')}
          </span>
        </div>
      </div>
      <GuessRunner
        pgn={pgn}
        side={side}
        onGuess={handleGuess}
        onFinish={handleFinish}
        engineFactory={engineFactory}
        onLiveWdl={setLiveWdl}
      />
      {status === 'finishing' && (
        <p data-testid="guess-session-finishing">
          {t('guess.session.finishing', 'Tallying results…')}
        </p>
      )}
    </div>
  );
}
