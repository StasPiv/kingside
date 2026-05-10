import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Chess } from 'chess.js';
import { Chessboard } from 'react-chessboard';
import type { BroadcastGameSummary } from '@kingside/shared';
import { broadcastApi } from '../api/broadcastApi';
import { openAnalysisFromPgn } from '../utils/openAnalysisFromPgn';
import { useSounds, soundEventFromSan } from '../hooks/useSounds';
import {
  formatBroadcastClock,
  useBroadcastClock,
} from '../hooks/useBroadcastClock';

/**
 * KS-2448: live-режим просмотра партии трансляции.
 *
 * Раньше клик по партии активного тура вёл в Мастерскую (`/analysis/<id>`),
 * но на Мастерской нет подписки на live-обновления — позиция «застывала»
 * в момент клика и пользователь не видел новых ходов до перезагрузки.
 *
 * Live-режим — отдельный route `/broadcasts/:tid/:rid/:gid/live`, который
 * подписан на тот же 15s polling, что и страница тура (`BroadcastRoundPage`,
 * `BroadcastTournamentPage` Live-tab). При появлении нового хода доска и
 * список ходов обновляются без перезагрузки.
 *
 * Кнопка «Открыть в Мастерской» возвращает старое поведение — создаёт
 * `analysis`-запись и уводит на `/analysis/<id>` для глубокого разбора.
 */

const INITIAL_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

function stripPgnComments(pgn: string): string {
  return pgn.replace(/\{[^}]*\}/g, '');
}

function loadPgnSafe(chess: InstanceType<typeof Chess>, pgn: string): boolean {
  try {
    chess.loadPgn(pgn);
    return true;
  } catch {
    try {
      chess.loadPgn(stripPgnComments(pgn));
      return true;
    } catch {
      return false;
    }
  }
}

type ParsedPgn = {
  fen: string;
  lastMove: { from: string; to: string } | null;
  history: { san: string; ply: number }[];
};

function parsePgn(pgn: string, currentFen: string | null | undefined): ParsedPgn {
  if (!pgn) return { fen: currentFen || INITIAL_FEN, lastMove: null, history: [] };
  const chess = new Chess();
  if (!loadPgnSafe(chess, pgn)) {
    return { fen: currentFen || INITIAL_FEN, lastMove: null, history: [] };
  }
  let hist: { san: string; from: string; to: string }[];
  try {
    hist = chess.history({ verbose: true }) as { san: string; from: string; to: string }[];
  } catch {
    hist = [];
  }
  const fen = chess.fen() || currentFen || INITIAL_FEN;
  const lastMove = hist.length ? { from: hist[hist.length - 1].from, to: hist[hist.length - 1].to } : null;
  const history = hist.map((m, i) => ({ san: m.san, ply: i + 1 }));
  return { fen, lastMove, history };
}

type BroadcastMeta = {
  id: string;
  title: string;
};

type LichessRound = {
  id: string;
  name: string;
  status?: string;
};

type LiveGame = BroadcastGameSummary;

export function BroadcastLiveGamePage() {
  const { tournamentId, roundId, gameId } = useParams<{
    tournamentId: string;
    roundId: string;
    gameId: string;
  }>();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { playSound } = useSounds();

  const [broadcast, setBroadcast] = useState<BroadcastMeta | null>(null);
  const [round, setRound] = useState<LichessRound | null>(null);
  const [game, setGame] = useState<LiveGame | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Initial fetch: meta + round + games (нужен round.name для breadcrumb).
  useEffect(() => {
    if (!tournamentId || !roundId || !gameId) return;
    let cancelled = false;
    setLoading(true);
    Promise.all([
      broadcastApi.get<BroadcastMeta>(`/${tournamentId}`),
      broadcastApi.get<{ data: LichessRound[] }>(`/${tournamentId}/rounds`),
      broadcastApi.get<{ data: LiveGame[] }>(`/${tournamentId}/rounds/${roundId}/games`),
    ])
      .then(([meta, roundsRes, gamesRes]) => {
        if (cancelled) return;
        const rounds = Array.isArray(roundsRes?.data) ? roundsRes.data : [];
        const games = Array.isArray(gamesRes?.data) ? gamesRes.data : [];
        const found = games.find((g) => g.id === gameId) ?? null;
        setBroadcast(meta);
        setRound(rounds.find((r) => r.id === roundId) ?? null);
        if (!found) {
          setError(t('broadcastLive.notFound', 'Game not found'));
        } else {
          setGame(found);
        }
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : t('broadcasts.error', 'Failed to load broadcast'));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tournamentId, roundId, gameId, t]);

  // Polling 15s. Останавливается, как только результат партии перестал быть `*`
  // (партия завершилась) или если round не `ongoing`. Это экономит запросы — у
  // завершившейся партии новых ходов уже не будет.
  const prevPgnRef = useRef<string>('');
  useEffect(() => {
    if (!tournamentId || !roundId || !gameId) return;
    if (round && round.status && round.status !== 'ongoing') return;
    if (game && game.result && game.result !== '*') return;

    let cancelled = false;
    const fetchOnce = () => {
      broadcastApi
        .get<{ data: LiveGame[] }>(`/${tournamentId}/rounds/${roundId}/games`)
        .then((res) => {
          if (cancelled) return;
          const games = Array.isArray(res?.data) ? res.data : [];
          const fresh = games.find((g) => g.id === gameId);
          if (!fresh) return;
          const prevLen = prevPgnRef.current.length;
          const curLen = fresh.pgn?.length ?? 0;
          if (curLen > prevLen && fresh.pgn) {
            // Звук на новый ход (как на странице тура).
            try {
              const chess = new Chess();
              if (loadPgnSafe(chess, fresh.pgn)) {
                const hist = chess.history();
                const lastSan = hist.length ? hist[hist.length - 1] : null;
                if (lastSan) playSound(soundEventFromSan(lastSan));
              }
            } catch {
              /* ignore sound errors */
            }
          }
          prevPgnRef.current = fresh.pgn ?? '';
          setGame(fresh);
        })
        .catch(() => {});
    };

    const intervalId = setInterval(fetchOnce, 15_000);
    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
    // round.status и game.result меняются изредка — перезапуск интервала на их
    // изменение приемлем (cleanup отрабатывает корректно).
  }, [tournamentId, roundId, gameId, round, game, playSound]);

  const parsed = useMemo<ParsedPgn>(
    () => parsePgn(game?.pgn ?? '', game?.currentFen),
    [game?.pgn, game?.currentFen],
  );

  const squareStyles = useMemo<Record<string, React.CSSProperties>>(() => {
    if (!parsed.lastMove) return {};
    const hl = { backgroundColor: 'rgba(255, 255, 0, 0.4)' };
    return { [parsed.lastMove.from]: hl, [parsed.lastMove.to]: hl };
  }, [parsed.lastMove]);

  // KS-2700: side-to-move определяется по текущему FEN. Если parsed.fen
  // невалиден (теоретически — всегда возвращается какой-то FEN, но
  // на всякий случай fallback на 'w') — считаем что ход белых.
  const isBlackTurn = useMemo(() => {
    const parts = parsed.fen.split(' ');
    return parts[1] === 'b';
  }, [parsed.fen]);
  const isFinished = Boolean(game?.result && game.result !== '*');
  const clock = useBroadcastClock({
    whiteClockMs: game?.whiteClockMs ?? null,
    blackClockMs: game?.blackClockMs ?? null,
    clockUpdatedAt: game?.clockUpdatedAt ?? null,
    isBlackTurn,
    isFinished,
  });
  const whiteClockText = formatBroadcastClock(clock.whiteRemainingMs);
  const blackClockText = formatBroadcastClock(clock.blackRemainingMs);

  const handleOpenInAnalysis = () => {
    if (!game?.pgn) return;
    void openAnalysisFromPgn(navigate, {
      pgn: game.pgn,
      title: `${game.whitePlayer ?? ''} vs ${game.blackPlayer ?? ''}`,
      state: {
        breadcrumbRootTitle: broadcast?.title ?? '',
        breadcrumbRootUrl: `/broadcasts/${tournamentId}`,
        breadcrumbSection: round?.name,
        breadcrumbBackUrl: `/broadcasts/${tournamentId}/${roundId}`,
      },
    });
  };

  if (loading) return <div className="loading">{t('common.loading')}</div>;
  if (error || !broadcast || !game) {
    return (
      <div className="error">
        {error || t('broadcasts.error', 'Failed to load broadcast')}
      </div>
    );
  }

  const result = game.result && game.result !== '*' ? game.result : null;

  return (
    <div className="broadcast-live-game-page">
      <nav className="broadcast-breadcrumbs">
        <Link to="/broadcasts">{t('broadcasts.title')}</Link>
        <span className="broadcast-breadcrumb-sep">/</span>
        <Link to={`/broadcasts/${tournamentId}`} state={{ fromRound: true }}>
          {broadcast.title}
        </Link>
        <span className="broadcast-breadcrumb-sep">/</span>
        <Link to={`/broadcasts/${tournamentId}/${roundId}`}>{round?.name ?? ''}</Link>
        <span className="broadcast-breadcrumb-sep">/</span>
        <span>
          {game.whitePlayer ?? '—'} vs {game.blackPlayer ?? '—'}
        </span>
      </nav>

      <div className="broadcast-live-game">
        <div className="broadcast-live-game__board-col">
          {/* KS-2700: player-row с pill-таймером справа. Над доской —
              чёрные, под доской — белые (доска ориентирована стандартно
              для зрителя — белые внизу). Таймер рендерится только если
              у партии есть `clockUpdatedAt` (источник с %clk + после
              старта). Активная сторона тикает раз в секунду. */}
          <div
            className="broadcast-live-game__player broadcast-live-game__player--top"
            data-testid="broadcast-live-player-black"
            data-active={isBlackTurn && !isFinished ? 'true' : 'false'}
          >
            <span className="broadcast-live-game__player-name">
              <span className="broadcast-live-game__player-piece">&#9823;</span>
              {game.blackPlayer ?? '—'}
            </span>
            {result === '0-1' && <span className="broadcast-live-game__result">1</span>}
            {result === '1-0' && <span className="broadcast-live-game__result">0</span>}
            {result === '1/2-1/2' && <span className="broadcast-live-game__result">½</span>}
            {clock.hasClocks && blackClockText !== null && (
              <span
                className={`broadcast-live-game__clock${isBlackTurn && !isFinished ? ' broadcast-live-game__clock--active' : ''}`}
                data-testid="broadcast-live-clock-black"
              >
                {blackClockText}
              </span>
            )}
          </div>
          <div className="broadcast-live-game__board">
            <Chessboard
              options={{
                position: parsed.fen,
                allowDragging: false,
                showNotation: true,
                animationDurationInMs: 0,
                squareStyles,
              }}
            />
          </div>
          <div
            className="broadcast-live-game__player broadcast-live-game__player--bottom"
            data-testid="broadcast-live-player-white"
            data-active={!isBlackTurn && !isFinished ? 'true' : 'false'}
          >
            <span className="broadcast-live-game__player-name">
              <span className="broadcast-live-game__player-piece">&#9817;</span>
              {game.whitePlayer ?? '—'}
            </span>
            {result === '1-0' && <span className="broadcast-live-game__result">1</span>}
            {result === '0-1' && <span className="broadcast-live-game__result">0</span>}
            {result === '1/2-1/2' && <span className="broadcast-live-game__result">½</span>}
            {clock.hasClocks && whiteClockText !== null && (
              <span
                className={`broadcast-live-game__clock${!isBlackTurn && !isFinished ? ' broadcast-live-game__clock--active' : ''}`}
                data-testid="broadcast-live-clock-white"
              >
                {whiteClockText}
              </span>
            )}
          </div>
          {result === null && (
            <div className="broadcast-live-game__live-pill">
              <span className="broadcast-live-game__live-dot" />
              {t('broadcastLive.live', 'LIVE — ходы приходят автоматически')}
            </div>
          )}
        </div>

        <div className="broadcast-live-game__side-col">
          <button
            type="button"
            className="broadcast-live-game__open-analysis"
            onClick={handleOpenInAnalysis}
            disabled={!game.pgn}
          >
            {t('broadcastLive.openInAnalysis', 'Открыть в Мастерской')}
          </button>

          <div className="broadcast-live-game__moves-block">
            <h3>{t('broadcastLive.movesTitle', 'Ходы')}</h3>
            {parsed.history.length === 0 ? (
              <p className="broadcast-live-game__moves-empty">
                {t('broadcastLive.noMovesYet', 'Партия ещё не началась')}
              </p>
            ) : (
              <ol className="broadcast-live-game__moves">
                {parsed.history.map((m, i) => {
                  const isWhite = i % 2 === 0;
                  const moveNumber = Math.floor(i / 2) + 1;
                  return (
                    <li
                      key={`${m.ply}:${m.san}`}
                      className={`broadcast-live-game__move${i === parsed.history.length - 1 ? ' broadcast-live-game__move--last' : ''}`}
                    >
                      {isWhite && <span className="broadcast-live-game__move-num">{moveNumber}.</span>}
                      <span className="broadcast-live-game__move-san">{m.san}</span>
                    </li>
                  );
                })}
              </ol>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
