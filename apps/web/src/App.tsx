import { lazy, Suspense, useState, useEffect } from 'react';
import { Routes, Route, Navigate, useLocation, useSearchParams, useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { MainLayout } from './layouts/MainLayout';
import { LoginPage } from './pages/LoginPage';
import { FeaturesPage } from './pages/FeaturesPage';
import { RegisterPage } from './pages/RegisterPage';
import { LobbyPage } from './pages/LobbyPage';
import { GamePage } from './pages/GamePage';
import { SettingsPage } from './pages/SettingsPage';
import { DailyPuzzlePage } from './pages/DailyPuzzlePage';
import { PuzzleBrowserPage } from './pages/PuzzleBrowserPage';
import { PuzzleStatsPage } from './pages/PuzzleStatsPage';
import { PuzzlePage } from './pages/PuzzlePage';
import { PuzzleRushLeaderboardPage } from './pages/PuzzleRushLeaderboardPage';
import { PuzzleRushReviewPage } from './pages/PuzzleRushReviewPage';
import { WorkshopPage } from './pages/WorkshopPage';
import { BroadcastsPage } from './pages/BroadcastsPage';
import { BroadcastTournamentPage } from './pages/BroadcastTournamentPage';
import { BroadcastRoundPage } from './pages/BroadcastRoundPage';
import { PlayersPage } from './pages/PlayersPage';
import { PlayerProfilePage } from './pages/PlayerProfilePage';
import { MessagesPage } from './pages/MessagesPage';
import { LiveGamesPage } from './pages/LiveGamesPage';
import { WatchGamePage } from './pages/WatchGamePage';
import { ExternalEngineHelpPage } from './pages/ExternalEngineHelpPage';
import { OAuthCallbackPage } from './pages/OAuthCallbackPage';
import { FriendsPage } from './pages/FriendsPage';
import { TournamentsPage } from './pages/TournamentsPage';
import { TournamentLobbyPage } from './pages/TournamentLobbyPage';
import { DevBypassPage } from './pages/DevBypassPage';
import { PlayPage } from './pages/PlayPage';
import { FeedbackBoardPage } from './pages/FeedbackBoardPage';
import { FeedbackDetailPage } from './pages/FeedbackDetailPage';
import { LessonsPage } from './pages/LessonsPage';
import { CoursePage } from './pages/CoursePage';
import { LessonPage } from './pages/LessonPage';
import { MistakesPage } from './pages/MistakesPage';
import { MistakesPracticePage } from './pages/MistakesPracticePage';
import { LessonEditorPage } from './pages/LessonEditorPage';
import { UserCourseEditor } from './components/lessons/editor/user/UserCourseEditor';
import { UserCoursePage } from './pages/UserCoursePage';
import { UserLessonPage } from './pages/UserLessonPage';
import { useAuth } from './context/AuthContext';
import { api } from './api';
import { isLessonsEnabledLive } from './config/featureFlags';

// Lazy-loaded heavy pages
const AnalysisPage = lazy(() => import('./pages/AnalysisPage').then(m => ({ default: m.AnalysisPage })));
const BroadcastGamePage = lazy(() => import('./pages/BroadcastGamePage').then(m => ({ default: m.BroadcastGamePage })));
const PuzzleRushPage = lazy(() => import('./pages/PuzzleRushPage').then(m => ({ default: m.PuzzleRushPage })));
const ArchiveGamesByPositionPage = lazy(() =>
  import('./pages/ArchiveGamesByPositionPage').then(m => ({ default: m.ArchiveGamesByPositionPage })),
);

// KS-1821: dev-маршруты за compile-time guard `import.meta.env.DEV`.
// Vite при prod-сборке инлайнит константу в `false`, тернарник сворачивается
// в `null`, вложенный `import('./dev/DevRoutes')` становится мёртвым ещё до
// rollup'а — вся поддерево dev-страниц (включая `DevReviewsUiPage`,
// `DevPlayoffBracketPage` и т.д.) tree-shake'ается и в prod-бандл не
// попадает ни чанком, ни ссылкой.
const DevRoutesLazy = import.meta.env.DEV
  ? lazy(() => import('./dev/DevRoutes'))
  : null;

function LazyFallback() {
  const { t } = useTranslation();
  return <div className="loading">{t('common.loading')}</div>;
}

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const { t } = useTranslation();
  const location = useLocation();

  if (loading) return <div className="loading">{t('common.loading')}</div>;
  if (!user) return <Navigate to="/login" state={{ returnUrl: location.pathname }} replace />;
  return <>{children}</>;
}

function GuestRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const { t } = useTranslation();
  if (loading) return <div className="loading">{t('common.loading')}</div>;
  if (user) return <Navigate to="/lobby" replace />;
  return <>{children}</>;
}

function HomePage() {
  const { user, loading } = useAuth();
  const { t } = useTranslation();
  if (loading) return <div className="loading">{t('common.loading')}</div>;
  return user ? <Navigate to="/lobby" replace /> : <FeaturesPage />;
}

function ProfileRedirect() {
  const { user } = useAuth();
  if (!user) return <Navigate to="/" replace />;
  return <Navigate to={`/player/${user.username}`} replace />;
}

function InviteRedirect() {
  const { code } = useParams<{ code: string }>();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!code) return;
    api.post<{ tournamentId: string }>(`/arena/invite/${code}`, {})
      .then((data) => navigate(`/tournaments/${data.tournamentId}`, { replace: true }))
      .catch(() => setError(t('tournaments.inviteInvalid', 'Invalid or expired invite link')));
  }, [code, navigate, t]);

  if (error) return <div className="error">{error}</div>;
  return <div className="loading">{t('common.loading')}</div>;
}

export function App() {
  const [searchParams] = useSearchParams();
  const devSecret = import.meta.env.VITE_DEV_BYPASS_SECRET;

  const location = useLocation();

  if (devSecret && searchParams.has('dev_bypass')) {
    const returnParams = new URLSearchParams(searchParams);
    returnParams.delete('dev_bypass');
    returnParams.delete('user');
    const returnSearch = returnParams.toString();
    const returnTo = returnSearch ? `${location.pathname}?${returnSearch}` : location.pathname;
    return <DevBypassPage secret={searchParams.get('dev_bypass') ?? ''} user={searchParams.get('user') ?? undefined} returnTo={returnTo} />;
  }

  return (
    <Routes>
      <Route element={<MainLayout />}>
        <Route index element={<HomePage />} />
        <Route path="/features" element={<FeaturesPage />} />
        <Route path="/login" element={<GuestRoute><LoginPage /></GuestRoute>} />
        <Route path="/register" element={<GuestRoute><RegisterPage /></GuestRoute>} />
        <Route path="/oauth/callback" element={<OAuthCallbackPage />} />
        <Route path="/lobby" element={<LobbyPage />} />
        <Route path="/play" element={<ProtectedRoute><PlayPage /></ProtectedRoute>} />
        <Route path="/games/live" element={<LiveGamesPage />} />
        <Route path="/games/:id/watch" element={<WatchGamePage />} />
        <Route path="/game/:id" element={<ProtectedRoute><GamePage /></ProtectedRoute>} />
        <Route path="/game/:gameId/review" element={<Suspense fallback={<LazyFallback />}><AnalysisPage /></Suspense>} />
        <Route path="/settings" element={<ProtectedRoute><SettingsPage /></ProtectedRoute>} />
        <Route path="/daily" element={<DailyPuzzlePage />} />
        <Route path="/puzzle-rush" element={<ProtectedRoute><Suspense fallback={<LazyFallback />}><PuzzleRushPage /></Suspense></ProtectedRoute>} />
        <Route path="/puzzle-rush/leaderboard" element={<PuzzleRushLeaderboardPage />} />
        <Route path="/puzzle-rush/review/:scoreId" element={<ProtectedRoute><PuzzleRushReviewPage /></ProtectedRoute>} />
        <Route path="/puzzles/rush" element={<Navigate to="/puzzle-rush" replace />} />
        <Route path="/puzzles" element={<PuzzleBrowserPage />} />
        <Route path="/puzzles/stats" element={<PuzzleStatsPage />} />
        {isLessonsEnabledLive() ? (
          <>
            <Route path="/lessons" element={<ProtectedRoute><LessonsPage /></ProtectedRoute>} />
            <Route path="/lessons/editor" element={<ProtectedRoute><LessonEditorPage /></ProtectedRoute>} />
            <Route path="/lessons/my/:slug/edit" element={<ProtectedRoute><UserCourseEditor /></ProtectedRoute>} />
            <Route path="/lessons/my/:slug" element={<UserCoursePage />} />
            <Route path="/lessons/my/:slug/:lessonId" element={<ProtectedRoute><UserLessonPage /></ProtectedRoute>} />
            <Route path="/lessons/mistakes" element={<ProtectedRoute><MistakesPage /></ProtectedRoute>} />
            <Route path="/lessons/mistakes-practice" element={<ProtectedRoute><MistakesPracticePage /></ProtectedRoute>} />
            <Route path="/lessons/:courseSlug" element={<ProtectedRoute><CoursePage /></ProtectedRoute>} />
            <Route path="/lessons/:courseSlug/:lessonSlug" element={<ProtectedRoute><LessonPage /></ProtectedRoute>} />
          </>
        ) : (
          // KS-1820: при выключенном флаге все lessons-маршруты
          // редиректят на корень (не просто 404 — чтобы пользователь
          // из старых ссылок не застревал).
          <Route path="/lessons/*" element={<Navigate to="/" replace />} />
        )}
        {/* KS-1821: compile-time guard. `DevRoutesLazy` = null в prod-сборке,
            поэтому Route не рендерится и мёртвая ветка с импортом
            `./dev/DevRoutes` уходит tree-shake'ом. Внутренние подпути (
            `/dev/position-step`, `/dev/reviews-ui`, …) обрабатываются
            суб-роутером внутри `DevRoutes`. */}
        {DevRoutesLazy && (
          <Route
            path="/dev/*"
            element={
              <Suspense fallback={<LazyFallback />}>
                <DevRoutesLazy />
              </Suspense>
            }
          />
        )}
        <Route path="/feedback" element={<FeedbackBoardPage />} />
        <Route path="/feedback/:id" element={<FeedbackDetailPage />} />
        <Route path="/puzzle" element={<PuzzlePage />} />
        <Route path="/puzzle/:id" element={<PuzzlePage />} />
        <Route path="/analysis" element={<Suspense fallback={<LazyFallback />}><AnalysisPage /></Suspense>} />
        <Route path="/help/external-engine" element={<ExternalEngineHelpPage />} />
        <Route path="/analysis/:id" element={<Suspense fallback={<LazyFallback />}><AnalysisPage /></Suspense>} />
        <Route path="/workshop" element={<WorkshopPage />} />
        <Route path="/workshop/pgn-files" element={<WorkshopPage />} />
        <Route path="/workshop/pgn-files/:fileId" element={<WorkshopPage />} />
        <Route path="/players" element={<PlayersPage />} />
        <Route path="/player/:username" element={<PlayerProfilePage />} />
        <Route path="/friends" element={<ProtectedRoute><FriendsPage /></ProtectedRoute>} />
        <Route path="/messages" element={<ProtectedRoute><MessagesPage /></ProtectedRoute>} />
        <Route path="/messages/:userId" element={<ProtectedRoute><MessagesPage /></ProtectedRoute>} />
        <Route path="/profile" element={<ProtectedRoute><ProfileRedirect /></ProtectedRoute>} />
        <Route path="/tournaments" element={<TournamentsPage />} />
        <Route path="/tournaments/:id" element={<TournamentLobbyPage />} />
        <Route path="/arena/:id" element={<TournamentLobbyPage />} />
        <Route path="/t/:code" element={<ProtectedRoute><InviteRedirect /></ProtectedRoute>} />
        <Route
          path="/archive/games"
          element={
            <Suspense fallback={<LazyFallback />}>
              <ArchiveGamesByPositionPage />
            </Suspense>
          }
        />
        <Route path="/broadcasts" element={<BroadcastsPage />} />
        <Route path="/broadcasts/:tournamentId" element={<BroadcastTournamentPage />} />
        <Route path="/broadcasts/:tournamentId/:roundId" element={<BroadcastRoundPage />} />
        <Route path="/broadcasts/:tournamentId/:roundId/:gameId" element={<Suspense fallback={<LazyFallback />}><BroadcastGamePage /></Suspense>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
