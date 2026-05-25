import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { broadcastApi } from '../../api/broadcastApi';
import { openAnalysisFromPgn } from '../../utils/openAnalysisFromPgn';

/**
 * KS-1736 / ADR-023 §2.10 (A12) — извлечённый из `BroadcastTournamentPage`
 * legacy-рендер таблицы игроков (tab «Standings»). Используется как
 * fallback, когда `CrosstableResponse.tournamentType === 'unknown'` —
 * данные приходят из `GET /:id/standings` (сформирован из `broadcast_games`,
 * не chess-results). Поведение повторяет оригинальный блок и внешний вид
 * сохранён 1-в-1.
 */

type StandingsPlayer = {
  rank: number;
  name: string;
  points: number;
  gamesPlayed: number;
  sb: number;
  scores: Record<string, Array<{ score: number; gameId: string } | number>>;
};

type BroadcastGame = {
  id: string;
  lichessGameId: string;
  whitePlayer: string;
  blackPlayer: string;
  result: string | null;
  pgn: string | null;
};

type BroadcastRound = {
  id: string;
  lichessRoundId: string;
  name: string;
  startsAt: string | null;
  status: string;
};

export interface LegacyStandingsProps {
  tournamentId: string;
  broadcastTitle: string;
}

export function LegacyStandings({ tournamentId, broadcastTitle }: LegacyStandingsProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [standings, setStandings] = useState<{ players: StandingsPlayer[] } | null>(null);
  const [rounds, setRounds] = useState<BroadcastRound[]>([]);

  useEffect(() => {
    let cancelled = false;
    broadcastApi
      .get<{ players: StandingsPlayer[] }>(`/${tournamentId}/standings`)
      .then((res) => {
        if (cancelled) return;
        if (res?.players) {
          setStandings(res);
        } else {
          console.error('Standings: unexpected response format', res);
        }
      })
      .catch((e) => console.error('Failed to load standings:', e));

    broadcastApi
      .get<{ data: BroadcastRound[] }>(`/${tournamentId}/rounds`)
      .then((res) => {
        if (cancelled) return;
        setRounds(Array.isArray(res?.data) ? res.data : []);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [tournamentId]);

  const handleScoreClick = async (gameId: string, playerName: string, oppName: string) => {
    // Find the game across all rounds to get PGN
    for (const round of rounds) {
      try {
        const res = await broadcastApi.get<{ data: BroadcastGame[] }>(`/${tournamentId}/rounds/${round.id}/games`);
        const games = Array.isArray(res?.data) ? res.data : [];
        const game = games.find((g) => g.id === gameId);
        if (game?.pgn) {
          // KS-2403 follow-up: см. openAnalysisFromPgn.
          await openAnalysisFromPgn(navigate, {
            pgn: game.pgn,
            title: `${playerName} vs ${oppName}`,
            state: {
              breadcrumbRootTitle: broadcastTitle,
              breadcrumbRootUrl: `/broadcasts/${tournamentId}`,
            },
            // KS-3333: локализация alert при ошибке POST /analyses.
            t,
          });
          return;
        }
      } catch {
        /* continue */
      }
    }
  };

  const allPlayers = standings?.players ?? [];

  if (allPlayers.length === 0) {
    return <p className="broadcast-tab-empty">{t('broadcast.noStandings', 'Standings not available yet')}</p>;
  }

  return (
    <div className="broadcast-standings-scroll" data-testid="legacy-standings">
      <table className="broadcast-standings-table">
        <thead>
          <tr>
            <th className="broadcast-st-rank">#</th>
            <th className="broadcast-st-name">{t('tournaments.player', 'Player')}</th>
            <th className="broadcast-st-pts">Pts</th>
            <th className="broadcast-st-num">GP</th>
            <th className="broadcast-st-num">SB</th>
            {allPlayers.map((p) => (
              <th key={p.name} className="broadcast-st-cell" title={p.name}>
                {p.rank}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {allPlayers.map((p, ri) => (
            <tr key={p.name}>
              <td className="broadcast-st-rank">{p.rank}</td>
              <td className="broadcast-st-name">{p.name}</td>
              <td className="broadcast-st-pts">{p.points}</td>
              <td className="broadcast-st-num">{p.gamesPlayed}</td>
              <td className="broadcast-st-num">{p.sb}</td>
              {allPlayers.map((opp, ci) => {
                if (ri === ci) return <td key={ci} className="broadcast-st-cell broadcast-st-diag">✕</td>;
                const rawEntries = p.scores[opp.name] ?? [];
                if (rawEntries.length === 0) return <td key={ci} className="broadcast-st-cell" />;
                const entries = rawEntries.map((e: unknown) =>
                  typeof e === 'number' ? { score: e, gameId: null as string | null } : (e as { score: number; gameId: string | null }),
                );
                return (
                  <td key={ci} className="broadcast-st-cell">
                    {entries.map((entry, i) => (
                      <span
                        key={i}
                        className={`broadcast-st-score${entry.gameId ? ' broadcast-st-score--clickable' : ''}${entry.score === 1 ? ' broadcast-st-win' : entry.score === 0 ? ' broadcast-st-loss' : ' broadcast-st-draw'}`}
                        onClick={entry.gameId ? () => handleScoreClick(entry.gameId!, p.name, opp.name) : undefined}
                        role={entry.gameId ? 'button' : undefined}
                        tabIndex={entry.gameId ? 0 : undefined}
                        title={`${p.name} vs ${opp.name}`}
                      >
                        {entry.score === 0.5 ? '½' : entry.score}
                      </span>
                    ))}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
