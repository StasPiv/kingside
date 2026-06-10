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

/**
 * KS-2739: mock PlayVsEngineRunner с возможностью эмулировать
 * автоматический вызов `onSubmit` с заранее заготовленным payload.
 * Тест проставляет `mockAutoSubmit` ДО рендера; mock читает её при
 * mount и зовёт onSubmit. Так проверяется передача moves[] в
 * `puzzleApi.submitAttempt` без необходимости запускать ScriptedEngine.
 */
type AutoSubmitPayload = {
  solved: boolean;
  moves: Array<{
    halfMove: number;
    fenBefore: string;
    playedUci: string;
    bestUci: string;
    wdlBefore: { w: number; d: number; l: number } | null;
    wdlAfter: { w: number; d: number; l: number } | null;
    depth: number | null;
  }>;
};
const { mockAutoSubmit } = vi.hoisted(() => ({
  mockAutoSubmit: { current: null as AutoSubmitPayload | null },
}));
vi.mock('../components/puzzle/PlayVsEngineRunner', () => ({
  PlayVsEngineRunner: (props: {
    onSubmit?: (data: {
      solved: boolean;
      halfMovesPlayed: number;
      finalWdl: number;
      reason: string;
      timeMs: number;
      moves: AutoSubmitPayload['moves'];
    }) => void | Promise<void>;
  }) => {
    if (mockAutoSubmit.current && props.onSubmit) {
      const payload = mockAutoSubmit.current;
      // microtask — даём React успеть смонтироваться.
      Promise.resolve().then(() => {
        props.onSubmit?.({
          solved: payload.solved,
          halfMovesPlayed: payload.moves.length,
          finalWdl: payload.solved ? 0.7 : -0.5,
          reason: payload.solved ? 'win' : 'lose-wdl',
          timeMs: 5000,
          moves: payload.moves,
        });
      });
    }
    return <div data-testid="play-vs-engine-runner-mock" />;
  },
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

const authValue: { user: { id: string } | null } = { user: null };
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: authValue.user, loading: false }),
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
  mockAutoSubmit.current = null;
  authValue.user = null;
});

function renderAt(route: string) {
  return renderWithProviders(
    <Routes>
      <Route path="/puzzle/:id" element={<PuzzlePage />} />
      <Route path="/puzzle" element={<PuzzlePage />} />
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

  /**
   * KS-2732: на /precision «Next» обязан слать `solutionMode=play-vs-engine`
   * в `/puzzles/next`, иначе backend подсунет forced-line пазл и в PVE-
   * runner попадёт пазл без `blunderMove` → текст «зевнул ходом ?».
   */
  it('KS-2732: getNext БЕЗ source=precision не передаёт solutionMode', async () => {
    mockPuzzleApi.getNext.mockResolvedValue({
      id: 'p-next',
      fen: 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3',
      moves: ['f3e5'],
      rating: 1500,
      themes: ['middlegame'],
      source: 'lichess',
      solutionMode: 'forced-line',
    });
    renderAt('/puzzle');
    await waitFor(() => expect(mockPuzzleApi.getNext).toHaveBeenCalled());
    // первый вызов — с undefined params
    expect(mockPuzzleApi.getNext).toHaveBeenCalledWith(undefined);
  });

  it('KS-2732: getNext ПРИ source=precision передаёт solutionMode=play-vs-engine', async () => {
    mockPuzzleApi.getNext.mockResolvedValue({
      id: 'pve-1',
      fen: 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3',
      moves: [],
      rating: 1500,
      themes: ['middlegame'],
      source: 'generated',
      solutionMode: 'play-vs-engine',
    });
    renderAt('/puzzle?source=precision');
    await waitFor(() => expect(mockPuzzleApi.getNext).toHaveBeenCalled());
    expect(mockPuzzleApi.getNext).toHaveBeenCalledWith({
      solutionMode: 'play-vs-engine',
    });
  });

  it('KS-2732: backend вернул forced-line при precision-фильтре → retry, замена на PVE', async () => {
    // 1-й getNext: forced-line (backend mismatch)
    // 2-й getNext (retry): play-vs-engine
    mockPuzzleApi.getNext
      .mockResolvedValueOnce({
        id: 'wrong-1',
        fen: 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3',
        moves: ['f3e5'],
        rating: 1500,
        themes: ['middlegame'],
        source: 'lichess',
        solutionMode: 'forced-line',
      })
      .mockResolvedValueOnce({
        id: 'pve-correct',
        fen: 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3',
        moves: [],
        rating: 1500,
        themes: ['middlegame'],
        source: 'generated',
        solutionMode: 'play-vs-engine',
      });
    renderAt('/puzzle?source=precision');
    await waitFor(() =>
      expect(mockPuzzleApi.getNext).toHaveBeenCalledTimes(2),
    );
    expect(mockPuzzleApi.getNext).toHaveBeenNthCalledWith(1, {
      solutionMode: 'play-vs-engine',
    });
    expect(mockPuzzleApi.getNext).toHaveBeenNthCalledWith(2, {
      solutionMode: 'play-vs-engine',
    });
  });

  /**
   * KS-2739: интеграция submit-payload. Проверяет, что когда
   * `PlayVsEngineRunner` зовёт `onSubmit({moves: [...]})`,
   * `PuzzlePage.handlePlayVsEngineSubmit` пробрасывает массив в
   * `puzzleApi.submitAttempt` body как `moves: [...]` (с маппингом
   * halfMove → ply).
   */
  it('KS-2739: submitAttempt получает moves[] из PlayVsEngineRunner.onSubmit', async () => {
    authValue.user = { id: 'u1' };
    mockPuzzleApi.getById.mockResolvedValue({
      id: 'pve-1',
      fen: 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3',
      moves: [],
      rating: 1500,
      themes: [],
      source: 'generated',
      solutionMode: 'play-vs-engine',
    });
    mockPuzzleApi.submitAttempt.mockResolvedValue({});
    mockAutoSubmit.current = {
      solved: true,
      moves: [
        {
          halfMove: 1,
          fenBefore: 'fen1',
          playedUci: 'e2e4',
          bestUci: 'd2d4',
          wdlBefore: { w: 600, d: 200, l: 200 },
          wdlAfter: { w: 550, d: 250, l: 200 },
          depth: 12,
        },
        {
          halfMove: 2,
          fenBefore: 'fen2',
          playedUci: 'g1f3',
          bestUci: 'g1f3',
          wdlBefore: { w: 580, d: 220, l: 200 },
          wdlAfter: { w: 580, d: 220, l: 200 },
          depth: 12,
        },
      ],
    };
    renderAt('/puzzle/pve-1?source=precision');
    await waitFor(() =>
      expect(mockPuzzleApi.submitAttempt).toHaveBeenCalled(),
    );
    const [puzzleId, body] = mockPuzzleApi.submitAttempt.mock.calls[0];
    expect(puzzleId).toBe('pve-1');
    expect(body.result).toBe('solved');
    expect(body.moves).toHaveLength(2);
    expect(body.moves[0].ply).toBe(1);
    expect(body.moves[0].playedUci).toBe('e2e4');
    expect(body.moves[0].bestUci).toBe('d2d4');
    // KS-4028: контракт `PrecisionMoveSnapshot` без cpBefore/cpAfter —
    // сервер считает score только по WDL.
    expect(body.moves[0].cpBefore).toBeUndefined();
    expect(body.moves[0].cpAfter).toBeUndefined();
    expect(body.moves[0].wdlBefore).toEqual({ w: 600, d: 200, l: 200 });
    expect(body.moves[0].wdlAfter).toEqual({ w: 550, d: 250, l: 200 });
    expect(body.moves[0].depth).toBe(12);
    expect(body.moves[1].ply).toBe(2);
    expect(body.moves[1].playedUci).toBe('g1f3');
  });

  it('KS-2739: гость → submitAttempt не вызывается (включая moves)', async () => {
    authValue.user = null;
    mockPuzzleApi.getById.mockResolvedValue({
      id: 'pve-2',
      fen: 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3',
      moves: [],
      rating: 1500,
      themes: [],
      source: 'generated',
      solutionMode: 'play-vs-engine',
    });
    mockAutoSubmit.current = {
      solved: false,
      moves: [
        {
          halfMove: 1,
          fenBefore: 'fen1',
          playedUci: 'e2e4',
          bestUci: 'd2d4',
          wdlBefore: null,
          wdlAfter: null,
          depth: 12,
        },
      ],
    };
    renderAt('/puzzle/pve-2?source=precision');
    // Дожидаемся mount + microtask
    await waitFor(() =>
      expect(
        screen.getByTestId('play-vs-engine-runner-mock'),
      ).toBeInTheDocument(),
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(mockPuzzleApi.submitAttempt).not.toHaveBeenCalled();
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
