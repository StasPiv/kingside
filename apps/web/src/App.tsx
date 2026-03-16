import { Routes, Route, Navigate, useLocation, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { MainLayout } from './layouts/MainLayout';
import { LoginPage } from './pages/LoginPage';
import { RegisterPage } from './pages/RegisterPage';
import { LobbyPage } from './pages/LobbyPage';
import { GamePage } from './pages/GamePage';
import { SettingsPage } from './pages/SettingsPage';
import { DailyPuzzlePage } from './pages/DailyPuzzlePage';
import { PuzzleBrowserPage } from './pages/PuzzleBrowserPage';
import { PuzzleRushPage } from './pages/PuzzleRushPage';
import { PuzzlePage } from './pages/PuzzlePage';
import { PuzzleRushLeaderboardPage } from './pages/PuzzleRushLeaderboardPage';
import { PuzzleRushReviewPage } from './pages/PuzzleRushReviewPage';
import { ProfilePage } from './pages/ProfilePage';
import { GameReviewPage } from './pages/GameReviewPage';
import { WorkshopPage } from './pages/WorkshopPage';
import { BroadcastsPage } from './pages/BroadcastsPage';
import { BroadcastTournamentPage } from './pages/BroadcastTournamentPage';
import { BroadcastRoundPage } from './pages/BroadcastRoundPage';
import { BroadcastGamePage } from './pages/BroadcastGamePage';
import { OAuthCallbackPage } from './pages/OAuthCallbackPage';
import { DevBypassPage } from './pages/DevBypassPage';
import { useAuth } from './context/AuthContext';

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

export function App() {
  const [searchParams] = useSearchParams();
  const devSecret = import.meta.env.VITE_DEV_BYPASS_SECRET;

  if (devSecret && searchParams.has('dev_bypass')) {
    return <DevBypassPage secret={searchParams.get('dev_bypass') ?? ''} />;
  }

  return (
    <Routes>
      <Route element={<MainLayout />}>
        <Route path="/login" element={<GuestRoute><LoginPage /></GuestRoute>} />
        <Route path="/register" element={<GuestRoute><RegisterPage /></GuestRoute>} />
        <Route path="/oauth/callback" element={<OAuthCallbackPage />} />
        <Route path="/lobby" element={<ProtectedRoute><LobbyPage /></ProtectedRoute>} />
        <Route path="/game/:id" element={<ProtectedRoute><GamePage /></ProtectedRoute>} />
        <Route path="/game/:gameId/review" element={<ProtectedRoute><GameReviewPage /></ProtectedRoute>} />
        <Route path="/settings" element={<ProtectedRoute><SettingsPage /></ProtectedRoute>} />
        <Route path="/daily" element={<ProtectedRoute><DailyPuzzlePage /></ProtectedRoute>} />
        <Route path="/puzzle-rush" element={<ProtectedRoute><PuzzleRushPage /></ProtectedRoute>} />
        <Route path="/puzzle-rush/leaderboard" element={<PuzzleRushLeaderboardPage />} />
        <Route path="/puzzle-rush/review/:scoreId" element={<ProtectedRoute><PuzzleRushReviewPage /></ProtectedRoute>} />
        <Route path="/puzzles/rush" element={<Navigate to="/puzzle-rush" replace />} />
        <Route path="/puzzles" element={<ProtectedRoute><PuzzleBrowserPage /></ProtectedRoute>} />
        <Route path="/puzzle" element={<ProtectedRoute><PuzzlePage /></ProtectedRoute>} />
        <Route path="/puzzle/:id" element={<ProtectedRoute><PuzzlePage /></ProtectedRoute>} />
        <Route path="/analysis" element={<ProtectedRoute><GameReviewPage /></ProtectedRoute>} />
        <Route path="/analysis/:id" element={<ProtectedRoute><GameReviewPage /></ProtectedRoute>} />
        <Route path="/workshop" element={<WorkshopPage />} />
        <Route path="/workshop/pgn-files" element={<WorkshopPage />} />
        <Route path="/workshop/pgn-files/:fileId" element={<WorkshopPage />} />
        <Route path="/profile" element={<ProtectedRoute><ProfilePage /></ProtectedRoute>} />
        <Route path="/broadcasts" element={<BroadcastsPage />} />
        <Route path="/broadcasts/:tournamentId" element={<BroadcastTournamentPage />} />
        <Route path="/broadcasts/:tournamentId/:roundId" element={<BroadcastRoundPage />} />
        <Route path="/broadcasts/:tournamentId/:roundId/:gameId" element={<BroadcastGamePage />} />
        <Route path="*" element={<Navigate to="/lobby" replace />} />
      </Route>
    </Routes>
  );
}
