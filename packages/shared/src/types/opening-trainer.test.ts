import { describe, it, expect, expectTypeOf } from 'vitest';
import {
  isCorrectMove,
  isWrongMove,
  isLineCompleteMove,
  isLineRestartMove,
  isTreeCompleteMove,
  OPENING_REPERTOIRE_LIMITS,
  OPENING_TRAINER_SCORING,
  OPENING_LINE_MASTERY_THRESHOLD,
  type OpeningTrainerMoveResponse,
  type OpeningTrainerMoveCorrectResponse,
  type OpeningTrainerMoveWrongResponse,
  type OpeningTrainerMoveLineCompleteResponse,
  type OpeningTrainerMoveLineRestartResponse,
  type OpeningTrainerMoveTreeCompleteResponse,
  type OpeningTrainerSessionDto,
} from './opening-trainer.js';

/**
 * KS-3269. Спека на discriminated union сужение для `/move` response'а.
 * Цель — гарантировать что фронт, проверив `result === 'correct'`, видит
 * `botMove` и `newFen`, а не получает ошибку компиляции.
 */

const baseSession: OpeningTrainerSessionDto = {
  id: 's-1',
  repertoireId: 'r-1',
  side: 'white',
  mode: 'learn',
  repeatMode: 'complete',
  status: 'active',
  currentFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  currentPath: [],
  score: 0,
  movesPlayed: 0,
  correctMoves: 0,
  wrongMoves: 0,
  hintsUsed: 0,
  startedAt: '2026-05-23T00:00:00Z',
  lastActivityAt: '2026-05-23T00:00:00Z',
  finishedAt: null,
};

describe('OpeningTrainerMoveResponse — discriminated union', () => {
  it('narrows to Correct via isCorrectMove guard', () => {
    const r: OpeningTrainerMoveResponse = {
      result: 'correct',
      applied: true,
      scoreDelta: 10,
      newFen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
      botMove: {
        moveUci: 'e7e5',
        moveSan: 'e5',
        newFen:
          'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2',
      },
      session: baseSession,
    };

    if (isCorrectMove(r)) {
      // Внутри narrowing-блока — типы доступны статически.
      expect(r.applied).toBe(true);
      expect(r.scoreDelta).toBe(10);
      expect(r.botMove?.moveSan).toBe('e5');
      expect(r.newFen).toContain('b KQkq');
      expectTypeOf(r).toEqualTypeOf<OpeningTrainerMoveCorrectResponse>();
    } else {
      throw new Error('guard should narrow correct branch');
    }
  });

  it('narrows to Wrong via isWrongMove guard', () => {
    const r: OpeningTrainerMoveResponse = {
      result: 'wrong',
      applied: false,
      scoreDelta: -5,
      expectedMoves: [{ moveUci: 'e2e4', moveSan: 'e4' }],
      session: baseSession,
    };

    if (isWrongMove(r)) {
      expect(r.applied).toBe(false);
      expect(r.expectedMoves).toHaveLength(1);
      expect(r.expectedMoves[0].moveSan).toBe('e4');
      expectTypeOf(r).toEqualTypeOf<OpeningTrainerMoveWrongResponse>();
    } else {
      throw new Error('guard should narrow wrong branch');
    }
  });

  it('narrows to LineComplete via isLineCompleteMove guard', () => {
    const r: OpeningTrainerMoveResponse = {
      result: 'line-complete',
      applied: true,
      scoreDelta: 10,
      newFen: 'rnb1kbnr/pp3ppp/2p1p3/q2pP3/3P4/2N5/PPP2PPP/R1BQKBNR w KQkq - 0 5',
      session: baseSession,
    };

    if (isLineCompleteMove(r)) {
      expect(r.applied).toBe(true);
      expect(r.newFen).toBeDefined();
      expectTypeOf(r).toEqualTypeOf<OpeningTrainerMoveLineCompleteResponse>();
    } else {
      throw new Error('guard should narrow line-complete branch');
    }
  });

  it('guards mutually exclude', () => {
    const correct: OpeningTrainerMoveResponse = {
      result: 'correct',
      applied: true,
      scoreDelta: 10,
      newFen: 'fen',
      botMove: null,
      session: baseSession,
    };
    expect(isCorrectMove(correct)).toBe(true);
    expect(isWrongMove(correct)).toBe(false);
    expect(isLineCompleteMove(correct)).toBe(false);

    const wrong: OpeningTrainerMoveResponse = {
      result: 'wrong',
      applied: false,
      scoreDelta: -5,
      expectedMoves: [],
      session: baseSession,
    };
    expect(isCorrectMove(wrong)).toBe(false);
    expect(isWrongMove(wrong)).toBe(true);
    expect(isLineCompleteMove(wrong)).toBe(false);

    const line: OpeningTrainerMoveResponse = {
      result: 'line-complete',
      applied: true,
      scoreDelta: 10,
      newFen: 'fen',
      session: baseSession,
    };
    expect(isCorrectMove(line)).toBe(false);
    expect(isWrongMove(line)).toBe(false);
    expect(isLineCompleteMove(line)).toBe(true);
  });

  it('KS-3277: narrows to LineRestart via isLineRestartMove guard', () => {
    const r: OpeningTrainerMoveResponse = {
      result: 'line-restart',
      applied: true,
      scoreDelta: 10,
      newFen: 'restart-fen',
      newPath: ['e2e4', 'e7e5'],
      botMove: { moveUci: 'g1f3', moveSan: 'Nf3', newFen: 'after-bot' },
      session: baseSession,
    };
    if (isLineRestartMove(r)) {
      expect(r.newPath).toEqual(['e2e4', 'e7e5']);
      expect(r.botMove?.moveSan).toBe('Nf3');
      expect(r.applied).toBe(true);
    } else {
      throw new Error('guard should narrow line-restart branch');
    }
  });

  it('KS-3277: narrows to TreeComplete via isTreeCompleteMove guard', () => {
    const r: OpeningTrainerMoveResponse = {
      result: 'tree-complete',
      applied: true,
      scoreDelta: 10,
      newFen: 'final-fen',
      session: baseSession,
    };
    if (isTreeCompleteMove(r)) {
      expect(r.applied).toBe(true);
      expect(r.newFen).toBe('final-fen');
    } else {
      throw new Error('guard should narrow tree-complete branch');
    }
  });

  it('switch на result даёт exhaustive coverage', () => {
    const handler = (r: OpeningTrainerMoveResponse): string => {
      switch (r.result) {
        case 'correct':
          return `+${r.scoreDelta} bot=${r.botMove?.moveSan ?? 'none'}`;
        case 'wrong':
          return `wrong expected=${r.expectedMoves.length}`;
        case 'line-complete':
          return 'done';
        case 'line-restart':
          return `restart path=${r.newPath.length}`;
        case 'tree-complete':
          return 'tree-done';
        default: {
          // Если добавится новый member union'а — TS пометит ошибкой.
          const _exhaustive: never = r;
          return _exhaustive;
        }
      }
    };

    expect(
      handler({
        result: 'correct',
        applied: true,
        scoreDelta: 11,
        newFen: 'fen',
        botMove: { moveUci: 'g8f6', moveSan: 'Nf6', newFen: 'fen2' },
        session: baseSession,
      }),
    ).toBe('+11 bot=Nf6');
    expect(
      handler({
        result: 'wrong',
        applied: false,
        scoreDelta: -5,
        expectedMoves: [
          { moveUci: 'e2e4', moveSan: 'e4' },
          { moveUci: 'd2d4', moveSan: 'd4' },
        ],
        session: baseSession,
      }),
    ).toBe('wrong expected=2');
    expect(
      handler({
        result: 'line-complete',
        applied: true,
        scoreDelta: 10,
        newFen: 'fen',
        session: baseSession,
      }),
    ).toBe('done');
  });
});

describe('OPENING_REPERTOIRE_LIMITS', () => {
  it('содержит актуальные значения после KS-3335', () => {
    // KS-3335: лимит `maxDepthHalfMoves` снят (см. opening-trainer.ts:70).
    // Пользователи добавляют полные партии — глубина > 80 ходов штатна.
    // Защита от патологических объёмов теперь только через
    // nodeCount/edgeCount/pgnBytes.
    expect(OPENING_REPERTOIRE_LIMITS.maxNodes).toBe(2000);
    expect(OPENING_REPERTOIRE_LIMITS.maxEdges).toBe(5000);
    expect(OPENING_REPERTOIRE_LIMITS.maxPgnBytes).toBe(500 * 1024);
    expect(OPENING_REPERTOIRE_LIMITS.maxRepertoiresPerUser).toBe(50);
    expect(OPENING_REPERTOIRE_LIMITS.maxActiveSessionsPerUser).toBe(10);
    // KS-3324 / ADR-078: новое поле maxSourcesPerRepertoire.
    expect(OPENING_REPERTOIRE_LIMITS.maxSourcesPerRepertoire).toBe(20);
  });

  it('KS-3416: поле maxDepthHalfMoves больше не существует (снято KS-3335)', () => {
    // Гард-инвариант: если кто-то снова добавит поле — тест попросит
    // явно обосновать (через ADR), не по undefined-проверке.
    expect(
      (OPENING_REPERTOIRE_LIMITS as Record<string, unknown>)
        .maxDepthHalfMoves,
    ).toBeUndefined();
  });
});

describe('OPENING_TRAINER_SCORING', () => {
  it('значения из ADR-077 §2.7', () => {
    expect(OPENING_TRAINER_SCORING.correctNoHint).toBe(10);
    expect(OPENING_TRAINER_SCORING.correctWithHint).toBe(5);
    expect(OPENING_TRAINER_SCORING.fastBonusMs).toBe(5000);
    expect(OPENING_TRAINER_SCORING.fastBonusPoints).toBe(1);
    expect(OPENING_TRAINER_SCORING.wrong).toBe(-5);
    expect(OPENING_TRAINER_SCORING.streakThreshold).toBe(5);
    expect(OPENING_TRAINER_SCORING.streakMultiplier).toBeCloseTo(1.2);
  });
});

describe('OPENING_LINE_MASTERY_THRESHOLD', () => {
  it('3 подряд — из ADR-077 §2.5', () => {
    expect(OPENING_LINE_MASTERY_THRESHOLD).toBe(3);
  });
});

describe('KS-3286 (M2): OpeningLineStatus + новые DTO', () => {
  it('OpeningLineStatus содержит 5 ожидаемых значений (compile-time)', async () => {
    const { type } = await import('node:os');
    void type;
    // Compile-time check через assignment — TS-ошибка если значение
    // не в union.
    const allValues: import('./opening-trainer.js').OpeningLineStatus[] = [
      'not-played',
      'learning',
      'wrong',
      'mastered',
      'due',
    ];
    expect(allValues).toHaveLength(5);
  });

  it('exhaustive switch на OpeningLineStatus с never-проверкой', async () => {
    type Status = import('./opening-trainer.js').OpeningLineStatus;
    const colorFor = (s: Status): string => {
      switch (s) {
        case 'not-played':
          return 'gray';
        case 'learning':
          return 'yellow';
        case 'wrong':
          return 'red';
        case 'mastered':
          return 'green';
        case 'due':
          return 'blue';
        default: {
          const _exhaustive: never = s;
          return _exhaustive;
        }
      }
    };
    expect(colorFor('mastered')).toBe('green');
    expect(colorFor('due')).toBe('blue');
    expect(colorFor('not-played')).toBe('gray');
  });

  it('OpeningLineProgressDto допускает opц. orphaned и status', async () => {
    type Dto = import('./opening-trainer.js').OpeningLineProgressDto;
    const base: Dto = {
      id: 'p-1',
      repertoireId: 'r-1',
      pathHash: 'abc',
      pathUci: ['e2e4'],
      pathLength: 1,
      correctCount: 1,
      wrongCount: 0,
      consecutiveCorrect: 1,
      lastPlayedAt: '2026-05-24T00:00:00Z',
      masteredAt: null,
      sm2DueAt: null,
      sm2Interval: null,
      sm2Easiness: null,
      sm2Reps: null,
    };
    expect(base.orphaned).toBeUndefined();
    expect(base.status).toBeUndefined();

    const extended: Dto = { ...base, orphaned: true, status: 'mastered' };
    expect(extended.orphaned).toBe(true);
    expect(extended.status).toBe('mastered');
  });

  it('CreateOpeningRepertoireFromAnalysisRequest минимально содержит analysisId', async () => {
    type Req =
      import('./opening-trainer.js').CreateOpeningRepertoireFromAnalysisRequest;
    const minimal: Req = { analysisId: 'a-1' };
    expect(minimal.analysisId).toBe('a-1');
    expect(minimal.title).toBeUndefined();

    const full: Req = {
      analysisId: 'a-1',
      title: 'Caro-Kann from my game',
      description: 'Imported from analysis on 2026-05-24',
    };
    expect(full.title).toBe('Caro-Kann from my game');
  });

  it('GetOpeningRepertoireActiveSessionResponse: session либо DTO либо null', async () => {
    type Resp =
      import('./opening-trainer.js').GetOpeningRepertoireActiveSessionResponse;
    const noActive: Resp = { session: null };
    expect(noActive.session).toBeNull();

    const active: Resp = {
      session: {
        id: 's-1',
        repertoireId: 'r-1',
        side: 'white',
        mode: 'learn',
        repeatMode: 'complete',
        status: 'active',
        currentFen:
          'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
        currentPath: [],
        score: 50,
        movesPlayed: 5,
        correctMoves: 5,
        wrongMoves: 0,
        hintsUsed: 0,
        startedAt: '2026-05-23T20:00:00Z',
        lastActivityAt: '2026-05-23T20:15:00Z',
        finishedAt: null,
      },
    };
    expect(active.session?.score).toBe(50);
  });
});
