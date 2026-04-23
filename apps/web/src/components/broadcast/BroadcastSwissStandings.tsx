import type { CrosstableSwiss } from '@kingside/shared';

/**
 * KS-1738 / ADR-023 §2.10 (A14) — заглушка. Реализация в следующем тикете.
 *
 * Получает уже загруженный `CrosstableSwiss` из `<BroadcastCrosstable>`.
 */
export interface BroadcastSwissStandingsProps {
  data: CrosstableSwiss;
  broadcastId: string;
  broadcastTitle: string;
}

export function BroadcastSwissStandings({ data }: BroadcastSwissStandingsProps) {
  return (
    <div data-testid="broadcast-swiss-standings" className="broadcast-crosstable-placeholder">
      <p>
        Swiss standings ({data.players.length} players, {data.roundCount} rounds) — coming soon (A14)
      </p>
    </div>
  );
}
