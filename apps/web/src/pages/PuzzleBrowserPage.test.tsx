/**
 * KS-2485. Тест: PuzzleBrowserPage рендерит точку входа на
 * `/puzzles/play-vs-engine` (KS-2484). Минимальный smoke-тест —
 * проверяем что вкладка с правильным href отрисовалась после mount.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { waitFor } from '@testing-library/react';
import { renderWithProviders, screen } from '../test/test-utils';

const apiGet = vi.fn();
vi.mock('../api', () => ({
  api: {
    get: (...args: unknown[]) => apiGet(...args),
    delete: vi.fn(),
    patch: vi.fn(),
  },
}));

// PuzzleGeneratorModal импортит тяжёлый стек (chess.js + workers) —
// мокаем, тесту он не нужен.
vi.mock('../components/PuzzleGeneratorModal', () => ({
  PuzzleGeneratorModal: () => null,
}));

// renderWithProviders не оборачивает в AuthProvider — мокаем useAuth
// чтобы тестируемый компонент мог его вызывать без падения.
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: null, login: vi.fn(), logout: vi.fn() }),
}));

import { PuzzleBrowserPage } from './PuzzleBrowserPage';

beforeEach(() => {
  apiGet.mockReset();
  // По умолчанию пустая выборка — ничего лишнего на странице.
  apiGet.mockResolvedValue({ data: [], total: 0 });
});

afterEach(() => vi.restoreAllMocks());

describe('<PuzzleBrowserPage> KS-2541 — вкладка «Play vs Engine» удалена', () => {
  it('на /puzzles нет вкладки «Play vs Engine» (раздел переехал на /precision)', async () => {
    renderWithProviders(<PuzzleBrowserPage />);
    await waitFor(() => expect(apiGet).toHaveBeenCalled());
    expect(
      screen.queryByTestId('puzzle-browser-tab-play-vs-engine'),
    ).toBeNull();
  });
});
