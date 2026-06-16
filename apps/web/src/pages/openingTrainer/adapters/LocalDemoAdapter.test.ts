/**
 * KS-4277. Юнит-тесты `LocalDemoAdapter` — гарантируем, что вся логика
 * демо-репертуара (валидация по дереву, прогресс в localStorage,
 * бот-ход первым edge) живёт в адаптере и Player'у достаточно
 * принимать outcome.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  LocalDemoAdapter,
  localDemoStorageKey,
  LocalDemoNotFoundError,
} from './LocalDemoAdapter';
import { openingTrainerApi } from '../../../api/openingTrainerApi';
import { ApiError } from '../../../ApiError';

vi.mock('../../../api/openingTrainerApi', () => ({
  openingTrainerApi: {
    getDemoRepertoire: vi.fn(),
  },
}));

const mockedApi = vi.mocked(openingTrainerApi);

const ROOT = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const AFTER_E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
const AFTER_E5 = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2';

function makeDemo() {
  return {
    id: 'london-system-white',
    ownerId: 'demo',
    title: 'Demo: King’s pawn',
    description: 'e4 e5',
    side: 'white' as const,
    nodeCount: 3,
    edgeCount: 2,
    maxDepth: 2,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    pgn: '',
    sources: [],
    tree: {
      rootFen: ROOT,
      nodes: {
        [ROOT]: {
          fen: ROOT,
          edges: [
            { moveUci: 'e2e4', moveSan: 'e4', childFen: AFTER_E4 },
          ],
        },
        [AFTER_E4]: {
          fen: AFTER_E4,
          edges: [
            { moveUci: 'e7e5', moveSan: 'e5', childFen: AFTER_E5 },
          ],
        },
        [AFTER_E5]: { fen: AFTER_E5, edges: [] },
      },
    },
  };
}

describe('LocalDemoAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('loadInitial: возвращает rootFen, side и пустые counters', async () => {
    mockedApi.getDemoRepertoire.mockResolvedValue(makeDemo());
    const adapter = new LocalDemoAdapter('demo-1');
    const state = await adapter.loadInitial();
    expect(state.currentFen).toBe(ROOT);
    expect(state.side).toBe('white');
    expect(state.counters).toMatchObject({
      score: 0,
      correctMoves: 0,
      wrongMoves: 0,
      hintsUsed: 0,
    });
  });

  it('loadInitial: 404 → LocalDemoNotFoundError', async () => {
    mockedApi.getDemoRepertoire.mockRejectedValue(
      new ApiError('not found', 'NOT_FOUND', 404),
    );
    const adapter = new LocalDemoAdapter('demo-1');
    await expect(adapter.loadInitial()).rejects.toBeInstanceOf(
      LocalDemoNotFoundError,
    );
  });

  it('submitMove: правильный ход → correct + бот-ход первым edge', async () => {
    mockedApi.getDemoRepertoire.mockResolvedValue(makeDemo());
    const adapter = new LocalDemoAdapter('demo-1');
    await adapter.loadInitial();
    const outcome = await adapter.submitMove({
      moveUci: 'e2e4',
      positionShownAtMs: Date.now(),
    });
    expect(outcome.kind).toBe('correct');
    if (outcome.kind !== 'correct') return; // narrow
    expect(outcome.newFen).toBe(AFTER_E4);
    expect(outcome.counters.score).toBe(10);
    expect(outcome.counters.correctMoves).toBe(1);
    expect(outcome.botMove?.moveUci).toBe('e7e5');
    expect(outcome.botMove?.newFen).toBe(AFTER_E5);
  });

  it('submitMove: неверный ход → wrong с resetDelayMs=600', async () => {
    mockedApi.getDemoRepertoire.mockResolvedValue(makeDemo());
    const adapter = new LocalDemoAdapter('demo-1');
    await adapter.loadInitial();
    const outcome = await adapter.submitMove({
      moveUci: 'g1f3',
      positionShownAtMs: Date.now(),
    });
    expect(outcome.kind).toBe('wrong');
    if (outcome.kind !== 'wrong') return;
    expect(outcome.resetDelayMs).toBe(600);
    expect(outcome.newFen).toBe(ROOT);
    expect(outcome.expected).toEqual([
      { moveUci: 'e2e4', moveSan: 'e4' },
    ]);
    expect(outcome.counters.wrongMoves).toBe(1);
  });

  it('requestHint: первая edge + инкремент hintsUsed', async () => {
    mockedApi.getDemoRepertoire.mockResolvedValue(makeDemo());
    const adapter = new LocalDemoAdapter('demo-1');
    await adapter.loadInitial();
    const hint = await adapter.requestHint();
    expect(hint.moveUci).toBe('e2e4');
    expect(hint.moveSan).toBe('e4');
    expect(hint.counters.hintsUsed).toBe(1);
  });

  it('restartLine: возвращает доску на rootFen, прогресс сохраняется', async () => {
    mockedApi.getDemoRepertoire.mockResolvedValue(makeDemo());
    const adapter = new LocalDemoAdapter('demo-1');
    await adapter.loadInitial();
    await adapter.submitMove({
      moveUci: 'e2e4',
      positionShownAtMs: Date.now(),
    });
    const restarted = await adapter.restartLine();
    expect(restarted.currentFen).toBe(ROOT);
    expect(restarted.counters.score).toBe(10); // не сброшен
  });

  it('resetProgress: очищает localStorage и обнуляет счётчики', async () => {
    mockedApi.getDemoRepertoire.mockResolvedValue(makeDemo());
    const adapter = new LocalDemoAdapter('demo-1');
    await adapter.loadInitial();
    await adapter.submitMove({
      moveUci: 'e2e4',
      positionShownAtMs: Date.now(),
    });
    expect(
      JSON.parse(localStorage.getItem(localDemoStorageKey('demo-1')) ?? '{}')
        .score,
    ).toBe(10);
    const reset = await adapter.resetProgress();
    expect(reset.counters.score).toBe(0);
    expect(reset.counters.correctMoves).toBe(0);
    expect(reset.currentFen).toBe(ROOT);
    expect(
      JSON.parse(localStorage.getItem(localDemoStorageKey('demo-1')) ?? '{}')
        .score,
    ).toBe(0);
  });

  it('восстановление из localStorage при повторном loadInitial', async () => {
    localStorage.setItem(
      localDemoStorageKey('demo-1'),
      JSON.stringify({
        score: 42,
        correctMoves: 4,
        wrongMoves: 1,
        hintsUsed: 2,
        learnedFens: [ROOT],
      }),
    );
    mockedApi.getDemoRepertoire.mockResolvedValue(makeDemo());
    const adapter = new LocalDemoAdapter('demo-1');
    const state = await adapter.loadInitial();
    expect(state.counters.score).toBe(42);
    expect(state.counters.correctMoves).toBe(4);
    expect(state.counters.wrongMoves).toBe(1);
    expect(state.counters.hintsUsed).toBe(2);
  });
});
