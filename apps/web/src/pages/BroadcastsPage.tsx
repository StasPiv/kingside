import { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Chess } from 'chess.js';
import { Chessboard } from 'react-chessboard';
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

function computeFen(pgn: string, moves: string[]): string {
  if (pgn) {
    try {
      const chess = new Chess();
      chess.loadPgn(pgn);
      return chess.fen();
    } catch {
      // fall through to moves-based computation
    }
  }
  if (moves.length > 0) {
    try {
      const chess = new Chess();
      for (const move of moves) {
        chess.move(move);
      }
      return chess.fen();
    } catch {
      // fall through to default
    }
  }
  return 'start';
}

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

  const handleFetchTournament = useCallback(async () => {
    const trimmed = urlInput.trim();
    if (!trimmed) return;
    setError('');
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
      setError('');
      setPhase({ kind: 'tournament', data: tournament });
    }
  }, [phase]);

  const handleReset = useCallback(() => {
    setPhase({ kind: 'input' });
    setError('');
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

      {/* Round boards grid */}
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
            <div className="dgt-boards-grid">
              {phase.round.games.map((game) => {
                const white = formatPlayerName(game.white);
                const black = formatPlayerName(game.black);
                const result = formatResult(game.result);
                const fen = computeFen(game.pgn, game.moves);

                return (
                  <div key={game.gameIndex} className="dgt-board-card">
                    <div className="dgt-board-players">
                      <span className="dgt-player dgt-player--black">♟ {black}</span>
                    </div>
                    <div className="dgt-board-wrap">
                      <Chessboard
                        options={{
                          position: fen,
                          allowDragging: false,
                          showNotation: false,
                          animationDurationInMs: 0,
                        }}
                      />
                    </div>
                    <div className="dgt-board-players">
                      <span className="dgt-player dgt-player--white">♙ {white}</span>
                    </div>
                    <div className="dgt-board-footer">
                      <span className="dgt-game-board-num">#{game.gameIndex}</span>
                      <span className="dgt-game-result">{result}</span>
                    </div>
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
