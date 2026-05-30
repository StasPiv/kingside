import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';

import { useRepertoireFromArchive } from './useRepertoireFromArchive';
import type {
  ArchiveGameDetail,
  ArchiveGamesByPositionResponse,
  CreateOpeningRepertoireResponse,
} from '@kingside/shared';

/**
 * KS-3472 (ADR-090 V4 F2) — критерии: Stockfish вызывается ТОЛЬКО на
 * ходах тренируемой стороны; partidas с pathological loss > 50 cp на
 * нашем первом ходу пропускаются; обрезка работает; создание
 * репертуара POST'ом и navigate.
 */

const archivePositionGames = vi.fn();
const createRepertoire = vi.fn();
vi.mock('../../api/openingTrainerApi', () => ({
  openingTrainerApi: {
    archivePositionGames: (...a: unknown[]) => archivePositionGames(...a),
    createRepertoire: (...a: unknown[]) => createRepertoire(...a),
  },
}));

const getArchiveGameById = vi.fn();
vi.mock('../../api/archive', () => ({
  archiveApi: {
    getArchiveGameById: (...a: unknown[]) => getArchiveGameById(...a),
  },
}));

// Контролируемый mock движка. На каждом вызове analyze возвращает
// заданное cp; параллельно пишет fen в спец-список, чтобы тест мог
// проверить — analyze вызывали ТОЛЬКО на ходах нужной стороны.
const analyzeCalls: string[] = [];
const analyzeFn = vi.fn(async (fen: string) => {
  analyzeCalls.push(fen);
  return {
    lines: [
      {
        multipv: 1,
        depth: 20,
        score: { type: 'cp' as const, value: 25 },
        pv: ['e2e4'],
      },
    ],
    bestByDepth: new Map(),
    evalByDepth: new Map(),
    firstAppearance: 1,
  };
});
vi.mock('../../utils/engineAdapter', () => ({
  WasmEngineAdapter: class {
    async init() {}
    setOption() {}
    analyze = analyzeFn;
    async analyzeLive() {}
    stop() {}
    destroy() {}
  },
}));

const wrapper = ({ children }: { children: ReactNode }) => (
  <MemoryRouter initialEntries={['/analysis']}>{children}</MemoryRouter>
);

// Простая партия: 1.e4 e5 2.Nf3 Nc6 3.Bb5 a6 — 6 полуходов.
// reachedAtPly: предположим backend нашёл позицию после 1.e4 e5 — ply=2.
// trainedColor = white (после 1.e4 e5 ходит белый, мы тренируем белого).
const SAMPLE_PGN =
  '[Event "Test"]\n[White "A"]\n[Black "B"]\n\n1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 *';

beforeEach(() => {
  archivePositionGames.mockReset();
  createRepertoire.mockReset();
  getArchiveGameById.mockReset();
  analyzeFn.mockClear();
  analyzeCalls.length = 0;
});

describe('useRepertoireFromArchive (KS-3472 F2)', () => {
  it('empty cursor first page → phase=empty', async () => {
    archivePositionGames.mockResolvedValue({
      items: [],
      hasMore: false,
      nextCursor: null,
    } as Partial<ArchiveGamesByPositionResponse>);
    const { result } = renderHook(() => useRepertoireFromArchive(), { wrapper });
    await act(async () => {
      await result.current.start({
        fen: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2',
        side: 'white',
        movetime: 1000,
        title: 'X',
      });
    });
    expect(result.current.state.phase).toBe('empty');
  });

  it('Stockfish вызывается ТОЛЬКО на ходах trainedColor (white) — не на чёрных ходах', async () => {
    archivePositionGames.mockResolvedValue({
      items: [
        {
          id: 'g-1',
          reachedAtPly: 2, // позиция после 1.e4 e5
          white: { name: 'A' },
          black: { name: 'B' },
          result: '*',
          eco: null,
          opening: null,
          event: 'T',
          date: null,
          plyCount: 6,
          nextMoveUci: null,
          sideToMove: 'w',
        },
      ],
      hasMore: false,
      nextCursor: null,
    } as Partial<ArchiveGamesByPositionResponse>);
    getArchiveGameById.mockResolvedValue({
      id: 'g-1',
      pgn: SAMPLE_PGN,
      event: 'T',
      white: { name: 'A' },
      black: { name: 'B' },
    } as Partial<ArchiveGameDetail>);
    createRepertoire.mockResolvedValue({
      repertoire: { id: 'rep-77' },
    } as Partial<CreateOpeningRepertoireResponse>);

    const { result } = renderHook(() => useRepertoireFromArchive(), { wrapper });
    await act(async () => {
      await result.current.start({
        fen: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2',
        side: 'white',
        movetime: 1000,
        title: 'White rep',
      });
    });

    // history после reachedAtPly=2: ply2=e5 (черный — пропустить),
    // ply3=Nf3 (белый — eval), ply4=Nc6 (чёрный), ply5=Bb5 (белый),
    // ply6=a6 (чёрный).
    // Итого ходов trainedColor=white в диапазоне = 2 (Nf3, Bb5).
    // На КАЖДОМ trained-ходу — 2 analyze (before + after). Итого 4.
    expect(analyzeFn).toHaveBeenCalledTimes(4);

    // Каждая позиция в analyzeCalls должна иметь активный цвет 'w'
    // (eBefore) или 'b' (eAfter после white move). Чёрные ходы НЕ
    // должны быть «оценены» — а fen ходов между white-ходами на доске
    // отсутствует в analyzeCalls.
    // Проверка через активный цвет: eBefore — FEN, в котором ходит
    // тренируемая (white = 'w'); eAfter — соперник ('b').
    const activeColors = analyzeCalls.map((fen) => fen.split(' ')[1]);
    expect(activeColors.filter((c) => c === 'w').length).toBe(2); // 2 eBefore
    expect(activeColors.filter((c) => c === 'b').length).toBe(2); // 2 eAfter

    // Репертуар создан с 1 source.
    expect(createRepertoire).toHaveBeenCalledTimes(1);
    const body = createRepertoire.mock.calls[0][0];
    expect(body.title).toBe('White rep');
    expect(body.side).toBe('white');
    expect(body.sources).toHaveLength(1);
    expect(body.sources[0].pgn).toContain('1. e4 e5 2. Nf3');

    expect(result.current.state.phase).toBe('done');
    expect(result.current.state.valid).toBe(1);
    expect(result.current.state.checked).toBe(1);
  });

  it('trainedColor=black (side=black) → analyze вызывается на ходах чёрных', async () => {
    archivePositionGames.mockResolvedValue({
      items: [
        {
          id: 'g-2',
          reachedAtPly: 1, // позиция после 1.e4
          white: { name: 'A' },
          black: { name: 'B' },
          result: '*',
          eco: null,
          opening: null,
          event: 'T',
          date: null,
          plyCount: 6,
          nextMoveUci: null,
          sideToMove: 'b',
        },
      ],
      hasMore: false,
      nextCursor: null,
    } as Partial<ArchiveGamesByPositionResponse>);
    getArchiveGameById.mockResolvedValue({
      id: 'g-2',
      pgn: SAMPLE_PGN,
      event: 'T',
    } as Partial<ArchiveGameDetail>);
    createRepertoire.mockResolvedValue({
      repertoire: { id: 'rep-88' },
    } as Partial<CreateOpeningRepertoireResponse>);

    const { result } = renderHook(() => useRepertoireFromArchive(), { wrapper });
    await act(async () => {
      await result.current.start({
        fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1',
        side: 'black',
        movetime: 500,
        title: 'Black rep',
      });
    });

    // history после reachedAtPly=1: ply1=e5 (черный — eval), ply2=Nf3
    // (белый), ply3=Nc6 (чёрный — eval), ply4=Bb5 (белый), ply5=a6
    // (чёрный — eval). Итого 3 trained-хода × 2 analyze = 6.
    expect(analyzeFn).toHaveBeenCalledTimes(6);
    expect(result.current.state.phase).toBe('done');
  });

  it('cancel в процессе → phase=cancelled, navigate не вызван', async () => {
    archivePositionGames.mockImplementation(async () => {
      // Бесконечная пауза, чтобы успеть cancel.
      await new Promise((r) => setTimeout(r, 1000));
      return {
        items: [],
        hasMore: false,
        nextCursor: null,
      } as Partial<ArchiveGamesByPositionResponse>;
    });
    const { result } = renderHook(() => useRepertoireFromArchive(), { wrapper });
    act(() => {
      void result.current.start({
        fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1',
        side: 'black',
        movetime: 500,
        title: 'X',
      });
    });
    await waitFor(() => expect(result.current.state.phase).toBe('fetching'));
    act(() => {
      result.current.cancel();
    });
    expect(result.current.state.phase).toBe('cancelled');
    expect(createRepertoire).not.toHaveBeenCalled();
  });
});
