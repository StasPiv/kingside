import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Route, Routes } from 'react-router-dom';
import { renderWithProviders, screen, waitFor } from '../test/test-utils';

/**
 * KS-2657 — регрессия: пазл, открытый из раздела `/precision`
 * (`?source=precision`), должен рендерить `PlayVsEngineRunner`,
 * даже если backend в DTO вернул `solutionMode: 'forced-line'`.
 *
 * Причина: для generated-пазлов в БД встречается рассогласование
 * `solution_mode` и реального типа пазла. Backend-фикс отдельной
 * задачей; фронт защищается через `?source=precision` как явный
 * сигнал «это play-vs-engine, отрисовать соответствующий UI».
 */

const { mockPuzzleApi } = vi.hoisted(() => ({
  mockPuzzleApi: {
    getById: vi.fn(),
    getNext: vi.fn(),
    submitAttempt: vi.fn(),
  },
}));

vi.mock('../api-puzzle', () => ({
  puzzleApi: mockPuzzleApi,
}));

// Заглушка PlayVsEngineRunner — нам важно проверить, что рендерится
// именно он, без полной инициализации Stockfish-движка.
vi.mock('../components/puzzle/PlayVsEngineRunner', () => ({
  PlayVsEngineRunner: () => (
    <div data-testid="play-vs-engine-runner-mock" />
  ),
}));

vi.mock('../components/PuzzleBoard', () => ({
  PuzzleBoard: () => <div data-testid="puzzle-board-mock" />,
}));

vi.mock('../components/HelpButton', () => ({
  HelpButton: () => null,
}));

vi.mock('../components/puzzle/MistakesDiaryHint', () => ({
  MistakesDiaryHint: () => null,
}));

vi.mock('../components/puzzle/PuzzleSourceGame', () => ({
  PuzzleSourceGame: () => null,
}));

vi.mock('../hooks/useSounds', () => ({
  useSounds: () => ({ playSound: vi.fn() }),
  soundEventFromSan: () => null,
}));

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: null, loading: false }),
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('../utils/engineAdapter', () => ({
  WasmEngineAdapter: vi.fn(),
}));

import { PuzzlePage } from './PuzzlePage';

beforeEach(() => {
  mockPuzzleApi.getById.mockReset();
  mockPuzzleApi.getNext.mockReset();
  mockPuzzleApi.submitAttempt.mockReset();
});

function renderAt(route: string) {
  return renderWithProviders(
    <Routes>
      <Route path="/puzzle/:id" element={<PuzzlePage />} />
    </Routes>,
    { route },
  );
}

describe('<PuzzlePage> KS-2657', () => {
  it('puzzle.solutionMode=play-vs-engine → PlayVsEngineRunner', async () => {
    mockPuzzleApi.getById.mockResolvedValue({
      id: 'p1',
      fen: 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3',
      moves: ['f3e5'],
      rating: 1500,
      themes: ['middlegame'],
      source: 'generated',
      solutionMode: 'play-vs-engine',
    });
    renderAt('/puzzle/p1');
    await waitFor(() =>
      expect(
        screen.getByTestId('play-vs-engine-runner-mock'),
      ).toBeInTheDocument(),
    );
  });

  it('?source=precision + solutionMode=forced-line → защитный override на PlayVsEngineRunner', async () => {
    mockPuzzleApi.getById.mockResolvedValue({
      id: 'p2',
      fen: 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3',
      moves: ['f3e5'],
      rating: 1500,
      themes: ['middlegame'],
      source: 'lichess',
      // Backend «врёт» что пазл forced-line — на самом деле он сюда
      // попал из precision-раздела, фронт обязан показать PVE-runner.
      solutionMode: 'forced-line',
    });
    renderAt('/puzzle/p2?source=precision');
    await waitFor(() =>
      expect(
        screen.getByTestId('play-vs-engine-runner-mock'),
      ).toBeInTheDocument(),
    );
  });

  it('обычный пазл без source-параметра + forced-line → PlayVsEngineRunner НЕ рендерится', async () => {
    mockPuzzleApi.getById.mockResolvedValue({
      id: 'p3',
      fen: 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3',
      moves: ['f3e5'],
      rating: 1500,
      themes: ['middlegame'],
      source: 'lichess',
      solutionMode: 'forced-line',
    });
    renderAt('/puzzle/p3');
    // Дожидаемся какого-нибудь признака что страница загрузилась —
    // фолбэк-UI выше использует `puzzle-board-mock`.
    await waitFor(() =>
      expect(screen.getByTestId('puzzle-board-mock')).toBeInTheDocument(),
    );
    expect(
      screen.queryByTestId('play-vs-engine-runner-mock'),
    ).not.toBeInTheDocument();
  });
});
