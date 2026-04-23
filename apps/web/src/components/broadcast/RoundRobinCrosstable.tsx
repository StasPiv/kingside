import type { CrosstableRoundRobin } from '@kingside/shared';

/**
 * KS-1737 / ADR-023 §2.10 (A13) — заглушка. Реализация в следующем тикете.
 *
 * Получает уже загруженный `CrosstableRoundRobin` из `<BroadcastCrosstable>`
 * (диспетчер выбирает компонент по `tournamentType`).
 */
export interface RoundRobinCrosstableProps {
  data: CrosstableRoundRobin;
  broadcastId: string;
  broadcastTitle: string;
}

export function RoundRobinCrosstable({ data }: RoundRobinCrosstableProps) {
  return (
    <div data-testid="round-robin-crosstable" className="broadcast-crosstable-placeholder">
      <p>Round-robin crosstable ({data.players.length} players) — coming soon (A13)</p>
    </div>
  );
}
