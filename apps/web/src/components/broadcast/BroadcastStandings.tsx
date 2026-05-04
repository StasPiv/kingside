import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type {
  BroadcastBracketResponse,
  BroadcastGameSummary,
} from '@kingside/shared';

import { broadcastApi } from '../../api/broadcastApi';
import { openAnalysisFromPgn } from '../../utils/openAnalysisFromPgn';
import { BroadcastCrosstable } from './BroadcastCrosstable';
import { PlayoffBracket } from './PlayoffBracket';

/**
 * Вкладка Standings страницы трансляции (KS-1825).
 *
 * Сначала запрашивает `GET /broadcasts/:id/bracket` (KS-1824):
 *   - `tournamentType === 'playoff'` → рендерит сетку `<PlayoffBracket>`
 *     c `games`/`links` из ответа.
 *   - иначе — старый `<BroadcastCrosstable>` (round-robin/swiss/unknown).
 *
 * Ошибка `/bracket` — не блокирующая: показываем cross-table как
 * fallback (backend всегда вернёт что-нибудь, но CORS/503 бывают). Это
 * сохраняет регрессионную симметрию с до-KS-1825 поведением.
 */

interface BroadcastStandingsProps {
  broadcastId: string;
  broadcastTitle: string;
}

export function BroadcastStandings({
  broadcastId,
  broadcastTitle,
}: BroadcastStandingsProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const [bracket, setBracket] = useState<BroadcastBracketResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [errored, setErrored] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErrored(false);
    broadcastApi
      .get<BroadcastBracketResponse>(`/${broadcastId}/bracket`)
      .then((res) => {
        if (cancelled) return;
        setBracket(res);
      })
      .catch(() => {
        if (cancelled) return;
        setErrored(true);
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
    // KS-2403 follow-up: см. openAnalysisFromPgn.
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

  if (!errored && bracket?.tournamentType === 'playoff' && bracket.games.length > 0) {
    // `bracket.links` от backend игнорируем — на prod-данных они содержат
    // мусорные связи (R16-пары спарены по индексу, а не по реальному
    // игроку-победителю). `PlayoffBracket` сам деривирует линии из игр.
    return (
      <PlayoffBracket games={bracket.games} onGameClick={handleGameClick} />
    );
  }

  // Fallback (не-playoff, ошибка /bracket, или пустой playoff): старый
  // cross-table, чтобы страница не ломалась.
  return (
    <BroadcastCrosstable
      broadcastId={broadcastId}
      broadcastTitle={broadcastTitle}
    />
  );
}
