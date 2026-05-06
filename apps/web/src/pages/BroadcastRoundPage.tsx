import { useState, useEffect, useRef } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { Chess } from 'chess.js';
import { useTranslation } from 'react-i18next';
import type {
  BroadcastGameSummary,
  BroadcastRoundItem,
} from '@kingside/shared';
import { broadcastApi } from '../api/broadcastApi';
import { openAnalysisFromPgn } from '../utils/openAnalysisFromPgn';
import { useSounds, soundEventFromSan } from '../hooks/useSounds';
import { BroadcastBoardCard } from '../components/broadcast/BroadcastBoardCard';
import { sortGamesByWhite, gamesFingerprint } from '../utils/broadcastGameSort';
// KS-1823: условный рендер `PlayoffBracket` на странице раунда был
// регрессией (вкладка Rounds всегда должна показывать доски партий).
// Компонент остаётся в репо — он будет использован на вкладке
// Standings в KS-1825. Из BroadcastRoundPage импорт удалён.

/** Extract last move SAN from PGN for sound */
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

function computeLastMoveSan(pgn: string): string | null {
  try {
    const chess = new Chess();
    if (!loadPgnSafe(chess, pgn)) return null;
    const hist = chess.history();
    return hist.length > 0 ? hist[hist.length - 1] : null;
  } catch {
    return null;
  }
}

/** Strip clock/eval comments that may cause chess.js loadPgn to fail */
function stripPgnComments(pgn: string): string {
  return pgn.replace(/\{[^}]*\}/g, '');
}

// Lichess types.
// NB: shared `BroadcastGameSummary` точнее шейпит bracket-поля (KS-1813);
// используем его, чтобы `PlayoffBracket` получил корректный тип.
type LichessGame = BroadcastGameSummary;


type LichessRoundInfo = BroadcastRoundItem;

type LichessBroadcastMeta = {
  id: string;
  title: string;
};

/**
 * KS-1747: Lichess-only round view. Рендерит список партий тура, с
 * подсветкой последнего хода и поллингом PGN каждые 15 секунд.
 */
export function BroadcastRoundPage() {
  const { tournamentId, roundId } = useParams<{ tournamentId: string; roundId: string }>();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { playSound } = useSounds();

  const [broadcast, setBroadcast] = useState<LichessBroadcastMeta | null>(null);
  const [rounds, setRounds] = useState<LichessRoundInfo[]>([]);
  const [games, setGames] = useState<LichessGame[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Initial load: broadcast meta + rounds + games
  useEffect(() => {
    if (!tournamentId || !roundId) return;
    let cancelled = false;

    setLoading(true);
    Promise.all([
      broadcastApi.get<LichessBroadcastMeta>(`/${tournamentId}`),
      broadcastApi.get<{ data: LichessRoundInfo[] }>(`/${tournamentId}/rounds`),
      broadcastApi.get<{ data: LichessGame[] }>(`/${tournamentId}/rounds/${roundId}/games`),
    ])
      .then(([meta, roundsRes, gamesRes]) => {
        if (cancelled) return;
        setBroadcast(meta);
        setRounds(Array.isArray(roundsRes?.data) ? roundsRes.data : []);
        setGames(sortGamesByWhite(Array.isArray(gamesRes?.data) ? gamesRes.data : []));
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : t('broadcasts.error', 'Failed to load broadcast'));
        setLoading(false);
      });

    return () => { cancelled = true; };
  }, [tournamentId, roundId, t]);

  // Poll games every 15s + play sound on new move
  const prevGamesRef = useRef<LichessGame[]>([]);
  useEffect(() => {
    if (!tournamentId || !roundId) return;
    let cancelled = false;
    let isFirstFetch = true;

    const fetchGames = () => {
      broadcastApi.get<{ data: LichessGame[] }>(`/${tournamentId}/rounds/${roundId}/games`)
        .then((res) => {
          if (cancelled) return;
          const fresh = Array.isArray(res?.data) ? res.data : [];
          const prev = prevGamesRef.current;
          if (!isFirstFetch && prev.length > 0) {
            for (const game of fresh) {
              const prevGame = prev.find((g) => g.id === game.id);
              const prevPgnLen = prevGame?.pgn?.length ?? 0;
              const curPgnLen = game.pgn?.length ?? 0;
              if (curPgnLen > prevPgnLen && game.pgn) {
                const lastMove = computeLastMoveSan(game.pgn);
                if (lastMove) playSound(soundEventFromSan(lastMove));
                break; // one sound per poll
              }
            }
          }
          // KS-2446: fingerprint считаем по id+pgnLen независимо от
          // порядка backend, чтобы перерендер триггерился именно
          // изменением хода, а не перестановкой массива.
          const fingerprint = gamesFingerprint(fresh);
          const prevFingerprint = gamesFingerprint(prev);
          if (isFirstFetch || fingerprint !== prevFingerprint) {
            setGames(sortGamesByWhite(fresh));
          }
          prevGamesRef.current = fresh;
          isFirstFetch = false;
        })
        .catch(() => {});
    };

    const intervalId = setInterval(fetchGames, 15_000);
    return () => { cancelled = true; clearInterval(intervalId); };
  }, [tournamentId, roundId, playSound]);

  const currentRound = rounds.find((r) => r.id === roundId);

  const handleGameClick = (game: LichessGame) => {
    if (!game.pgn) return;
    // KS-2403 follow-up: openAnalysisFromPgn создаёт analysis-запись и
    // идёт на /analysis/<id>, чтобы повторные клики из той же сессии
    // не приводили к перезаписи через autosave.
    void openAnalysisFromPgn(navigate, {
      pgn: game.pgn,
      title: `${game.whitePlayer} vs ${game.blackPlayer}`,
      state: {
        breadcrumbRootTitle: broadcast?.title ?? '',
        breadcrumbRootUrl: `/broadcasts/${tournamentId}`,
        breadcrumbSection: currentRound?.name,
        breadcrumbBackUrl: `/broadcasts/${tournamentId}/${roundId}`,
      },
    });
  };

  if (loading) return <div className="loading">{t('common.loading')}</div>;
  if (error || !broadcast) {
    return <div className="error">{error || t('broadcasts.error', 'Failed to load broadcast')}</div>;
  }

  return (
    <div className="broadcast-round-page">
      <nav className="broadcast-breadcrumbs">
        <Link to="/broadcasts">{t('broadcasts.title')}</Link>
        <span className="broadcast-breadcrumb-sep">/</span>
        <Link to={`/broadcasts/${tournamentId}`} state={{ fromRound: true }}>
          {broadcast.title}
        </Link>
        <span className="broadcast-breadcrumb-sep">/</span>
        <span>{currentRound?.name ?? ''}</span>
      </nav>

      {/* Round tabs */}
      <div className="broadcast-rounds-row">
        {rounds.map((r) => (
          <Link
            key={r.id}
            to={`/broadcasts/${tournamentId}/${r.id}`}
            className={`broadcast-round-btn${r.id === roundId ? ' broadcast-round-btn--active' : ''}`}
          >
            {r.name}
          </Link>
        ))}
      </div>

      {games.length === 0 ? (
        <div className="broadcasts-empty">{t('broadcastRound.noGames', 'No games in this round')}</div>
      ) : (
        <div className="broadcast-games-section">
          <div className="broadcast-boards-grid">
            {games.map((game) => (
              <BroadcastBoardCard
                key={game.id}
                game={game}
                onGameClick={handleGameClick}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
