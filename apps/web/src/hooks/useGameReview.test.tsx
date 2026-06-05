/**
 * KS-3603 → KS-3607. Тесты `useGameReview` через mock `ReviewEngines`.
 * Новый shape — WDL-объекты вместо cp.
 */
import { describe, it, expect, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

import type { Wdl } from '@kingside/shared';

// KS-3676: stockfishTrace в jsdom не загружает реальный <script> —
// фабрика бросает factory-error. Тесты useGameReview не проверяют
// сам трейс, поэтому мокаем его минимальным валидным набором
// подкомпонент.
// KS-3712: один непустой `PositionalSubterm` имитирует штатную
// трассировку — иначе ход пропускается из LLM-batch (см. фильтр
// `positionalSubterms.length === 0` в `useGameReview`).
vi.mock('../lib/review/stockfishTrace', () => ({
  evalTrace: vi.fn().mockResolvedValue([
    { id: 'space', value_mg: 0, value_eg: 0 },
  ]),
  parseTraceJson: vi.fn().mockReturnValue([]),
  StockfishTraceEngineError: class extends Error {
    constructor(public readonly reason: string) {
      super(`mock-stockfish-trace: ${reason}`);
      this.name = 'StockfishTraceEngineError';
    }
  },
}));

import {
  useGameReview,
  type MoveCommentClient,
  type ReviewEngines,
  parsePgnPlies,
} from './useGameReview';

const PGN_3PLIES =
  '[Event "Test"]\n[Result "*"]\n\n1. e4 e5 2. Nf3 *\n';

const NEUTRAL: Wdl = { w: 500, d: 0, l: 500 };

function mockEngines(over: Partial<ReviewEngines> = {}): ReviewEngines {
  return {
    analyzeSf: vi.fn().mockResolvedValue({
      bestUci: 'e2e4',
      wdlBefore: NEUTRAL,
      wdlAfterBest: NEUTRAL,
      wdlAfterSecondBest: NEUTRAL,
      bestPv: ['e2e4', 'e7e5'],
      wdlByMove: { e2e4: NEUTRAL },
      legalMovesCount: 20,
      topScore: { type: 'cp', value: 0 },
      topDepth: 20,
    }),
    evalMove: vi.fn().mockResolvedValue(NEUTRAL),
    predictMaia: vi.fn().mockResolvedValue({
      byUci: { e2e4: 0.4, d2d4: 0.2 },
      topUci: 'e2e4',
      topProb: 0.4,
    }),
    terminate: vi.fn(),
    ...over,
  };
}

describe('parsePgnPlies', () => {
  it('возвращает 3 полухода для PGN 1. e4 e5 2. Nf3', () => {
    const out = parsePgnPlies(PGN_3PLIES);
    expect(out).toHaveLength(3);
    expect(out[0].playedUci).toBe('e2e4');
    expect(out[2].playedUci).toBe('g1f3');
  });

  it('возвращает [] для пустого PGN', () => {
    expect(parsePgnPlies('[Event "x"]\n\n*\n')).toEqual([]);
  });
});

describe('useGameReview', () => {
  it('idle на старте', () => {
    const { result } = renderHook(() =>
      useGameReview({ engines: mockEngines() }),
    );
    expect(result.current.status).toBe('idle');
  });

  it('done через все плыхи; annotations длиной = plies', async () => {
    const engines = mockEngines();
    const { result } = renderHook(() => useGameReview({ engines }));
    await act(async () => {
      await result.current.run(PGN_3PLIES);
    });
    expect(result.current.status).toBe('done');
    expect(result.current.result?.annotations).toHaveLength(3);
    expect(engines.terminate).toHaveBeenCalled();
  });

  it('пустой PGN → error', async () => {
    const { result } = renderHook(() =>
      useGameReview({ engines: mockEngines() }),
    );
    await act(async () => {
      await result.current.run('[Event "x"]\n\n*\n');
    });
    expect(result.current.status).toBe('error');
  });

  it('error в engine → status=error + terminate', async () => {
    const engines = mockEngines({
      analyzeSf: vi.fn().mockRejectedValue(new Error('boom')),
    });
    const { result } = renderHook(() => useGameReview({ engines }));
    await act(async () => {
      await result.current.run(PGN_3PLIES);
    });
    expect(result.current.status).toBe('error');
    expect(result.current.error).toBe('boom');
    expect(engines.terminate).toHaveBeenCalled();
  });

  it('cancel в полёте → cancelled', async () => {
    let resolveFirst: () => void = () => undefined;
    const sfMock = vi.fn().mockImplementation(
      () =>
        new Promise((r) => {
          resolveFirst = () => {
            r({
              bestUci: 'e2e4',
              wdlBefore: NEUTRAL,
              wdlAfterBest: NEUTRAL,
              wdlAfterSecondBest: NEUTRAL,
              bestPv: ['e2e4'],
              wdlByMove: { e2e4: NEUTRAL },
              legalMovesCount: 20,
            });
          };
        }),
    );
    const engines = mockEngines({ analyzeSf: sfMock });
    const { result } = renderHook(() => useGameReview({ engines }));
    let runPromise: Promise<void> | null = null;
    act(() => {
      runPromise = result.current.run(PGN_3PLIES);
    });
    await waitFor(() => expect(result.current.status).toBe('running'));
    act(() => result.current.cancel());
    resolveFirst();
    await act(async () => {
      await runPromise;
    });
    expect(result.current.status).toBe('cancelled');
  });

  it('передаёт ELO в Maia и depth в SF', async () => {
    const engines = mockEngines();
    const { result } = renderHook(() =>
      useGameReview({ engines, elo: 1900, depth: 12 }),
    );
    await act(async () => {
      await result.current.run(PGN_3PLIES);
    });
    expect(engines.predictMaia).toHaveBeenCalledWith(expect.any(String), 1900);
    expect(engines.analyzeSf).toHaveBeenCalledWith(
      expect.any(String),
      3,
      12,
    );
  });

  it('evalMove вызывается когда playedUci не в wdlByMove (top-3 без сыгранного)', async () => {
    const engines = mockEngines({
      analyzeSf: vi.fn().mockResolvedValue({
        bestUci: 'e2e4',
        wdlBefore: NEUTRAL,
        wdlAfterBest: NEUTRAL,
        wdlAfterSecondBest: NEUTRAL,
        bestPv: ['e2e4'],
        wdlByMove: { e2e4: NEUTRAL }, // нет e7e5 и g1f3
        legalMovesCount: 20,
      }),
    });
    const { result } = renderHook(() => useGameReview({ engines }));
    await act(async () => {
      await result.current.run(PGN_3PLIES);
    });
    // На 1. e4: playedUci=e2e4 — в wdlByMove → evalMove НЕ зовётся.
    // На 2. e5: playedUci=e7e5 — нет → evalMove зовётся.
    // На 3. Nf3: playedUci=g1f3 — нет → evalMove зовётся.
    expect(engines.evalMove).toHaveBeenCalledTimes(2);
  });

  // --- KS-3616 -----------------------------------------------------------

  /**
   * Мок engines, в котором 2-й полуход (e7e5) — blunder: SF говорит
   * best=g8f6 ≠ played, wdlAfter[e7e5] = {w:0,d:0,l:1000}. На таких
   * ходах buildAnnotation вешает NAG-blunder → попадают в facts.
   */
  function blunderEngines(extra: Partial<ReviewEngines> = {}): ReviewEngines {
    const analyzeSf = vi.fn().mockImplementation((fen: string) => {
      if (fen.includes(' b ')) {
        return Promise.resolve({
          bestUci: 'g8f6',
          wdlBefore: NEUTRAL,
          wdlAfterBest: NEUTRAL,
          wdlAfterSecondBest: NEUTRAL,
          bestPv: ['g8f6'],
          wdlByMove: {
            g8f6: NEUTRAL,
            e7e5: { w: 0, d: 0, l: 1000 },
          },
          legalMovesCount: 20,
        });
      }
      return Promise.resolve({
        bestUci: 'e2e4',
        wdlBefore: NEUTRAL,
        wdlAfterBest: NEUTRAL,
        wdlAfterSecondBest: NEUTRAL,
        bestPv: ['e2e4'],
        wdlByMove: { e2e4: NEUTRAL },
        legalMovesCount: 20,
      });
    });
    return {
      analyzeSf,
      evalMove: vi.fn().mockResolvedValue(NEUTRAL),
      predictMaia: vi.fn().mockResolvedValue({
        byUci: { e2e4: 0.4, e7e5: 0.4, g8f6: 0.1 },
        topUci: 'e2e4',
        topProb: 0.4,
      }),
      terminate: vi.fn(),
      ...extra,
    };
  }

  it('KS-3616: commentsEnabled=false → moveCommentClient НЕ вызывается', async () => {
    const moveCommentClient: MoveCommentClient = vi.fn().mockResolvedValue('');
    const { result } = renderHook(() =>
      useGameReview({
        engines: blunderEngines(),
        commentsEnabled: false,
        moveCommentClient,
      }),
    );
    await act(async () => {
      await result.current.run(PGN_3PLIES);
    });
    expect(moveCommentClient).not.toHaveBeenCalled();
    expect(result.current.result?.commentByPly).toEqual({});
  });

  it('KS-3616: нет ходов с NAG → moveCommentClient НЕ вызывается', async () => {
    // mockEngines() выдаёт sf=e2e4, played=e2e4 → best; no NAG.
    const moveCommentClient: MoveCommentClient = vi.fn().mockResolvedValue('');
    const { result } = renderHook(() =>
      useGameReview({ engines: mockEngines(), moveCommentClient }),
    );
    await act(async () => {
      await result.current.run(PGN_3PLIES);
    });
    expect(moveCommentClient).not.toHaveBeenCalled();
    expect(result.current.result?.commentByPly).toEqual({});
  });

  it('KS-3712: ход с NAG → moveCommentClient вызван на каждый ход, commentByPly заполнен', async () => {
    const moveCommentClient: MoveCommentClient = vi
      .fn()
      .mockResolvedValue('Слабый ход; лучше Nf6.');
    const { result } = renderHook(() =>
      useGameReview({
        engines: blunderEngines(),
        moveCommentClient,
        createPositionalEval: null,
        openingName: 'King’s Pawn',
        userLanguage: 'ru',
        elo: 1500,
      }),
    );
    await act(async () => {
      await result.current.run(PGN_3PLIES);
    });
    expect(result.current.status).toBe('done');
    // Один blunder в PGN → один атомарный запрос.
    expect(moveCommentClient).toHaveBeenCalledTimes(1);
    const callArgs = (moveCommentClient as ReturnType<typeof vi.fn>).mock
      .calls[0];
    const request = callArgs[0] as {
      move: { uci: string; classification: string };
      before: { fen: string; factors: unknown[] };
      after: { fen: string; factors: unknown[] };
      language: string;
    };
    expect(request.move.uci).toBe('e7e5');
    expect(request.move.classification).toBe('blunder');
    expect(request.language).toBe('ru');
    expect(request.before.fen).toContain(' b ');
    expect(request.after.fen).toContain(' w ');
    // factors включают подкомпоненты + sf18_eval (+ опционально sf18_pv).
    expect(request.before.factors.length).toBeGreaterThan(0);
    expect(request.after.factors.length).toBeGreaterThan(0);
    // commentByPly: ply=2 (e5) — единственный blunder.
    expect(result.current.result?.commentByPly).toEqual({
      2: 'Слабый ход; лучше Nf6.',
    });
    expect(result.current.commentsWarning).toBe(false);
  });

  it('KS-3616: backend возвращает пустые → commentsWarning=true, дубль создаётся', async () => {
    const moveCommentClient: MoveCommentClient = vi.fn().mockResolvedValue('');
    const { result } = renderHook(() =>
      useGameReview({
        engines: blunderEngines(),
        moveCommentClient,
        createPositionalEval: null,
      }),
    );
    await act(async () => {
      await result.current.run(PGN_3PLIES);
    });
    expect(result.current.status).toBe('done');
    expect(result.current.commentsWarning).toBe(true);
    expect(result.current.result?.commentByPly).toEqual({});
    // Аннотации (NAG) при этом сохранены.
    expect(result.current.result?.annotations).toHaveLength(3);
  });

  it('KS-3616: AbortError из moveCommentClient → cancelled', async () => {
    const moveCommentClient: MoveCommentClient = vi
      .fn()
      .mockRejectedValue(new DOMException('aborted', 'AbortError'));
    const { result } = renderHook(() =>
      useGameReview({
        engines: blunderEngines(),
        moveCommentClient,
        createPositionalEval: null,
      }),
    );
    await act(async () => {
      await result.current.run(PGN_3PLIES);
    });
    expect(result.current.status).toBe('cancelled');
  });

  it('KS-3616: ошибка бэкенда (не abort) → graceful warning, status=done', async () => {
    const moveCommentClient: MoveCommentClient = vi
      .fn()
      .mockRejectedValue(new TypeError('Failed to fetch'));
    const { result } = renderHook(() =>
      useGameReview({
        engines: blunderEngines(),
        moveCommentClient,
        createPositionalEval: null,
      }),
    );
    await act(async () => {
      await result.current.run(PGN_3PLIES);
    });
    expect(result.current.status).toBe('done');
    expect(result.current.commentsWarning).toBe(true);
    expect(result.current.result?.commentByPly).toEqual({});
  });

  it('KS-3616: cancel во время comments-фазы → cancelled + abort fetch', async () => {
    let abortSignal: AbortSignal | undefined;
    const moveCommentClient: MoveCommentClient = vi
      .fn()
      .mockImplementation((_request, signal: AbortSignal | undefined) => {
        abortSignal = signal;
        return new Promise<string>((_, reject) => {
          signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        });
      });
    const { result } = renderHook(() =>
      useGameReview({
        engines: blunderEngines(),
        moveCommentClient,
        createPositionalEval: null,
      }),
    );
    let runPromise: Promise<void> | null = null;
    act(() => {
      runPromise = result.current.run(PGN_3PLIES);
    });
    // Ждём пока дойдём до comments-фазы.
    await waitFor(() =>
      expect(result.current.progress.stage).toBe('comments'),
    );
    act(() => result.current.cancel());
    await act(async () => {
      await runPromise;
    });
    expect(result.current.status).toBe('cancelled');
    expect(abortSignal?.aborted).toBe(true);
  });

  it('KS-3619: variation.finalEvalNag проставляется по WDL финальной позиции', async () => {
    // Сценарий: blunder на 2-м полуходе (e7e5 в нашем мок-движке).
    // engines.analyzeSf на финальной позиции возвращает WDL «выигран
    // белыми» → eWhite≈1.0 → ожидаем NAG_EVAL_DECISIVE_WHITE (18).
    const decisive: Wdl = { w: 950, d: 50, l: 0 };
    const analyzeSf = vi.fn().mockImplementation((fen: string) => {
      // Чёрные на ходу → blunder на e7e5.
      if (fen.includes(' b ')) {
        return Promise.resolve({
          bestUci: 'g8f6',
          wdlBefore: NEUTRAL,
          wdlAfterBest: NEUTRAL,
          wdlAfterSecondBest: NEUTRAL,
          bestPv: ['g8f6', 'd2d4', 'e7e6'],
          wdlByMove: {
            g8f6: NEUTRAL,
            e7e5: { w: 0, d: 0, l: 1000 },
          },
          legalMovesCount: 20,
        });
      }
      // Любая «дальняя» (после применения sub-line) или белый ход —
      // отдаём decisive POV white.
      return Promise.resolve({
        bestUci: 'e2e4',
        wdlBefore: decisive,
        wdlAfterBest: decisive,
        wdlAfterSecondBest: NEUTRAL,
        bestPv: ['e2e4'],
        wdlByMove: { e2e4: decisive },
        legalMovesCount: 20,
      });
    });
    const engines: ReviewEngines = {
      analyzeSf,
      evalMove: vi.fn().mockResolvedValue(NEUTRAL),
      predictMaia: vi.fn().mockResolvedValue({
        byUci: { e2e4: 0.4 },
        topUci: 'e2e4',
        topProb: 0.4,
      }),
      terminate: vi.fn(),
    };
    const { result } = renderHook(() =>
      useGameReview({ engines, commentsEnabled: false }),
    );
    await act(async () => {
      await result.current.run(PGN_3PLIES);
    });
    expect(result.current.status).toBe('done');
    // ply=2 (e7e5) — blunder, green-variation должна быть с
    // finalEvalNag=18 (+−) или 16 (±), но не undefined.
    const ann = result.current.result?.annotations.find((a) => a.ply === 2);
    const green = ann?.variations.find((v) => v.color === 'green');
    expect(green).toBeTruthy();
    expect(green?.finalEvalNag).toBeTypeOf('number');
    // По мокам — decisive POV white на финальной позиции.
    expect([16, 18]).toContain(green!.finalEvalNag);
  });

  it('reset() → idle', async () => {
    const engines = mockEngines();
    const { result } = renderHook(() => useGameReview({ engines }));
    await act(async () => {
      await result.current.run(PGN_3PLIES);
    });
    expect(result.current.status).toBe('done');
    act(() => result.current.reset());
    expect(result.current.status).toBe('idle');
  });
});
