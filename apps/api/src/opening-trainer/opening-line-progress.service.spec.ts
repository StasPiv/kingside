import { OpeningLineProgressService } from './opening-line-progress.service';
import { OpeningTrainerRepository } from './opening-trainer.repository';
import { pathHash } from './path-hash';

/**
 * KS-3288 (M2 §2.5). 8 юнит-тестов из плана KS-3285:
 *  1. Новый attempt.
 *  2. Правильный без мастеринга.
 *  3. Правильный с мастерингом (переход consec>=3, masteredAt=now, SM-2 init).
 *  4. Wrong-reset (consec→0, wrongCount++).
 *  5. Правильный после mastered (counter растёт, masteredAt не меняется,
 *     SM-2 не реинициализируется).
 *  6. Идемпотентность вызова на одной и той же позиции.
 *  7. Orphan не апдейтится.
 *  8. Concurrent upsert OK (через моки — реальная конкуренция в repo).
 */

function makeRepo(initial: {
  existing?: Awaited<
    ReturnType<OpeningTrainerRepository['findLineProgress']>
  >;
} = {}) {
  let row: any = initial.existing ?? null;
  const find = jest.fn(async () => row);
  const upsert = jest.fn(async (uid, rid, hash, createData, updateData) => {
    if (row === null) {
      row = {
        id: 'lp-1',
        userId: uid,
        repertoireId: rid,
        pathHash: hash,
        ...createData,
        orphaned: createData.orphaned ?? false,
      };
    } else {
      row = { ...row, ...updateData };
    }
    return row;
  });
  return {
    repo: {
      findLineProgress: find,
      upsertLineProgress: upsert,
    } as unknown as OpeningTrainerRepository,
    getRow: () => row,
    find,
    upsert,
  };
}

const USER = '00000000-0000-0000-0000-000000000001';
const REP = '00000000-0000-0000-0000-000000000002';
const PATH = ['e2e4', 'e7e5'];
const NOW = new Date('2026-05-24T00:00:00Z');

describe('OpeningLineProgressService.recordAttempt', () => {
  it('1. Новый attempt (correct) → создаёт row с правильными counter\'ами', async () => {
    const { repo, find, upsert, getRow } = makeRepo();
    const svc = new OpeningLineProgressService(repo);

    await svc.recordAttempt({
      userId: USER,
      repertoireId: REP,
      pathUci: PATH,
      correct: true,
      now: NOW,
    });

    expect(find).toHaveBeenCalledWith(USER, REP, pathHash(PATH));
    expect(upsert).toHaveBeenCalled();
    const row = getRow();
    expect(row.correctCount).toBe(1);
    expect(row.wrongCount).toBe(0);
    expect(row.consecutiveCorrect).toBe(1);
    expect(row.masteredAt).toBeNull();
    expect(row.sm2Easiness).toBeNull();
    expect(row.lastPlayedAt).toEqual(NOW);
  });

  it('2. 2 правильных подряд без мастеринга (< 3 порог)', async () => {
    const { repo, getRow } = makeRepo({
      existing: {
        correctCount: 1,
        wrongCount: 0,
        consecutiveCorrect: 1,
        masteredAt: null,
        sm2Easiness: null,
        sm2Interval: null,
        sm2DueAt: null,
        sm2Reps: null,
        orphaned: false,
      } as any,
    });
    const svc = new OpeningLineProgressService(repo);

    await svc.recordAttempt({
      userId: USER,
      repertoireId: REP,
      pathUci: PATH,
      correct: true,
      now: NOW,
    });

    const row = getRow();
    expect(row.consecutiveCorrect).toBe(2);
    expect(row.correctCount).toBe(2);
    expect(row.masteredAt).toBeNull();
    expect(row.sm2Easiness).toBeNull();
  });

  it('3. 3-й правильный подряд → mastered + SM-2 init с quality=5', async () => {
    const { repo, getRow } = makeRepo({
      existing: {
        correctCount: 2,
        wrongCount: 0,
        consecutiveCorrect: 2,
        masteredAt: null,
        sm2Easiness: null,
        sm2Interval: null,
        sm2DueAt: null,
        sm2Reps: null,
        orphaned: false,
      } as any,
    });
    const svc = new OpeningLineProgressService(repo);

    await svc.recordAttempt({
      userId: USER,
      repertoireId: REP,
      pathUci: PATH,
      correct: true,
      now: NOW,
    });

    const row = getRow();
    expect(row.consecutiveCorrect).toBe(3);
    expect(row.masteredAt).toEqual(NOW);
    expect(row.sm2Easiness).toBeCloseTo(2.6, 5); // 2.5 + 0.1 for q=5
    expect(row.sm2Interval).toBe(1);
    expect(row.sm2Reps).toBe(1);
    expect(row.sm2DueAt).toEqual(
      new Date(NOW.getTime() + 1 * 24 * 60 * 60 * 1000),
    );
  });

  it('4. Wrong → сброс consec=0, wrongCount++, mastered не сбрасывается', async () => {
    const masteredAt = new Date('2026-05-20T00:00:00Z');
    const { repo, getRow } = makeRepo({
      existing: {
        correctCount: 5,
        wrongCount: 0,
        consecutiveCorrect: 5,
        masteredAt,
        sm2Easiness: 2.6,
        sm2Interval: 6,
        sm2DueAt: new Date('2026-05-26T00:00:00Z'),
        sm2Reps: 2,
        orphaned: false,
      } as any,
    });
    const svc = new OpeningLineProgressService(repo);

    await svc.recordAttempt({
      userId: USER,
      repertoireId: REP,
      pathUci: PATH,
      correct: false,
      now: NOW,
    });

    const row = getRow();
    expect(row.consecutiveCorrect).toBe(0);
    expect(row.wrongCount).toBe(1);
    expect(row.correctCount).toBe(5);
    expect(row.masteredAt).toEqual(masteredAt); // не сбрасывается
    expect(row.sm2Easiness).toBe(2.6); // SM-2 поля не трогаются recordAttempt'ом
  });

  it('5. Правильный после mastered → counter растёт, SM-2 не реинициализируется', async () => {
    const masteredAt = new Date('2026-05-20T00:00:00Z');
    const sm2Due = new Date('2026-05-26T00:00:00Z');
    const { repo, getRow } = makeRepo({
      existing: {
        correctCount: 3,
        wrongCount: 0,
        consecutiveCorrect: 3,
        masteredAt,
        sm2Easiness: 2.6,
        sm2Interval: 1,
        sm2DueAt: sm2Due,
        sm2Reps: 1,
        orphaned: false,
      } as any,
    });
    const svc = new OpeningLineProgressService(repo);

    await svc.recordAttempt({
      userId: USER,
      repertoireId: REP,
      pathUci: PATH,
      correct: true,
      now: NOW,
    });

    const row = getRow();
    expect(row.correctCount).toBe(4);
    expect(row.consecutiveCorrect).toBe(4);
    expect(row.masteredAt).toEqual(masteredAt); // не меняется
    expect(row.sm2Easiness).toBe(2.6); // SM-2 не реинициализируется
    expect(row.sm2Interval).toBe(1);
    expect(row.sm2DueAt).toEqual(sm2Due);
  });

  it('6. Идемпотентность: повторный вызов с тем же state даёт одинаковый результат', async () => {
    // recordAttempt — НЕ идемпотентен по semantics (каждый вызов
    // инкрементирует counter). Здесь проверяем: 2 одинаковых вызова
    // дают correctCount=2 (а не 1), но не падают.
    const { repo, getRow } = makeRepo();
    const svc = new OpeningLineProgressService(repo);
    await svc.recordAttempt({
      userId: USER,
      repertoireId: REP,
      pathUci: PATH,
      correct: true,
      now: NOW,
    });
    expect(getRow().correctCount).toBe(1);
    await svc.recordAttempt({
      userId: USER,
      repertoireId: REP,
      pathUci: PATH,
      correct: true,
      now: NOW,
    });
    expect(getRow().correctCount).toBe(2);
  });

  it('7. Orphan не апдейтится', async () => {
    const { repo, getRow, upsert } = makeRepo({
      existing: {
        correctCount: 5,
        wrongCount: 1,
        consecutiveCorrect: 0,
        masteredAt: null,
        sm2Easiness: null,
        sm2Interval: null,
        sm2DueAt: null,
        sm2Reps: null,
        orphaned: true,
      } as any,
    });
    const svc = new OpeningLineProgressService(repo);
    await svc.recordAttempt({
      userId: USER,
      repertoireId: REP,
      pathUci: PATH,
      correct: true,
      now: NOW,
    });
    expect(upsert).not.toHaveBeenCalled();
    expect(getRow().correctCount).toBe(5); // не изменился
  });

  it('8. Concurrent upsert: упроск через UNIQUE+ON CONFLICT (smoke)', async () => {
    // Реальная конкуренция — на уровне prisma+postgres. Тут sanity
    // что service не падает при race-условии (ON CONFLICT в Prisma
    // handle'ит race автоматически).
    const { repo } = makeRepo();
    const svc = new OpeningLineProgressService(repo);
    await Promise.all([
      svc.recordAttempt({
        userId: USER,
        repertoireId: REP,
        pathUci: PATH,
        correct: true,
        now: NOW,
      }),
      svc.recordAttempt({
        userId: USER,
        repertoireId: REP,
        pathUci: PATH,
        correct: true,
        now: NOW,
      }),
    ]);
    // Нет throw — pass. Реальная concurrency-проверка в B3 integration.
  });
});

describe('OpeningLineProgressService.applyReviewResult (KS-3290 B4 prep)', () => {
  it('clean line-complete (quality=5) → продвигает SM-2', async () => {
    const { repo, getRow } = makeRepo({
      existing: {
        correctCount: 3,
        wrongCount: 0,
        consecutiveCorrect: 3,
        masteredAt: new Date('2026-05-20T00:00:00Z'),
        sm2Easiness: 2.6,
        sm2Interval: 1,
        sm2DueAt: new Date('2026-05-21T00:00:00Z'),
        sm2Reps: 1,
        orphaned: false,
      } as any,
    });
    const svc = new OpeningLineProgressService(repo);
    await svc.applyReviewResult({
      userId: USER,
      repertoireId: REP,
      pathUci: PATH,
      quality: 5,
      now: NOW,
    });
    const row = getRow();
    // SM-2: reps=1, q=5, interval=1 → reps=2, interval=6, easiness up.
    expect(row.sm2Reps).toBe(2);
    expect(row.sm2Interval).toBe(6);
    expect(row.sm2DueAt).toEqual(
      new Date(NOW.getTime() + 6 * 24 * 60 * 60 * 1000),
    );
  });

  it('wrong на review (quality=1) → reset interval=1', async () => {
    const { repo, getRow } = makeRepo({
      existing: {
        correctCount: 5,
        wrongCount: 0,
        consecutiveCorrect: 5,
        masteredAt: new Date('2026-05-20T00:00:00Z'),
        sm2Easiness: 2.8,
        sm2Interval: 30,
        sm2DueAt: new Date('2026-06-19T00:00:00Z'),
        sm2Reps: 5,
        orphaned: false,
      } as any,
    });
    const svc = new OpeningLineProgressService(repo);
    await svc.applyReviewResult({
      userId: USER,
      repertoireId: REP,
      pathUci: PATH,
      quality: 1,
      now: NOW,
    });
    const row = getRow();
    expect(row.sm2Reps).toBe(0); // reset
    expect(row.sm2Interval).toBe(1); // reset to 1 day
    expect(row.masteredAt).toEqual(new Date('2026-05-20T00:00:00Z')); // не сброшен
  });

  it('orphan → не апдейтится', async () => {
    const { repo, upsert } = makeRepo({
      existing: {
        correctCount: 5,
        wrongCount: 1,
        consecutiveCorrect: 0,
        masteredAt: new Date('2026-05-20T00:00:00Z'),
        sm2Easiness: 2.5,
        sm2Interval: 1,
        sm2DueAt: new Date('2026-05-21T00:00:00Z'),
        sm2Reps: 1,
        orphaned: true,
      } as any,
    });
    const svc = new OpeningLineProgressService(repo);
    await svc.applyReviewResult({
      userId: USER,
      repertoireId: REP,
      pathUci: PATH,
      quality: 5,
      now: NOW,
    });
    expect(upsert).not.toHaveBeenCalled();
  });

  it('нет существующего row → no-op (warn в лог)', async () => {
    const { repo, upsert } = makeRepo();
    const svc = new OpeningLineProgressService(repo);
    const r = await svc.applyReviewResult({
      userId: USER,
      repertoireId: REP,
      pathUci: PATH,
      quality: 5,
      now: NOW,
    });
    expect(r).toBeNull();
    expect(upsert).not.toHaveBeenCalled();
  });
});
