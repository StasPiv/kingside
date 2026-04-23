import type { CrosstableTeam } from '@kingside/shared';

/**
 * KS-1739 / ADR-023 §2.10 (A15) — заглушка. Реализация в следующем тикете.
 *
 * Получает уже загруженный `CrosstableTeam` (team-swiss | team-round-robin)
 * из `<BroadcastCrosstable>`.
 */
export interface TeamStandingsProps {
  data: CrosstableTeam;
  broadcastId: string;
  broadcastTitle: string;
}

export function TeamStandings({ data }: TeamStandingsProps) {
  return (
    <div data-testid="team-standings" className="broadcast-crosstable-placeholder">
      <p>
        Team standings ({data.tournamentType}, {data.teams.length} teams) — coming soon (A15)
      </p>
    </div>
  );
}
