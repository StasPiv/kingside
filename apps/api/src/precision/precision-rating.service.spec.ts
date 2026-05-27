/**
 * KS-3343 / ADR-079 §3.6. Юнит-тесты PrecisionRatingService.
 *
 * Покрываем acceptance-сценарии:
 *  1. Гость → skip.
 *  2. Hidden/test-аккаунт → skip.
 *  3. Self-created puzzle → skip + (regression-проверка что attempt
 *     всё равно создаётся — это в integration-тесте PuzzleService).
 *  4. score=100 (5★) → outcome=1.0, рейтинг растёт.
 *  5. KS-3372: score=81 (3★) → outcome=0.0, не растёт (бинарная схема).
 *  6. score=10 → outcome=0.0, рейтинг падает.
 *  7. Регрессия: вызов с null score → outcome=0, skip нет (рейтинг
 *     обновляется как поражение — это краевой случай для legacy).
 */
import { PrecisionRatingService } from './precision-rating.service';
import { GlickoRatingService } from '../puzzle/glicko-rating.service';

describe('PrecisionRatingService (KS-3343 / ADR-079)', () => {
  let service: PrecisionRatingService;
  let prisma: any;
  let glicko: GlickoRatingService;

  beforeEach(() => {
    prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue({
          isHidden: false,
          isTestAccount: false,
        }),
      },
      puzzle: {
        findUnique: jest.fn().mockResolvedValue({
          rating: 1500,
          createdBy: 'other-user',
        }),
      },
      userPrecisionRating: {
        findUnique: jest.fn().mockResolvedValue(null), // новый user
        upsert: jest.fn().mockResolvedValue(null),
      },
    };
    glicko = new GlickoRatingService();
    service = new PrecisionRatingService(prisma, glicko);
  });

  describe('scoreToOutcome (KS-3372 — бинарная схема: только 5★ = решено)', () => {
    it('score >= 95 (5★) → 1.0 (решено)', () => {
      expect(service.scoreToOutcome(100)).toBe(1);
      expect(service.scoreToOutcome(95)).toBe(1);
      expect(service.scoreToOutcome(97.5)).toBe(1);
    });
    it('score < 95 (1–4★) → 0.0 (не решено), включая бывший «победный» диапазон 80-94', () => {
      // 4★ (85-94) — раньше считалось победой, теперь нет.
      expect(service.scoreToOutcome(94)).toBe(0);
      expect(service.scoreToOutcome(90)).toBe(0);
      expect(service.scoreToOutcome(85)).toBe(0);
      // 3★ (70-84) — раньше частично победа, частично ничья.
      expect(service.scoreToOutcome(84)).toBe(0);
      expect(service.scoreToOutcome(81)).toBe(0); // кейс пользователя KS-3372
      expect(service.scoreToOutcome(70)).toBe(0);
      // 1-2★.
      expect(service.scoreToOutcome(50)).toBe(0);
      expect(service.scoreToOutcome(10)).toBe(0);
      expect(service.scoreToOutcome(0)).toBe(0);
    });
    it('null/undefined → 0', () => {
      expect(service.scoreToOutcome(null)).toBe(0);
      expect(service.scoreToOutcome(undefined)).toBe(0);
    });
  });

  describe('applyRatingChange skip-логика', () => {
    it('гость (userId=null) → skip', async () => {
      const r = await service.applyRatingChange(null, 'puzzle-1', 80);
      expect(r).toEqual({
        ratingBefore: null,
        ratingAfter: null,
        skipped: 'guest',
      });
      expect(prisma.userPrecisionRating.upsert).not.toHaveBeenCalled();
    });

    it('User.isHidden=true → skip', async () => {
      prisma.user.findUnique.mockResolvedValueOnce({
        isHidden: true,
        isTestAccount: false,
      });
      const r = await service.applyRatingChange('u-1', 'puzzle-1', 80);
      expect(r.skipped).toBe('hidden-or-test');
      expect(r.ratingBefore).toBeNull();
      expect(r.ratingAfter).toBeNull();
      expect(prisma.userPrecisionRating.upsert).not.toHaveBeenCalled();
    });

    it('User.isTestAccount=true → skip', async () => {
      prisma.user.findUnique.mockResolvedValueOnce({
        isHidden: false,
        isTestAccount: true,
      });
      const r = await service.applyRatingChange('u-1', 'puzzle-1', 80);
      expect(r.skipped).toBe('hidden-or-test');
    });

    it('user не найден → skip hidden-or-test', async () => {
      prisma.user.findUnique.mockResolvedValueOnce(null);
      const r = await service.applyRatingChange('u-1', 'puzzle-1', 80);
      expect(r.skipped).toBe('hidden-or-test');
    });

    it('self-created puzzle → skip (anti-cheat KS-3339 ревизия 3)', async () => {
      prisma.puzzle.findUnique.mockResolvedValueOnce({
        rating: 1500,
        createdBy: 'u-1', // тот же что и userId
      });
      const r = await service.applyRatingChange('u-1', 'puzzle-1', 100);
      expect(r.skipped).toBe('self-created');
      expect(r.ratingBefore).toBeNull();
      expect(prisma.userPrecisionRating.upsert).not.toHaveBeenCalled();
    });

    it('puzzle не найден → skip no-puzzle', async () => {
      prisma.puzzle.findUnique.mockResolvedValueOnce(null);
      const r = await service.applyRatingChange('u-1', 'puzzle-1', 100);
      expect(r.skipped).toBe('no-puzzle');
    });
  });

  describe('applyRatingChange — обновление рейтинга', () => {
    it('score=100 (5★, решено): рейтинг растёт против равного соперника', async () => {
      // user без записи → default 1500/350, puzzle 1500.
      const r = await service.applyRatingChange('u-1', 'puzzle-1', 100);
      expect(r.skipped).toBeUndefined();
      expect(r.ratingBefore).toBe(1500);
      expect(r.ratingAfter).toBeGreaterThan(1500);
      // upsert с новым рейтингом и новой деривацией.
      expect(prisma.userPrecisionRating.upsert).toHaveBeenCalledTimes(1);
      const upsertArg = prisma.userPrecisionRating.upsert.mock.calls[0][0];
      expect(upsertArg.where).toEqual({ userId: 'u-1' });
      expect(upsertArg.create.rating).toBe(r.ratingAfter);
      expect(upsertArg.create.deviation).toBeLessThan(350); // RD сужается
      expect(upsertArg.create.attempts).toBe(1);
      expect(upsertArg.update.attempts).toBe(1); // attempts=0+1
    });

    it('KS-3372: score=81 (3★, не решено): рейтинг падает (раньше +24, теперь 0.0)', async () => {
      // Кейс пользователя из задачи: 81% точности при 3★. Раньше
      // outcome=1.0 → рейтинг +24. Теперь outcome=0.0 → поражение.
      const r = await service.applyRatingChange('u-1', 'puzzle-1', 81);
      expect(r.ratingBefore).toBe(1500);
      expect(r.ratingAfter).toBeLessThan(1500);
    });

    it('KS-3372: score=94 (4★, не решено по бинару): рейтинг тоже падает', async () => {
      const r = await service.applyRatingChange('u-1', 'puzzle-1', 94);
      expect(r.ratingBefore).toBe(1500);
      expect(r.ratingAfter).toBeLessThan(1500);
    });

    it('score=10 (1★, не решено): рейтинг падает', async () => {
      const r = await service.applyRatingChange('u-1', 'puzzle-1', 10);
      expect(r.ratingBefore).toBe(1500);
      expect(r.ratingAfter).toBeLessThan(1500);
    });

    it('puzzle.rating=null → fallback 1500', async () => {
      prisma.puzzle.findUnique.mockResolvedValueOnce({
        rating: null,
        createdBy: 'other',
      });
      const r = await service.applyRatingChange('u-1', 'puzzle-1', 100);
      expect(r.skipped).toBeUndefined();
      // против 1500 fallback при равном рейтинге — растём.
      expect(r.ratingAfter).toBeGreaterThan(1500);
    });

    it('существующий рейтинг 1800/100 → используется как ratingBefore', async () => {
      prisma.userPrecisionRating.findUnique.mockResolvedValueOnce({
        rating: 1800,
        deviation: 100,
        attempts: 25,
      });
      const r = await service.applyRatingChange('u-1', 'puzzle-1', 100);
      expect(r.ratingBefore).toBe(1800);
      // puzzle=1500, user=1800, score=1 → expected≈0.85, gain мал.
      expect(r.ratingAfter).toBeGreaterThan(1800);
      const upsertArg = prisma.userPrecisionRating.upsert.mock.calls[0][0];
      expect(upsertArg.update.attempts).toBe(26); // 25+1
    });

    it('null score (legacy) → outcome 0 → рейтинг падает', async () => {
      const r = await service.applyRatingChange('u-1', 'puzzle-1', null);
      expect(r.skipped).toBeUndefined();
      // outcome=0, поражение.
      expect(r.ratingAfter).toBeLessThan(1500);
    });
  });
});
