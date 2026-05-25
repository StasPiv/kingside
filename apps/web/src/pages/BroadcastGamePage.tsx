import { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { broadcastApi } from '../api/broadcastApi';
import { openAnalysisFromPgn } from '../utils/openAnalysisFromPgn';
import { ForfeitPlaceholder } from '../components/ForfeitPlaceholder';
import {
  isForfeitTermination,
  readPgnHeader,
} from '../utils/forfeitTermination';

/**
 * KS-2204: Тонкий загрузчик — загружает партию из broadcast-service
 * и перенаправляет на `/analysis` с PGN-состоянием, чтобы переиспользовать
 * полный layout мастерской (вкладки Ходы / Движок / Дерево).
 *
 * Паттерн аналогичен `BroadcastRoundPage.handleGameClick` — тот же navigate
 * с state: { pgn, title, breadcrumbRootTitle, breadcrumbRootUrl,
 * breadcrumbSection, breadcrumbBackUrl }.
 *
 * KS-3258 (3rd attempt): forfeit-партии (`[Termination "Unplayed"]`,
 * пустой movetext) НЕ редиректим на /analysis — там UI анализа
 * бесполезен (нет ходов, нет позиций), и плашка терялась в pipeline
 * `openAnalysisFromPgn → POST /analyses → AnalysisPage → getById`
 * (backend нормализует PGN и может не сохранять Termination header).
 * Вместо этого рисуем full-page плашку с breadcrumb обратно к
 * раунду — короткий и понятный UX «партия не игралась».
 */

type LichessGame = {
  id: string;
  whitePlayer: string;
  blackPlayer: string;
  result: string | null;
  pgn: string | null;
  currentFen: string | null;
  /** KS-3261: lichess id для dedup на backend'е. */
  lichessGameId?: string | null;
};

type BroadcastMeta = {
  id: string;
  title: string;
};

type ForfeitState = {
  pgn: string;
  meta: BroadcastMeta;
  roundName: string;
  game: LichessGame;
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
  // KS-3258: state для forfeit-партий, которые мы не редиректим.
  const [forfeit, setForfeit] = useState<ForfeitState | null>(null);
  const [error, setError] = useState<string | null>(null);

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

        const rounds = Array.isArray(roundsRes?.data) ? roundsRes.data : [];
        const roundName = rounds.find((r) => r.id === roundId)?.name ?? '';
        const games = Array.isArray(gamesRes?.data) ? gamesRes.data : [];
        const game = games.find((g) => g.id === gameId) ?? null;

        // KS-3258 (3rd attempt): forfeit-детектор ДО редиректа на /analysis.
        // PGN от broadcast-service содержит [Termination "Unplayed"] + Result,
        // но pipeline через POST /analyses теряет эти headers — пользователь
        // видит «No moves» вместо плашки. Останавливаемся здесь и рисуем
        // плашку без UI анализа (он для пустой партии бесполезен).
        //
        // STRICT-проверка: только по `[Termination ...]` (без Result-fallback
        // из общего `isForfeitGame`). Здесь у нас НЕТ history.length, и Result
        // не "*" — это норма для любой сыгранной партии. Lichess для forfeit
        // ВСЕГДА выставляет `[Termination "Unplayed"|"Forfeit"|"Walkover"|
        // "Default"]`, см. реальный PGN партии NZDd3BWL.
        const terminationHeader = game?.pgn
          ? readPgnHeader(game.pgn, 'Termination')
          : null;
        if (game?.pgn && isForfeitTermination(terminationHeader)) {
          navigatedRef.current = true;
          setForfeit({ pgn: game.pgn, meta, roundName, game });
          return;
        }

        navigatedRef.current = true;

        // KS-2403 follow-up: переход через openAnalysisFromPgn создаёт
        // analysis-запись и идёт на /analysis/<id>, чтобы при следующем
        // клике из этого же broadcast компонент AnalysisPage
        // пересоздавался по key={id} и autosave не перезаписывал чужую
        // запись. Если pgn нет (game не нашёлся) — переход на пустой
        // /analysis, как было.
        if (game?.pgn) {
          // KS-3261: пробрасываем lichessGameId для dedup. Backend
          // (1b18d16f) проверит — если у юзера уже есть analysis с тем
          // же lichessGameId, вернёт existing=true и обновит
          // lastOpenedAt, не создаст дубль.
          const lichessGameId =
            (game as { lichessGameId?: string }).lichessGameId ?? undefined;
          void openAnalysisFromPgn(navigate, {
            pgn: game.pgn,
            title: `${game.whitePlayer} vs ${game.blackPlayer}`,
            replace: true,
            lichessGameId,
            state: {
              breadcrumbRootTitle: meta.title,
              breadcrumbRootUrl: `/broadcasts/${tournamentId}`,
              breadcrumbSection: roundName || undefined,
              breadcrumbBackUrl: `/broadcasts/${tournamentId}/${roundId}`,
            },
            // KS-3333: локализация alert при ошибке POST /analyses.
            t,
          });
        } else {
          navigate('/analysis', { replace: true });
        }
      })
      .catch(() => {
        if (navigatedRef.current) return;
        navigatedRef.current = true;
        setError(t('broadcastLive.notFound', 'Game not found'));
      });
  }, [tournamentId, roundId, gameId, navigate, t]);

  // KS-3258: forfeit-страница. Рендерится вместо редиректа.
  if (forfeit) {
    const playersTitle = `${forfeit.game.whitePlayer || '?'} — ${forfeit.game.blackPlayer || '?'}`;
    return (
      <div
        className="broadcast-game-forfeit-page"
        data-testid="broadcast-game-forfeit-page"
      >
        <nav
          className="broadcast-game-forfeit-page__breadcrumbs"
          aria-label={t('common.breadcrumbs', 'Breadcrumbs')}
        >
          <Link to={`/broadcasts/${tournamentId}`}>{forfeit.meta.title}</Link>
          {forfeit.roundName && (
            <>
              <span aria-hidden="true"> / </span>
              <Link to={`/broadcasts/${tournamentId}/${roundId}`}>
                {forfeit.roundName}
              </Link>
            </>
          )}
        </nav>
        <h1 className="broadcast-game-forfeit-page__title">{playersTitle}</h1>
        <ForfeitPlaceholder
          pgn={forfeit.pgn}
          testId="broadcast-game-forfeit-placeholder"
        />
      </div>
    );
  }

  if (error) {
    return (
      <div
        className="broadcast-game-forfeit-page"
        data-testid="broadcast-game-error"
      >
        <p>{error}</p>
      </div>
    );
  }

  return <div className="loading">{t('common.loading')}</div>;
}
