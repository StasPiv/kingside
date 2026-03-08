import { Routes, Route, Navigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { MainLayout } from './layouts/MainLayout';
import { LoginPage } from './pages/LoginPage';
import { RegisterPage } from './pages/RegisterPage';
import { LobbyPage } from './pages/LobbyPage';
import { GamePage } from './pages/GamePage';
import { SettingsPage } from './pages/SettingsPage';
import { DailyPuzzlePage } from './pages/DailyPuzzlePage';
import { PuzzleBrowserPage } from './pages/PuzzleBrowserPage';
import { PuzzlePage } from './pages/PuzzlePage';
import { useAuth } from './context/AuthContext';

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const { t } = useTranslation();
  if (loading) return <div className="loading">{t('common.loading')}</div>;
  if (!user) return <Navigate to="/login" replace />;
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
  return (
    <Routes>
      <Route element={<MainLayout />}>
        <Route path="/login" element={<GuestRoute><LoginPage /></GuestRoute>} />
        <Route path="/register" element={<GuestRoute><RegisterPage /></GuestRoute>} />
        <Route path="/lobby" element={<ProtectedRoute><LobbyPage /></ProtectedRoute>} />
        <Route path="/game/:id" element={<ProtectedRoute><GamePage /></ProtectedRoute>} />
        <Route path="/settings" element={<ProtectedRoute><SettingsPage /></ProtectedRoute>} />
        <Route path="/daily" element={<ProtectedRoute><DailyPuzzlePage /></ProtectedRoute>} />
        <Route path="/puzzles" element={<ProtectedRoute><PuzzleBrowserPage /></ProtectedRoute>} />
        <Route path="/puzzle" element={<ProtectedRoute><PuzzlePage /></ProtectedRoute>} />
        <Route path="/puzzle/:id" element={<ProtectedRoute><PuzzlePage /></ProtectedRoute>} />
        <Route path="*" element={<Navigate to="/lobby" replace />} />
      </Route>
    </Routes>
  );
}
