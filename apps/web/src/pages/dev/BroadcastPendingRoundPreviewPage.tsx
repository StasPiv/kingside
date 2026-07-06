import { useMemo, useState } from 'react';
import type { BroadcastGameSummary, BroadcastRoundItem } from '@kingside/shared';
import { RoundCountdown } from '../../components/broadcast/RoundCountdown';
import { PairingCard } from '../../components/broadcast/PairingCard';
import { BroadcastBoardCard } from '../../components/broadcast/BroadcastBoardCard';
import { useTranslation } from 'react-i18next';

/**
 * KS-4848 / ADR-158: dev-only preview всех трёх состояний страницы
 * не начавшегося раунда трансляции. Локальный broadcast-service в dev
 * не поднят — этот роут нужен для визуальной верификации UI без
 * зависимости от backend.
 *
 * URL: /__dev/broadcast-pending-round
 */
export default function BroadcastPendingRoundPreviewPage() {
  const { t } = useTranslation();
  const [offsetSec, setOffsetSec] = useState<number>(3 * 3600); // «через 3 часа»

  const startsAt = useMemo(
    () => new Date(Date.now() + offsetSec * 1000).toISOString(),
    [offsetSec],
  );

  const pendingRound: BroadcastRoundItem = {
    id: 'r1',
    lichessRoundId: 'lr1',
    name: 'Round 5',
    startsAt,
    status: 'pending',
    tournamentType: 'swiss',
  };

  const pairings: BroadcastGameSummary[] = [
    makeGame('g1', 'Carlsen, Magnus', 2830, 'Nakamura, Hikaru', 2789),
    makeGame('g2', 'Nepomniachtchi, Ian', 2795, 'Firouzja, Alireza', 2762),
    makeGame('g3', 'Caruana, Fabiano', 2803, 'Ding, Liren', 2780),
    makeGame('g4', 'Giri, Anish', 2760, 'Praggnanandhaa, R', 2744),
    makeGame('g5', 'Erigaisi, Arjun', 2768, 'Gukesh, D', 2775),
    makeGame('g6', 'So, Wesley', 2757, 'Vachier-Lagrave, M', 2732),
  ];

  const awaitingGame = makeGame('gA', 'Alpha', 2600, 'Beta', 2620);

  return (
    <div className="broadcast-round-page" style={{ maxWidth: 1200, margin: '0 auto', padding: 16 }}>
      <h1 style={{ color: '#eee' }}>KS-4848 / ADR-158 — Pending round UX preview</h1>

      <fieldset
        style={{
          padding: 12,
          margin: '16px 0',
          border: '1px solid #333',
          borderRadius: 8,
          color: '#eee',
        }}
      >
        <legend>Time to start</legend>
        <label style={{ marginRight: 16 }}>
          <input
            type="radio"
            checked={offsetSec === 3 * 86400}
            onChange={() => setOffsetSec(3 * 86400)}
          />{' '}
          3 days
        </label>
        <label style={{ marginRight: 16 }}>
          <input
            type="radio"
            checked={offsetSec === 3 * 3600}
            onChange={() => setOffsetSec(3 * 3600)}
          />{' '}
          3 hours
        </label>
        <label style={{ marginRight: 16 }}>
          <input
            type="radio"
            checked={offsetSec === 20 * 60}
            onChange={() => setOffsetSec(20 * 60)}
          />{' '}
          20 minutes
        </label>
        <label style={{ marginRight: 16 }}>
          <input
            type="radio"
            checked={offsetSec === 2 * 60 + 30}
            onChange={() => setOffsetSec(2 * 60 + 30)}
          />{' '}
          2:30
        </label>
        <label style={{ marginRight: 16 }}>
          <input
            type="radio"
            checked={offsetSec === -300}
            onChange={() => setOffsetSec(-300)}
          />{' '}
          -5 min (overdue)
        </label>
      </fieldset>

      <section
        data-preview="A"
        style={{ marginBottom: 32, borderTop: '1px solid #333', paddingTop: 16 }}
      >
        <h2 style={{ color: '#eee' }}>State A — pending, pairings present</h2>
        <div className="broadcast-pending-section">
          <div className="broadcast-pending-header">
            <span className="broadcast-pending-badge">
              {t('broadcastRound.pending.upcomingBadge', 'Upcoming')}
            </span>
            <RoundCountdown startsAt={pendingRound.startsAt} />
          </div>
          <div className="broadcast-pairings-grid">
            {pairings.map((g) => (
              <PairingCard key={g.id} game={g} />
            ))}
          </div>
        </div>
      </section>

      <section
        data-preview="A-empty"
        style={{ marginBottom: 32, borderTop: '1px solid #333', paddingTop: 16 }}
      >
        <h2 style={{ color: '#eee' }}>State A — pending, no pairings yet</h2>
        <div className="broadcast-pending-section">
          <div className="broadcast-pending-header">
            <span className="broadcast-pending-badge">
              {t('broadcastRound.pending.upcomingBadge', 'Upcoming')}
            </span>
            <RoundCountdown startsAt={pendingRound.startsAt} />
          </div>
          <div className="broadcasts-empty broadcast-pending-empty">
            {t('broadcastRound.pending.pairingsNotAnnounced', 'Pairings not announced yet')}
          </div>
        </div>
      </section>

      <section
        data-preview="B"
        style={{ marginBottom: 32, borderTop: '1px solid #333', paddingTop: 16 }}
      >
        <h2 style={{ color: '#eee' }}>State B — ongoing, awaiting first moves</h2>
        <div className="broadcast-awaiting-first-moves">
          <span className="broadcast-awaiting-first-moves__spinner" aria-hidden />
          <span className="broadcast-awaiting-first-moves__text">
            {t(
              'broadcastRound.ongoing.awaitingFirstMoves',
              'Round has started, waiting for the first moves…',
            )}
          </span>
        </div>
      </section>

      <section
        data-preview="C"
        style={{ marginBottom: 32, borderTop: '1px solid #333', paddingTop: 16 }}
      >
        <h2 style={{ color: '#eee' }}>State C — ongoing, board with «Game starts soon»</h2>
        <div className="broadcast-boards-grid" style={{ maxWidth: 480 }}>
          <BroadcastBoardCard game={awaitingGame} />
        </div>
      </section>
    </div>
  );
}

function makeGame(
  id: string,
  whitePlayer: string,
  whiteElo: number | null,
  blackPlayer: string,
  blackElo: number | null,
): BroadcastGameSummary {
  return {
    id,
    lichessGameId: `lg-${id}`,
    whitePlayer,
    blackPlayer,
    whiteElo,
    blackElo,
    result: null,
    pgn: null,
    currentFen: null,
    updatedAt: new Date(0).toISOString(),
    bracketStage: null,
    bracketPairId: null,
    matchScore: null,
  };
}
