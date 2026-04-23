import { useTranslation } from 'react-i18next';
import { useBroadcastCrosstable } from '../../hooks/useBroadcastCrosstable';
import { LegacyStandings } from './LegacyStandings';
import { RoundRobinCrosstable } from './RoundRobinCrosstable';
import { BroadcastSwissStandings } from './BroadcastSwissStandings';
import { TeamStandings } from './TeamStandings';

/**
 * KS-1736 / ADR-023 §2.10 (A12) — диспетчер crosstable для broadcast'а.
 *
 * Загружает `GET /:id/crosstable` через `useBroadcastCrosstable` и по
 * `response.tournamentType` выбирает нужный рендер:
 *
 *   - `round-robin`                         → `<RoundRobinCrosstable>` (A13)
 *   - `swiss`                               → `<BroadcastSwissStandings>` (A14)
 *   - `team-swiss` | `team-round-robin`     → `<TeamStandings>` (A15)
 *   - `unknown`                             → `<LegacyStandings>` (текущий рендер)
 *
 * При ошибке загрузки — также fallback на `<LegacyStandings>` (чтобы у
 * пользователя не пропадал экран при временных сбоях chess-results).
 */
export interface BroadcastCrosstableProps {
  broadcastId: string;
  broadcastTitle: string;
}

export function BroadcastCrosstable({ broadcastId, broadcastTitle }: BroadcastCrosstableProps) {
  const { t } = useTranslation();
  const { data, loading, error } = useBroadcastCrosstable(broadcastId);

  if (loading) {
    return (
      <p className="broadcast-tab-empty" data-testid="broadcast-crosstable-loading">
        {t('broadcast.crosstable.loading', 'Loading standings…')}
      </p>
    );
  }

  if (error || !data) {
    // Fallback на legacy-рендер — всегда пытается показать таблицу из broadcast_games.
    return <LegacyStandings tournamentId={broadcastId} broadcastTitle={broadcastTitle} />;
  }

  switch (data.tournamentType) {
    case 'round-robin':
      return <RoundRobinCrosstable data={data} broadcastId={broadcastId} broadcastTitle={broadcastTitle} />;
    case 'swiss':
      return <BroadcastSwissStandings data={data} broadcastId={broadcastId} broadcastTitle={broadcastTitle} />;
    case 'team-swiss':
    case 'team-round-robin':
      return <TeamStandings data={data} broadcastId={broadcastId} broadcastTitle={broadcastTitle} />;
    case 'unknown':
    default:
      return <LegacyStandings tournamentId={broadcastId} broadcastTitle={broadcastTitle} />;
  }
}
