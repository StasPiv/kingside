import {
  StudyPlanGeneratorService,
  StudyProfile,
} from './study-plan-generator.service';

/** Базовый профиль: нет due, нет истории, есть слабая тема и урок. */
function profile(overrides: Partial<StudyProfile> = {}): StudyProfile {
  return {
    ratingPuzzle: 1500,
    dueReviewLessonIds: [],
    weakThemes: [{ theme: 'fork', attempted: 20, rate: 45 }],
    nextLesson: { lessonId: 'l1', courseId: 'c1', courseSlug: 'basics', estMinutes: 10 },
    recentThemeSolveRate: null,
    recentCompletionRates: [],
    practiceLastUsedAt: {},
    carryOver: { sm2LessonIds: [], theme: null },
    ...overrides,
  };
}

describe('StudyPlanGeneratorService (правила §2, KS-4881)', () => {
  let gen: StudyPlanGeneratorService;

  beforeEach(() => {
    gen = new StudyPlanGeneratorService();
  });

  describe('состав занятия (§2.2)', () => {
    it('бюджет 30: тактика + урок; практика (10 мин) уже не влезает', () => {
      const plan = gen.buildPlan(profile(), 30);
      expect(plan.map((t) => t.type)).toEqual(['puzzle_theme', 'lesson']);
    });

    it('бюджет 45: тактика + урок + практика (3 блока)', () => {
      const plan = gen.buildPlan(profile(), 45);
      expect(plan.map((t) => t.type)).toEqual(['puzzle_theme', 'lesson', 'mistakes']);
    });

    it('с SM-2 due: SM-2 первым, максимум 2 повторения', () => {
      const plan = gen.buildPlan(
        profile({ dueReviewLessonIds: ['a', 'b', 'c'] }),
        30,
      );
      expect(plan[0].type).toBe('sm2_review');
      expect(plan[0].params.lessonIds).toEqual(['a', 'b']);
      expect(plan[0].targetCount).toBe(2);
    });

    it('тактика берёт худшую слабую тему и окно −100…+50', () => {
      const plan = gen.buildPlan(
        profile({
          weakThemes: [
            { theme: 'pin', attempted: 15, rate: 30 },
            { theme: 'fork', attempted: 20, rate: 50 },
          ],
        }),
        30,
      );
      const tactics = plan.find((t) => t.type === 'puzzle_theme')!;
      expect(tactics.params.theme).toBe('pin');
      expect(tactics.params.ratingMin).toBe(1400);
      expect(tactics.params.ratingMax).toBe(1550);
    });

    it('нет слабых тем → тактика без темы (mix)', () => {
      const plan = gen.buildPlan(profile({ weakThemes: [] }), 30);
      const tactics = plan.find((t) => t.type === 'puzzle_theme')!;
      expect(tactics.params.theme).toBeNull();
    });

    it('количество пазлов в границах 8–12', () => {
      for (const minutes of [10, 30, 60, 180]) {
        const plan = gen.buildPlan(profile(), minutes);
        const tactics = plan.find((t) => t.type === 'puzzle_theme')!;
        expect(tactics.targetCount).toBeGreaterThanOrEqual(8);
        expect(tactics.targetCount).toBeLessThanOrEqual(12);
      }
    });

    it('урок не назначается, если estMinutes больше остатка бюджета', () => {
      const plan = gen.buildPlan(
        profile({
          nextLesson: { lessonId: 'l1', courseId: 'c1', courseSlug: 'basics', estMinutes: 60 },
        }),
        30,
      );
      expect(plan.find((t) => t.type === 'lesson')).toBeUndefined();
    });

    it('план детерминирован: одинаковые входы → одинаковый результат', () => {
      const p = profile({ dueReviewLessonIds: ['a'] });
      expect(gen.buildPlan(p, 45)).toEqual(gen.buildPlan(p, 45));
    });
  });

  describe('ротация практики (§2.2, блок 4)', () => {
    it('никогда не использованный тип выбирается первым по порядку ротации', () => {
      expect(gen.pickPractice(profile())).toBe('mistakes');
    });

    it('выбирается тип, не использованный дольше всех', () => {
      const p = profile({
        practiceLastUsedAt: {
          mistakes: new Date('2026-07-10'),
          precision: new Date('2026-07-08'),
          drill: new Date('2026-07-09'),
          rated_game: new Date('2026-07-06'),
          puzzle_rush: new Date('2026-07-07'),
        },
      });
      expect(gen.pickPractice(p)).toBe('rated_game');
    });

    it('rated_game — блок из двух задач: партия + разбор', () => {
      const p = profile({
        nextLesson: null,
        practiceLastUsedAt: {
          mistakes: new Date('2026-07-10'),
          precision: new Date('2026-07-10'),
          drill: new Date('2026-07-10'),
          puzzle_rush: new Date('2026-07-10'),
        },
      });
      const plan = gen.buildPlan(p, 60);
      expect(plan.map((t) => t.type)).toContain('rated_game');
      expect(plan.map((t) => t.type)).toContain('game_review');
    });
  });

  describe('адаптация сложности (§2.3)', () => {
    it('решаемость < 40 % → окно вниз на 100', () => {
      expect(gen.ratingWindow(profile({ recentThemeSolveRate: 35 }))).toEqual({
        min: -200,
        max: -50,
      });
    });

    it('решаемость > 80 % → окно вверх на 50', () => {
      expect(gen.ratingWindow(profile({ recentThemeSolveRate: 85 }))).toEqual({
        min: -50,
        max: 100,
      });
    });

    it('решаемость 40–80 % или нет данных → базовое окно −100…+50', () => {
      expect(gen.ratingWindow(profile({ recentThemeSolveRate: 60 }))).toEqual({
        min: -100,
        max: 50,
      });
      expect(gen.ratingWindow(profile({ recentThemeSolveRate: null }))).toEqual({
        min: -100,
        max: 50,
      });
    });
  });

  describe('адаптация объёма (§2.3)', () => {
    it('< 50 % в двух занятиях подряд → максимум 2 блока (SM-2 + тактика)', () => {
      const p = profile({
        dueReviewLessonIds: ['a'],
        recentCompletionRates: [0.3, 0.4, 1],
      });
      expect(gen.maxBlocks(p)).toBe(2);
      const plan = gen.buildPlan(p, 60);
      expect(plan.map((t) => t.type)).toEqual(['sm2_review', 'puzzle_theme']);
    });

    it('3 полных занятия подряд → разрешён 4-й блок', () => {
      const p = profile({
        dueReviewLessonIds: ['a'],
        recentCompletionRates: [1, 1, 1],
      });
      expect(gen.maxBlocks(p)).toBe(4);
      const plan = gen.buildPlan(p, 60);
      // SM-2 + тактика + урок + практика
      expect(plan.map((t) => t.type)).toEqual([
        'sm2_review',
        'puzzle_theme',
        'lesson',
        'mistakes',
      ]);
    });

    it('обычный режим → 3 блока', () => {
      expect(gen.maxBlocks(profile({ recentCompletionRates: [0.7, 1] }))).toBe(3);
      expect(gen.maxBlocks(profile())).toBe(3);
    });
  });

  describe('перенос из expired-занятия (§2.3)', () => {
    it('перенесённые SM-2 приоритетнее новых due', () => {
      const plan = gen.buildPlan(
        profile({
          dueReviewLessonIds: ['new1', 'new2'],
          carryOver: { sm2LessonIds: ['old1'], theme: null },
        }),
        30,
      );
      expect(plan[0].params.lessonIds).toEqual(['old1', 'new1']);
    });

    it('перенесённая тема приоритетнее худшей слабой', () => {
      const plan = gen.buildPlan(
        profile({ carryOver: { sm2LessonIds: [], theme: 'endgame' } }),
        30,
      );
      const tactics = plan.find((t) => t.type === 'puzzle_theme')!;
      expect(tactics.params.theme).toBe('endgame');
    });
  });
});
