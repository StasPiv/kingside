import { useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { broadcastApi } from '../api/broadcastApi';
import { openAnalysisFromPgn } from '../utils/openAnalysisFromPgn';

/**
 * KS-2204: Тонкий загрузчик — загружает партию из broadcast-service
 * и перенаправляет на `/analysis` с PGN-состоянием, чтобы переиспользовать
 * полный layout мастерской (вкладки Ходы / Движок / Дерево).
 *
 * Паттерн аналогичен `BroadcastRoundPage.handleGameClick` — тот же navigate
 * с state: { pgn, title, breadcrumbRootTitle, breadcrumbRootUrl,
 * breadcrumbSection, breadcrumbBackUrl }.
 */

type LichessGame = {
  id: string;
  whitePlayer: string;
  blackPlayer: string;
  result: string | null;
  pgn: string | null;
  currentFen: string | null;
};

type BroadcastMeta = {
  id: string;
  title: string;
};

export function BroadcastGamePage() {
  const { tournamentId, roundId, gameId } = useParams<{
    tournamentId: string;
    roundId: string;
    gameId: string;
  }>();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const navigatedRef = useRef(false);

  useEffect(() => {
    if (!tournamentId || !roundId || !gameId) return;
    if (navigatedRef.current) return;

    Promise.all([
      broadcastApi.get<BroadcastMeta>(`/${tournamentId}`),
      broadcastApi.get<{ data: Array<{ id: string; name: string }> }>(`/${tournamentId}/rounds`),
      broadcastApi.get<{ data: LichessGame[] }>(`/${tournamentId}/rounds/${roundId}/games`),
    ])
      .then(([meta, roundsRes, gamesRes]) => {
        if (navigatedRef.current) return;
        navigatedRef.current = true;

        const rounds = Array.isArray(roundsRes?.data) ? roundsRes.data : [];
        const roundName = rounds.find((r) => r.id === roundId)?.name ?? '';
        const games = Array.isArray(gamesRes?.data) ? gamesRes.data : [];
        const game = games.find((g) => g.id === gameId) ?? null;

        // KS-2403 follow-up: переход через openAnalysisFromPgn создаёт
        // analysis-запись и идёт на /analysis/<id>, чтобы при следующем
        // клике из этого же broadcast компонент AnalysisPage
        // пересоздавался по key={id} и autosave не перезаписывал чужую
        // запись. Если pgn нет (game не нашёлся) — переход на пустой
        // /analysis, как было.
        if (game?.pgn) {
          void openAnalysisFromPgn(navigate, {
            pgn: game.pgn,
            title: `${game.whitePlayer} vs ${game.blackPlayer}`,
            replace: true,
            state: {
              breadcrumbRootTitle: meta.title,
              breadcrumbRootUrl: `/broadcasts/${tournamentId}`,
              breadcrumbSection: roundName || undefined,
              breadcrumbBackUrl: `/broadcasts/${tournamentId}/${roundId}`,
            },
          });
        } else {
          navigate('/analysis', { replace: true });
        }
      })
      .catch(() => {
        if (navigatedRef.current) return;
        navigatedRef.current = true;
        navigate('/analysis', { replace: true });
      });
  }, [tournamentId, roundId, gameId, navigate]);

  return <div className="loading">{t('common.loading')}</div>;
}
