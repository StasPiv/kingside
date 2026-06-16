/**
 * KS-4277. Юнит-тесты `ServerSessionAdapter` — проверяем что адаптер
 * пробрасывает discriminated union из `/move` в общий
 * `OpeningTrainerOutcome` без потерь полей (`scoreDelta`, `botMove`,
 * `expectedMoves`).
 *
 * Streak вычисляется в адаптере по дельте `correctMoves`/`wrongMoves`
 * (M1 backend не возвращает counter явно).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ServerSessionAdapter } from './ServerSessionAdapter';
import { openingTrainerApi } from '../../../api/openingTrainerApi';
import type {
  OpeningTrainerMoveResponse,
  OpeningTrainerSessionDto,
} from '@kingside/shared';

vi.mock('../../../api/openingTrainerApi', () => ({
  openingTrainerApi: {
    getSession: vi.fn(),
    sendMove: vi.fn(),
    hint: vi.fn(),
    undo: vi.fn(),
    giveup: vi.fn(),
    finish: vi.fn(),
  },
}));

const mockedApi = vi.mocked(openingTrainerApi);

const START_FEN =
  'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const E4_FEN =
  'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';

function makeSession(
  overrides: Partial<OpeningTrainerSessionDto> = {},
): OpeningTrainerSessionDto {
  return {
    id: 's1',
    repertoireId: 'r1',
    side: 'white',
    mode: 'learn',
    repeatMode: 'complete',
    status: 'active',
    currentFen: START_FEN,
    currentPath: [],
    score: 0,
    movesPlayed: 0,
    correctMoves: 0,
    wrongMoves: 0,
    hintsUsed: 0,
    accuracyPercent: 0,
    startedAt: '2026-05-23T00:00:00Z',
    lastActivityAt: '2026-05-23T00:00:00Z',
    finishedAt: null,
    ...overrides,
  };
}

describe('ServerSessionAdapter', () => {
  beforeEach(() => vi.clearAllMocks());

  it('loadInitial: при initialSession в options не зовёт API', async () => {
    const adapter = new ServerSessionAdapter('r1', 's1', {
      initialSession: makeSession(),
    });
    const state = await adapter.loadInitial();
    expect(mockedApi.getSession).not.toHaveBeenCalled();
    expect(state.currentFen).toBe(START_FEN);
    expect(state.side).toBe('white');
  });

  it('loadInitial: без initialSession — getSession', async () => {
    mockedApi.getSession.mockResolvedValue({
      session: makeSession({ side: 'black' }),
    });
    const adapter = new ServerSessionAdapter('r1', 's1');
    const state = await adapter.loadInitial();
    expect(mockedApi.getSession).toHaveBeenCalledWith('s1');
    expect(state.side).toBe('black');
  });

  it('submitMove → correct: пробрасывает scoreDelta и botMove', async () => {
    const adapter = new ServerSessionAdapter('r1', 's1', {
      initialSession: makeSession(),
    });
    await adapter.loadInitial();
    const res: OpeningTrainerMoveResponse = {
      result: 'correct',
      applied: true,
      scoreDelta: 12,
      newFen: E4_FEN,
      botMove: { moveUci: 'e7e5', moveSan: 'e5', newFen: 'after-e5' },
      session: makeSession({
        correctMoves: 1,
        movesPlayed: 1,
        score: 12,
        currentFen: E4_FEN,
      }),
    };
    mockedApi.sendMove.mockResolvedValue(res);
    const outcome = await adapter.submitMove({
      moveUci: 'e2e4',
      positionShownAtMs: Date.now() - 1000,
    });
    expect(outcome.kind).toBe('correct');
    if (outcome.kind !== 'correct') return;
    expect(outcome.scoreDelta).toBe(12);
    expect(outcome.botMove?.moveUci).toBe('e7e5');
    expect(outcome.counters.score).toBe(12);
  });

  it('submitMove → wrong: возвращает session.currentFen и resetDelayMs=0', async () => {
    const adapter = new ServerSessionAdapter('r1', 's1', {
      initialSession: makeSession(),
    });
    await adapter.loadInitial();
    const res: OpeningTrainerMoveResponse = {
      result: 'wrong',
      applied: false,
      scoreDelta: -5,
      expectedMoves: [{ moveUci: 'e2e4', moveSan: 'e4' }],
      session: makeSession({
        currentFen: START_FEN,
        wrongMoves: 1,
      }),
    };
    mockedApi.sendMove.mockResolvedValue(res);
    const outcome = await adapter.submitMove({
      moveUci: 'g1f3',
      positionShownAtMs: Date.now(),
    });
    expect(outcome.kind).toBe('wrong');
    if (outcome.kind !== 'wrong') return;
    expect(outcome.resetDelayMs).toBe(0);
    expect(outcome.newFen).toBe(START_FEN);
    expect(outcome.expected).toEqual([{ moveUci: 'e2e4', moveSan: 'e4' }]);
  });

  it('submitMove → tree-complete: возвращает resultRoute', async () => {
    const adapter = new ServerSessionAdapter('r1', 's1', {
      initialSession: makeSession(),
    });
    await adapter.loadInitial();
    mockedApi.sendMove.mockResolvedValue({
      result: 'tree-complete',
      applied: true,
      scoreDelta: 10,
      newFen: E4_FEN,
      session: makeSession({ status: 'active', correctMoves: 99 }),
    });
    const outcome = await adapter.submitMove({
      moveUci: 'e2e4',
      positionShownAtMs: Date.now(),
    });
    expect(outcome.kind).toBe('tree-complete');
    if (outcome.kind !== 'tree-complete') return;
    expect(outcome.resultRoute).toBe(
      '/opening-trainer/r1/session/s1/result',
    );
  });

  it('streak: растёт на correct, сбрасывается на wrong', async () => {
    const adapter = new ServerSessionAdapter('r1', 's1', {
      initialSession: makeSession(),
    });
    await adapter.loadInitial();
    // 3 правильных подряд
    for (let i = 1; i <= 3; i++) {
      mockedApi.sendMove.mockResolvedValueOnce({
        result: 'correct',
        applied: true,
        scoreDelta: 10,
        newFen: E4_FEN,
        botMove: null,
        session: makeSession({ correctMoves: i, movesPlayed: i }),
      });
      const outcome = await adapter.submitMove({
        moveUci: 'e2e4',
        positionShownAtMs: Date.now(),
      });
      expect(outcome.counters.streak).toBe(i);
    }
    // wrong → streak=0
    mockedApi.sendMove.mockResolvedValueOnce({
      result: 'wrong',
      applied: false,
      scoreDelta: -5,
      expectedMoves: [],
      session: makeSession({ correctMoves: 3, wrongMoves: 1, movesPlayed: 4 }),
    });
    const wrong = await adapter.submitMove({
      moveUci: 'a2a3',
      positionShownAtMs: Date.now(),
    });
    expect(wrong.counters.streak).toBe(0);
  });

  it('requestHint: пробрасывает hint и обновляет hintsUsed', async () => {
    const adapter = new ServerSessionAdapter('r1', 's1', {
      initialSession: makeSession(),
    });
    await adapter.loadInitial();
    mockedApi.hint.mockResolvedValue({
      hint: { moveUci: 'e2e4', moveSan: 'e4' },
      session: makeSession({ hintsUsed: 1 }),
    });
    const out = await adapter.requestHint();
    expect(out.moveUci).toBe('e2e4');
    expect(out.counters.hintsUsed).toBe(1);
  });

  it('giveup: возвращает wrong-outcome c botMove и lastMoveUci', async () => {
    const adapter = new ServerSessionAdapter('r1', 's1', {
      initialSession: makeSession(),
    });
    await adapter.loadInitial();
    mockedApi.giveup.mockResolvedValue({
      newFen: E4_FEN,
      botMove: { moveUci: 'e7e5', moveSan: 'e5', newFen: 'after-e5' },
      expectedMoves: [{ moveUci: 'e2e4', moveSan: 'e4' }],
      session: makeSession({ wrongMoves: 1 }),
    });
    const outcome = await adapter.giveup();
    expect(outcome.kind).toBe('wrong');
    if (outcome.kind !== 'wrong') return;
    expect(outcome.botMove?.moveUci).toBe('e7e5');
    expect(outcome.lastMoveUci).toBe('e7e5');
    expect(outcome.newFen).toBe('after-e5');
  });

  it('finishSession: POST /finish + resultRoute', async () => {
    const adapter = new ServerSessionAdapter('r1', 's1', {
      initialSession: makeSession(),
    });
    await adapter.loadInitial();
    mockedApi.finish.mockResolvedValue({
      session: makeSession({ status: 'finished' }),
      summary: { score: 0, correctMoves: 0, wrongMoves: 0, hintsUsed: 0 },
    } as never);
    const out = await adapter.finishSession();
    expect(mockedApi.finish).toHaveBeenCalledWith('s1');
    expect(out.resultRoute).toBe(
      '/opening-trainer/r1/session/s1/result',
    );
  });
});
