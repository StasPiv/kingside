import { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api';

interface DgtPlayer {
  fname: string | null;
  mname: string | null;
  lname: string | null;
  title: string | null;
  fideid: number | null;
}

interface DgtRoundInfo {
  count: number;
  live: number;
}

interface DgtTournament {
  id: string;
  name: string;
  location: string | null;
  country: string | null;
  timecontrol: string;
  chess960: string;
  rounds: DgtRoundInfo[];
}

interface DgtTournamentResult {
  uuid: string;
  tournament: DgtTournament;
  totalRounds: number;
}

interface DgtGame {
  roundIndex: number;
  gameIndex: number;
  white: DgtPlayer;
  black: DgtPlayer;
  result: string;
  pgn: string;
  moves: string[];
}

interface DgtRoundResult {
  uuid: string;
  roundIndex: number;
  games: DgtGame[];
}

type Phase =
  | { kind: 'input' }
  | { kind: 'loading-tournament' }
  | { kind: 'tournament'; data: DgtTournamentResult }
  | { kind: 'loading-round'; tournament: DgtTournamentResult; roundIndex: number }
  | { kind: 'round'; tournament: DgtTournamentResult; roundIndex: number; round: DgtRoundResult };

function formatPlayerName(player: DgtPlayer): string {
  const parts = [player.lname, player.fname].filter(Boolean);
  return parts.join(', ') || '?';
}

function formatResult(result: string): string {
  if (result === 'WHITEWIN') return '1-0';
  if (result === 'BLACKWIN') return '0-1';
  if (result === 'DRAW') return '½-½';
  if (result === '*') return '…';
  return result;
}

export function BroadcastsPage() {
  const { t } = useTranslation();
  const [urlInput, setUrlInput] = useState('');
  const [phase, setPhase] = useState<Phase>({ kind: 'input' });
  const [error, setError] = useState('');
  const [expandedGame, setExpandedGame] = useState<number | null>(null);

  const handleFetchTournament = useCallback(async () => {
    const trimmed = urlInput.trim();
    if (!trimmed) return;
    setError('');
    setExpandedGame(null);
    setPhase({ kind: 'loading-tournament' });
    try {
      const data = await api.get<DgtTournamentResult>(`/api/dgt/tournament/${encodeURIComponent(trimmed)}`);
      setPhase({ kind: 'tournament', data });
    } catch (err) {
      setError(err instanceof Error ? err.message : t('broadcasts.dgt.errorTournament'));
      setPhase({ kind: 'input' });
    }
  }, [urlInput, t]);

  const handleSelectRound = useCallback(async (tournament: DgtTournamentResult, roundIndex: number) => {
    setError('');
    setExpandedGame(null);
    setPhase({ kind: 'loading-round', tournament, roundIndex });
    try {
      const round = await api.get<DgtRoundResult>(
        `/api/dgt/tournament/${encodeURIComponent(tournament.uuid)}/round/${roundIndex}`,
      );
      setPhase({ kind: 'round', tournament, roundIndex, round });
    } catch (err) {
      setError(err instanceof Error ? err.message : t('broadcasts.dgt.errorRound'));
      setPhase({ kind: 'tournament', data: tournament });
    }
  }, [t]);

  const handleBackToTournament = useCallback(() => {
    if (phase.kind === 'round' || phase.kind === 'loading-round') {
      const tournament = phase.tournament;
      setExpandedGame(null);
      setError('');
      setPhase({ kind: 'tournament', data: tournament });
    }
  }, [phase]);

  const handleReset = useCallback(() => {
    setPhase({ kind: 'input' });
    setError('');
    setExpandedGame(null);
  }, []);

  const tournamentData =
    phase.kind === 'tournament' ? phase.data :
    phase.kind === 'loading-round' ? phase.tournament :
    phase.kind === 'round' ? phase.tournament :
    null;

  const isLoading = phase.kind === 'loading-tournament' || phase.kind === 'loading-round';

  return (
    <div className="broadcasts-page">
      <h1>{t('broadcasts.title')}</h1>

      {/* URL input */}
      <div className="dgt-input-row">
        <input
          type="text"
          className="dgt-url-input"
          placeholder={t('broadcasts.dgt.urlPlaceholder')}
          value={urlInput}
          onChange={(e) => setUrlInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && !isLoading && handleFetchTournament()}
          disabled={isLoading}
        />
        <button
          className="dgt-url-btn"
          onClick={handleFetchTournament}
          disabled={isLoading || !urlInput.trim()}
        >
          {isLoading && phase.kind === 'loading-tournament'
            ? t('common.loading')
            : t('broadcasts.dgt.load')}
        </button>
      </div>

      {error && <div className="error">{error}</div>}

      {/* Tournament info */}
      {tournamentData && (
        <div className="dgt-tournament">
          <div className="dgt-tournament-header">
            <div>
              <div className="dgt-tournament-name">{tournamentData.tournament.name}</div>
              {(tournamentData.tournament.location || tournamentData.tournament.country) && (
                <div className="dgt-tournament-meta">
                  {[tournamentData.tournament.location, tournamentData.tournament.country]
                    .filter(Boolean)
                    .join(', ')}
                </div>
              )}
              <div className="dgt-tournament-meta">
                {t('broadcasts.dgt.timeControl')}: {tournamentData.tournament.timecontrol}
                {' · '}
                {t('broadcasts.dgt.rounds')}: {tournamentData.totalRounds}
              </div>
            </div>
            <button className="dgt-reset-btn" onClick={handleReset}>
              {t('broadcasts.dgt.newTournament')}
            </button>
          </div>

          {/* Round selector */}
          {(phase.kind === 'tournament' || phase.kind === 'loading-round' || phase.kind === 'round') && (
            <div className="dgt-rounds-row">
              {Array.from({ length: tournamentData.totalRounds }, (_, i) => i + 1).map((r) => {
                const isActive =
                  (phase.kind === 'round' || phase.kind === 'loading-round') &&
                  phase.roundIndex === r;
                const isLoadingThis = phase.kind === 'loading-round' && phase.roundIndex === r;
                return (
                  <button
                    key={r}
                    className={`dgt-round-btn${isActive ? ' dgt-round-btn--active' : ''}`}
                    onClick={() => handleSelectRound(tournamentData, r)}
                    disabled={isLoadingThis}
                  >
                    {isLoadingThis ? '…' : `${t('broadcasts.dgt.round')} ${r}`}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Round games */}
      {phase.kind === 'round' && (
        <div className="dgt-games">
          <div className="dgt-games-header">
            <button className="dgt-back-btn" onClick={handleBackToTournament}>
              ← {t('broadcasts.dgt.backToRounds')}
            </button>
            <span className="dgt-games-title">
              {t('broadcasts.dgt.round')} {phase.roundIndex}
            </span>
          </div>

          {phase.round.games.length === 0 ? (
            <div className="broadcasts-empty">{t('broadcasts.dgt.noGames')}</div>
          ) : (
            <div className="dgt-games-list">
              {phase.round.games.map((game) => {
                const white = formatPlayerName(game.white);
                const black = formatPlayerName(game.black);
                const result = formatResult(game.result);
                const isExpanded = expandedGame === game.gameIndex;

                return (
                  <div key={game.gameIndex} className="dgt-game-card">
                    <div
                      className="dgt-game-header"
                      role="button"
                      tabIndex={0}
                      onClick={() => setExpandedGame(isExpanded ? null : game.gameIndex)}
                      onKeyDown={(e) =>
                        e.key === 'Enter' && setExpandedGame(isExpanded ? null : game.gameIndex)
                      }
                      aria-expanded={isExpanded}
                    >
                      <span className="dgt-game-board-num">#{game.gameIndex}</span>
                      <span className="dgt-game-players">
                        <span className="dgt-player dgt-player--white">♙ {white}</span>
                        <span className="dgt-game-result">{result}</span>
                        <span className="dgt-player dgt-player--black">♟ {black}</span>
                      </span>
                      <span className="dgt-game-toggle">{isExpanded ? '▲' : '▼'}</span>
                    </div>

                    {isExpanded && (
                      <div className="dgt-game-moves">
                        {game.moves.length === 0 ? (
                          <span className="dgt-game-moves-empty">
                            {t('broadcasts.dgt.noMoves')}
                          </span>
                        ) : (
                          <div className="dgt-moves-list">
                            {game.moves.map((move, idx) => (
                              <span key={idx} className="dgt-move-item">
                                {idx % 2 === 0 && (
                                  <span className="dgt-move-num">{Math.floor(idx / 2) + 1}.</span>
                                )}
                                <span className="dgt-move-san">{move}</span>
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
