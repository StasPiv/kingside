import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type {
  BroadcastBracketResponse,
  BroadcastGameSummary,
  BroadcastRoundsResponse,
  BroadcastRoundItem,
} from '@kingside/shared';

import { broadcastApi } from '../../api/broadcastApi';
import { openAnalysisFromPgn } from '../../utils/openAnalysisFromPgn';
import { BroadcastCrosstable } from './BroadcastCrosstable';
import { PlayoffBracket } from './PlayoffBracket';

/**
 * Вкладка Standings страницы трансляции (KS-1825 → KS-2567).
 *
 * KS-2567: для гибридных турниров (Round Robin / Swiss + Playoff,
 * напр. Norway Chess: круг + тайбрейки между лидерами) показываем ОБЕ
 * секции стэком — `<BroadcastCrosstable>` сверху, `<PlayoffBracket>`
 * под ним. До тикета был either-or, и при `tournamentType='playoff'`
 * круговая таблица первого этапа полностью пряталась.
 *
 * Источники данных (бэкенд KS-2564, контракт подтверждён `[from
 * backend · ACK]`):
 *  - `GET /broadcasts/:id/rounds` — детектор гибрида: `tournamentType`
 *    у каждого раунда. `hasMain = round_robin|swiss`, `hasPlayoff =
 *    playoff`.
 *  - `GET /broadcasts/:id/bracket` — playoff-партии (только playoff,
 *    `games[]` отфильтрован по соответствующим раундам).
 *  - `GET /broadcasts/:id/crosstable` — основная круговая (KS-2564
 *    исключил playoff-раунды из расчёта).
 *
 * Решение по рендеру:
 *   hasMain && hasPlayoff   → крестик + плей-офф (гибрид)
 *   hasMain && !hasPlayoff  → только крестик (классический RR/Swiss)
 *  !hasMain && hasPlayoff   → только плей-офф (single-stage knockout,
 *                              «либо-либо» по уточнению координатора)
 *   ни тот, ни другой       → fallback на крестик (legacy/unknown)
 *
 * Ошибки `/bracket` или `/rounds` — не блокирующие: показываем
 * крестик-фоллбек, чтобы страница не ломалась (как и до KS-2567).
 */

interface BroadcastStandingsProps {
  broadcastId: string;
  broadcastTitle: string;
}

function detectHybrid(rounds: BroadcastRoundItem[] | null): {
  hasMain: boolean;
  hasPlayoff: boolean;
} {
  if (!rounds || rounds.length === 0)
    return { hasMain: false, hasPlayoff: false };
  let hasMain = false;
  let hasPlayoff = false;
  for (const r of rounds) {
    if (r.tournamentType === 'round_robin' || r.tournamentType === 'swiss') {
      hasMain = true;
    } else if (r.tournamentType === 'playoff') {
      hasPlayoff = true;
    }
    if (hasMain && hasPlayoff) break;
  }
  return { hasMain, hasPlayoff };
}

export function BroadcastStandings({
  broadcastId,
  broadcastTitle,
}: BroadcastStandingsProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const [bracket, setBracket] = useState<BroadcastBracketResponse | null>(null);
  const [rounds, setRounds] = useState<BroadcastRoundItem[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [errored, setErrored] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErrored(false);
    // Параллельно тянем bracket + rounds. Crosstable загружает себя
    // сам через `useBroadcastCrosstable`.
    Promise.allSettled([
      broadcastApi.get<BroadcastBracketResponse>(`/${broadcastId}/bracket`),
      broadcastApi.get<BroadcastRoundsResponse>(`/${broadcastId}/rounds`),
    ])
      .then(([bracketRes, roundsRes]) => {
        if (cancelled) return;
        if (bracketRes.status === 'fulfilled') setBracket(bracketRes.value);
        else setErrored(true);
        if (roundsRes.status === 'fulfilled') setRounds(roundsRes.value.data);
        // /rounds error не блокирующий — fallback hybrid-detection
        // через bracket.tournamentType ниже.
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [broadcastId]);

  const handleGameClick = (game: BroadcastGameSummary) => {
    if (!game.pgn) return;
    void openAnalysisFromPgn(navigate, {
      pgn: game.pgn,
      title: `${game.whitePlayer ?? ''} vs ${game.blackPlayer ?? ''}`,
      state: {
        breadcrumbRootTitle: broadcastTitle,
        breadcrumbRootUrl: `/broadcasts/${broadcastId}`,
      },
    });
  };

  if (loading) {
    return (
      <div className="loading" data-testid="broadcast-standings-loading">
        {t('common.loading')}
      </div>
    );
  }

  const { hasMain, hasPlayoff: hasPlayoffByRounds } = detectHybrid(rounds);
  const playoffGames = bracket?.games ?? [];
  // Если /rounds упал, опираемся на bracket: tournamentType='playoff'
  // означает, что есть хотя бы один playoff-раунд.
  const hasPlayoff =
    hasPlayoffByRounds || (bracket?.tournamentType === 'playoff' && playoffGames.length > 0);
  const showBracket =
    !errored && hasPlayoff && playoffGames.length > 0;
  // KS-2567 (по уточнению координатора): крестик скрываем только для
  // single-stage knockout (есть playoff и нет main). В остальных
  // случаях (гибрид или RR/Swiss only или unknown) — рендерим крестик.
  const showCrosstable = !(hasPlayoff && !hasMain);

  return (
    <div className="broadcast-standings" data-testid="broadcast-standings">
      {showCrosstable && (
        <BroadcastCrosstable
          broadcastId={broadcastId}
          broadcastTitle={broadcastTitle}
        />
      )}
      {showBracket && (
        <section
          className="broadcast-playoff-section"
          data-testid="broadcast-playoff-section"
        >
          {/* Заголовок секции виден только когда выше уже есть круговая —
              чтобы не дублировать “Тайбрейки” над одиночным бракетом. */}
          {showCrosstable && (
            <h2 className="broadcast-playoff-section__title">
              {t('broadcast.playoff.title', 'Playoff')}
            </h2>
          )}
          <PlayoffBracket
            games={playoffGames}
            onGameClick={handleGameClick}
          />
        </section>
      )}
    </div>
  );
}
