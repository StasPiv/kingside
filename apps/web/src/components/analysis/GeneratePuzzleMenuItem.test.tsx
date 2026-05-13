import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders, screen } from '../../test/test-utils';

// Мокаем api ДО импорта компонента.
const apiPost = vi.fn();
const apiGet = vi.fn();
vi.mock('../../api', () => ({
  api: {
    post: (...args: unknown[]) => apiPost(...args),
    get: (...args: unknown[]) => apiGet(...args),
  },
}));

// Мокаем сам генератор: дольний вариант через `generatePuzzlesFromPgn`.
const generateMock = vi.fn();
vi.mock('../../utils/puzzleGenerator', () => ({
  generatePuzzlesFromPgn: (...args: unknown[]) => generateMock(...args),
  DEFAULT_PUZZLE_GEN_SETTINGS: { depth: 18, movetimeMs: 1000, blunderDelta: 0.6, solvabilityCheck: false },
}));

// react-router-dom mock — useNavigate.
const navigateMock = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>(
    'react-router-dom',
  );
  return { ...actual, useNavigate: () => navigateMock };
});

import { GeneratePuzzleMenuItem } from './GeneratePuzzleMenuItem';

describe('GeneratePuzzleMenuItem (KS-2958)', () => {
  beforeEach(() => {
    apiPost.mockReset();
    apiGet.mockReset();
    generateMock.mockReset();
    navigateMock.mockReset();
  });

  it('рендерит кнопку с лейблом «Generate puzzle» в idle', () => {
    renderWithProviders(
      <GeneratePuzzleMenuItem getPgn={() => '[Event "x"]\n\n1. e4 e5'} onClose={vi.fn()} />,
    );
    const btn = screen.getByTestId('analysis-generate-puzzle');
    expect(btn).toBeInTheDocument();
    expect(btn).toHaveAttribute('data-state', 'idle');
    expect(btn).not.toBeDisabled();
  });

  it('disabled пропс задисейблен кнопку', () => {
    renderWithProviders(
      <GeneratePuzzleMenuItem getPgn={() => null} onClose={vi.fn()} disabled />,
    );
    expect(screen.getByTestId('analysis-generate-puzzle')).toBeDisabled();
  });

  it('успешный flow: generate → batch → browse → navigate', async () => {
    const onClose = vi.fn();
    const puzzle = { fen: 'fake-fen-1', moves: '', rating: 1500, themes: '', sourceType: 'pgn_import', sourceId: null, sourceMoveNum: 0, sourceMetadata: {}, solutionMode: 'play-vs-engine', isPublic: false, gap: 50 };
    generateMock.mockResolvedValue([puzzle]);
    apiPost.mockResolvedValue({ count: 1 });
    apiGet.mockResolvedValue({ data: [{ id: 'puz-42', fen: 'fake-fen-1' }] });

    const user = userEvent.setup();
    renderWithProviders(
      <GeneratePuzzleMenuItem getPgn={() => '[pgn]'} onClose={onClose} />,
    );
    await user.click(screen.getByTestId('analysis-generate-puzzle'));

    await waitFor(() => expect(navigateMock).toHaveBeenCalledTimes(1));
    expect(navigateMock).toHaveBeenCalledWith(
      '/puzzle/puz-42?source=precision&mine=true&visibility=draft',
    );
    expect(apiPost).toHaveBeenCalledWith('/puzzles/batch', { puzzles: [puzzle] });
    expect(apiGet).toHaveBeenCalledWith(
      '/puzzles/browse?mine=true&visibility=draft&source=precision&limit=20',
    );
    expect(onClose).toHaveBeenCalled();
  });

  it('пустой результат генерации → toast «No suitable positions», navigate не вызывается', async () => {
    generateMock.mockResolvedValue([]);
    const user = userEvent.setup();
    renderWithProviders(
      <GeneratePuzzleMenuItem getPgn={() => '[pgn]'} onClose={vi.fn()} />,
    );
    await user.click(screen.getByTestId('analysis-generate-puzzle'));

    await waitFor(() =>
      expect(screen.getByTestId('analysis-generate-puzzle-error')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('analysis-generate-puzzle-error').textContent).toMatch(
      /No suitable positions/i,
    );
    expect(navigateMock).not.toHaveBeenCalled();
    expect(apiPost).not.toHaveBeenCalled();
  });

  it('getPgn() === null → toast о пустом PGN, navigate не вызывается', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <GeneratePuzzleMenuItem getPgn={() => null} onClose={vi.fn()} />,
    );
    await user.click(screen.getByTestId('analysis-generate-puzzle'));
    await waitFor(() =>
      expect(screen.getByTestId('analysis-generate-puzzle-error')).toBeInTheDocument(),
    );
    expect(generateMock).not.toHaveBeenCalled();
  });

  it('ошибка POST /puzzles/batch → toast save-error, navigate не вызывается', async () => {
    const puzzle = { fen: 'f1', moves: '', rating: 1500, themes: '', sourceType: 'pgn_import', sourceId: null, sourceMoveNum: 0, sourceMetadata: {}, solutionMode: 'play-vs-engine', isPublic: false, gap: 50 };
    generateMock.mockResolvedValue([puzzle]);
    apiPost.mockRejectedValue(new Error('500 oops'));

    const user = userEvent.setup();
    renderWithProviders(
      <GeneratePuzzleMenuItem getPgn={() => '[pgn]'} onClose={vi.fn()} />,
    );
    await user.click(screen.getByTestId('analysis-generate-puzzle'));

    await waitFor(() =>
      expect(screen.getByTestId('analysis-generate-puzzle-error')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('analysis-generate-puzzle-error').textContent).toMatch(
      /failed to save/i,
    );
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('browse не нашёл по fen → fallback на /precision?mine=true&visibility=draft', async () => {
    const puzzle = { fen: 'f-x', moves: '', rating: 1500, themes: '', sourceType: 'pgn_import', sourceId: null, sourceMoveNum: 0, sourceMetadata: {}, solutionMode: 'play-vs-engine', isPublic: false, gap: 50 };
    generateMock.mockResolvedValue([puzzle]);
    apiPost.mockResolvedValue({ count: 1 });
    apiGet.mockResolvedValue({ data: [{ id: 'other', fen: 'different-fen' }] });

    const user = userEvent.setup();
    renderWithProviders(
      <GeneratePuzzleMenuItem getPgn={() => '[pgn]'} onClose={vi.fn()} />,
    );
    await user.click(screen.getByTestId('analysis-generate-puzzle'));

    await waitFor(() => expect(navigateMock).toHaveBeenCalledTimes(1));
    expect(navigateMock).toHaveBeenCalledWith('/precision?mine=true&visibility=draft');
  });

  it('повторный клик во время generating игнорируется', async () => {
    let resolveGen!: (v: unknown[]) => void;
    generateMock.mockReturnValue(new Promise((r) => { resolveGen = r as never; }));

    const user = userEvent.setup();
    renderWithProviders(
      <GeneratePuzzleMenuItem getPgn={() => '[pgn]'} onClose={vi.fn()} />,
    );
    const btn = screen.getByTestId('analysis-generate-puzzle');
    await user.click(btn);
    // Кнопка задизейблена, второй клик ничего не делает.
    await waitFor(() => expect(btn).toBeDisabled());
    fireEvent.click(btn);
    expect(generateMock).toHaveBeenCalledTimes(1);
    // Разрешаем генерацию пустым результатом, чтобы тест завершился.
    resolveGen([]);
  });
});
