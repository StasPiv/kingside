/**
 * KS-2538 — тесты роутинга `/precision` и алиаса `/puzzles/play-vs-engine`.
 * Проверяем минимальное поведение: новый роут рендерит
 * `PlayVsEnginePuzzlesPage`, старый URL редиректит на новый с
 * сохранением query. Полного App не поднимаем — слишком тяжело;
 * монтируем только нужные роуты в `<MemoryRouter>`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { render, screen, waitFor } from '@testing-library/react';

// Mock тяжёлых зависимостей PlayVsEnginePuzzlesPage, чтобы тест роутинга
// был быстрым и не падал на отсутствии api/контекстов.
vi.mock('react-chessboard', () => ({
  Chessboard: () => <div data-testid="mock-chessboard" />,
}));
const apiGet = vi.fn();
vi.mock('../api', () => ({
  api: { get: (...args: unknown[]) => apiGet(...args) },
}));
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: null, loading: false }),
}));
vi.mock('../context/BoardSettingsContext', () => ({
  useBoardSettings: () => ({
    settings: { boardTheme: 'green', pieceSet: 'cburnett', boardCoordinates: 'inside' },
  }),
  BoardSettingsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { PlayVsEnginePuzzlesPage } from './PlayVsEnginePuzzlesPage';

/**
 * Вспомогательный компонент: под App.tsx логику алиаса. Выровнен по
 * App.tsx — RedirectWithQuery подмешивает search в target.
 */
function RedirectWithQuery({ to }: { to: string }) {
  const location = useLocation();
  const target = location.search ? `${to}${location.search}` : to;
  return <Navigate to={target} replace />;
}

function LocationProbe() {
  const location = useLocation();
  return (
    <div
      data-testid="location-probe"
      data-pathname={location.pathname}
      data-search={location.search}
    />
  );
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="/puzzles/play-vs-engine"
          element={<RedirectWithQuery to="/precision" />}
        />
        <Route
          path="/precision"
          element={
            <>
              <LocationProbe />
              <PlayVsEnginePuzzlesPage />
            </>
          }
        />
        <Route path="*" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('Routing KS-2538 /precision', () => {
  beforeEach(() => {
    apiGet.mockReset();
    apiGet.mockResolvedValue([]);
  });

  it('/precision рендерит PlayVsEnginePuzzlesPage', async () => {
    renderAt('/precision');
    // PlayVsEnginePuzzlesPage делает api.get('/puzzles?...'). Просто
    // проверим что фетч произошёл — значит компонент смонтирован.
    await waitFor(() => {
      expect(apiGet).toHaveBeenCalled();
    });
    expect(
      screen
        .getByTestId('location-probe')
        .getAttribute('data-pathname'),
    ).toBe('/precision');
  });

  it('/puzzles/play-vs-engine редиректит на /precision', async () => {
    renderAt('/puzzles/play-vs-engine');
    await waitFor(() => {
      expect(
        screen
          .getByTestId('location-probe')
          .getAttribute('data-pathname'),
      ).toBe('/precision');
    });
  });

  it('/puzzles/play-vs-engine?foo=bar сохраняет query при редиректе', async () => {
    renderAt('/puzzles/play-vs-engine?foo=bar&themes=mateIn1');
    await waitFor(() => {
      const probe = screen.getByTestId('location-probe');
      expect(probe.getAttribute('data-pathname')).toBe('/precision');
      expect(probe.getAttribute('data-search')).toBe(
        '?foo=bar&themes=mateIn1',
      );
    });
  });
});
