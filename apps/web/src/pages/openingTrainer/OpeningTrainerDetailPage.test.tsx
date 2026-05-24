import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Route, Routes } from 'react-router-dom';
import { renderWithProviders, screen, waitFor, userEvent } from '../../test/test-utils';
import { OpeningTrainerDetailPage } from './OpeningTrainerDetailPage';
import { openingTrainerApi } from '../../api/openingTrainerApi';
import type { OpeningLineProgressDto, OpeningTrainerSessionDto } from '@kingside/shared';

vi.mock('../../api/openingTrainerApi', () => ({
  openingTrainerApi: {
    getRepertoire: vi.fn(),
    getRepertoireProgress: vi.fn(),
    getRepertoireActiveSession: vi.fn(),
    startSession: vi.fn(),
    deleteRepertoire: vi.fn(),
  },
}));
const mockedApi = vi.mocked(openingTrainerApi);

function makeRepertoire(overrides: Partial<{ nodeCount: number; edgeCount: number; maxDepth: number; nodes: Record<string, { fen: string; edges: never[] }> }> = {}) {
  return {
    id: 'r1',
    ownerId: 'u1',
    title: 'Caro-Kann',
    description: null,
    nodeCount: overrides.nodeCount ?? 42,
    edgeCount: overrides.edgeCount ?? 60,
    maxDepth: overrides.maxDepth ?? 12,
    createdAt: '2026-05-01T00:00:00Z',
    updatedAt: '2026-05-01T00:00:00Z',
    pgn: '',
    tree: {
      rootFen: 'start',
      nodes: overrides.nodes ?? {
        leaf1: { fen: 'leaf1', edges: [] },
        leaf2: { fen: 'leaf2', edges: [] },
        leaf3: { fen: 'leaf3', edges: [] },
      },
      meta: {
        nodeCount: overrides.nodeCount ?? 42,
        edgeCount: overrides.edgeCount ?? 60,
        maxDepth: overrides.maxDepth ?? 12,
      },
    },
  };
}

function makeProgressLine(overrides: Partial<OpeningLineProgressDto> = {}): OpeningLineProgressDto {
  return {
    id: 'l1',
    repertoireId: 'r1',
    pathHash: 'h1',
    pathUci: ['e2e4'],
    pathLength: 1,
    correctCount: 0,
    wrongCount: 0,
    consecutiveCorrect: 0,
    lastPlayedAt: '2026-05-23T00:00:00Z',
    masteredAt: null,
    sm2DueAt: null,
    sm2Interval: null,
    sm2Easiness: null,
    sm2Reps: null,
    orphaned: false,
    status: 'not-played',
    ...overrides,
  };
}

function renderDetail(route = '/opening-trainer/r1') {
  return renderWithProviders(
    <Routes>
      <Route path="/opening-trainer/:id" element={<OpeningTrainerDetailPage />} />
    </Routes>,
    { route },
  );
}

describe('OpeningTrainerDetailPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedApi.getRepertoireProgress.mockResolvedValue({
      repertoireId: 'r1',
      lines: [],
    });
    mockedApi.getRepertoireActiveSession.mockResolvedValue({ session: null });
  });

  it('loads and renders repertoire detail', async () => {
    mockedApi.getRepertoire.mockResolvedValue(makeRepertoire());
    renderDetail();
    await waitFor(() =>
      expect(screen.getByTestId('opening-trainer-detail')).toBeInTheDocument(),
    );
    expect(screen.getByText('Caro-Kann')).toBeInTheDocument();
    expect(screen.getByTestId('opening-trainer-modes')).toBeInTheDocument();
  });

  it('KS-3295: 4 кнопки режимов с counter\'ами по progress', async () => {
    mockedApi.getRepertoire.mockResolvedValue(makeRepertoire());
    mockedApi.getRepertoireProgress.mockResolvedValue({
      repertoireId: 'r1',
      lines: [
        makeProgressLine({ id: 'a', status: 'learning' }),
        makeProgressLine({ id: 'b', status: 'wrong' }),
        makeProgressLine({ id: 'c', status: 'due' }),
        makeProgressLine({ id: 'd', status: 'mastered' }),
      ],
    });
    renderDetail();
    await waitFor(() =>
      expect(screen.getByTestId('opening-trainer-mode-learn')).toBeInTheDocument(),
    );
    // learn = 1 learning + (3 leaves - 4 touched, clamp 0) = 1
    expect(screen.getByTestId('opening-trainer-mode-learn')).toHaveAttribute(
      'data-count',
      '1',
    );
    // review = 1 due
    expect(screen.getByTestId('opening-trainer-mode-review')).toHaveAttribute(
      'data-count',
      '1',
    );
    // mistakes = 1 wrong
    expect(screen.getByTestId('opening-trainer-mode-mistakes')).toHaveAttribute(
      'data-count',
      '1',
    );
    // free = totalLeafLines = 3
    expect(screen.getByTestId('opening-trainer-mode-free')).toHaveAttribute(
      'data-count',
      '3',
    );
  });

  it('KS-3295: кнопка disabled когда counter = 0', async () => {
    mockedApi.getRepertoire.mockResolvedValue(
      makeRepertoire({ nodes: {} }), // 0 leaves
    );
    mockedApi.getRepertoireProgress.mockResolvedValue({
      repertoireId: 'r1',
      lines: [],
    });
    renderDetail();
    await waitFor(() =>
      expect(screen.getByTestId('opening-trainer-mode-review')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('opening-trainer-mode-review')).toBeDisabled();
    expect(screen.getByTestId('opening-trainer-mode-mistakes')).toBeDisabled();
  });

  it('KS-3295: клик по кнопке режима стартует сессию с этим mode', async () => {
    mockedApi.getRepertoire.mockResolvedValue(makeRepertoire());
    mockedApi.startSession.mockRejectedValue(new Error('boom')); // не редиректим
    renderDetail();
    await waitFor(() =>
      expect(screen.getByTestId('opening-trainer-mode-learn')).toBeInTheDocument(),
    );
    await userEvent.click(screen.getByTestId('opening-trainer-mode-learn'));
    await waitFor(() =>
      expect(mockedApi.startSession).toHaveBeenCalledWith('r1', {
        side: 'white',
        mode: 'learn',
        repeatMode: 'complete',
      }),
    );
  });

  it('KS-3297: sticky-карточка «Продолжить» при active-session', async () => {
    mockedApi.getRepertoire.mockResolvedValue(makeRepertoire());
    const session: OpeningTrainerSessionDto = {
      id: 's-active',
      repertoireId: 'r1',
      side: 'white',
      mode: 'learn',
      repeatMode: 'complete',
      status: 'active',
      currentFen: 'fen',
      currentPath: [],
      score: 42,
      movesPlayed: 10,
      correctMoves: 8,
      wrongMoves: 2,
      hintsUsed: 0,
      startedAt: '2026-05-23T00:00:00Z',
      lastActivityAt: '2026-05-23T00:01:00Z',
      finishedAt: null,
    };
    mockedApi.getRepertoireActiveSession.mockResolvedValue({ session });
    renderDetail();
    await waitFor(() =>
      expect(screen.getByTestId('opening-trainer-continue')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('opening-trainer-continue-btn')).toBeInTheDocument();
    // Метаданные: счёт 42 + 10 ходов отображены внутри карточки.
    expect(
      screen.getByTestId('opening-trainer-continue').textContent,
    ).toContain('42');
    expect(
      screen.getByTestId('opening-trainer-continue').textContent,
    ).toContain('10');
  });

  it('KS-3297: без active-session карточки нет', async () => {
    mockedApi.getRepertoire.mockResolvedValue(makeRepertoire());
    mockedApi.getRepertoireActiveSession.mockResolvedValue({ session: null });
    renderDetail();
    await waitFor(() =>
      expect(screen.getByTestId('opening-trainer-detail')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('opening-trainer-continue')).toBeNull();
  });
});
