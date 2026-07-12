import {
  buildTelegramText,
  taskLine,
  taskPath,
  StudyTranslator,
} from './study-notification-message';

/** Мини-переводчик: ключ + подстановка как у nestjs-i18n. */
const en: Record<string, string> = {
  'study.notification.title': 'Training session',
  'study.notification.intro': 'Your training session is ready:',
  'study.notification.openSession': 'Open the session: {{url}}',
  'study.notification.taskLine.sm2_review': 'Review lessons: {{count}}',
  'study.notification.taskLine.puzzle_theme': 'Solve {{count}} puzzles — theme: {{theme}}',
  'study.notification.taskLine.puzzle_theme_mix': 'Solve {{count}} puzzles',
  'study.notification.taskLine.lesson': 'Complete the lesson: {{lessonTitle}}',
  'study.notification.taskLine.rated_game': 'Play a rated game',
};
// Подстановка {{name}} — как в StudyPlanConfigService.fill.
const t: StudyTranslator = (key, args) => {
  let s = en[key] ?? key;
  for (const [k, v] of Object.entries(args ?? {})) s = s.replaceAll(`{{${k}}}`, String(v));
  return s;
};

describe('study-notification-message (KS-4882)', () => {
  describe('taskPath', () => {
    it('puzzle_theme с темой → /puzzles?themes=', () => {
      expect(taskPath({ type: 'puzzle_theme', params: { theme: 'fork' }, targetCount: 10 }))
        .toBe('/puzzles?themes=fork');
    });

    it('puzzle_theme без темы → /puzzles', () => {
      expect(taskPath({ type: 'puzzle_theme', params: { theme: null }, targetCount: 10 }))
        .toBe('/puzzles');
    });

    it('lesson со slug → /lessons/:slug/:lessonId', () => {
      expect(
        taskPath({
          type: 'lesson',
          params: { courseSlug: 'basics', lessonId: 'l1' },
          targetCount: 1,
        }),
      ).toBe('/lessons/basics/l1');
    });

    it('lesson без slug → /lessons (fallback)', () => {
      expect(taskPath({ type: 'lesson', params: { lessonId: 'l1' }, targetCount: 1 }))
        .toBe('/lessons');
    });

    it('известные разделы практики', () => {
      expect(taskPath({ type: 'mistakes', params: {}, targetCount: 8 })).toBe('/puzzles/mistakes-practice');
      expect(taskPath({ type: 'precision', params: {}, targetCount: 3 })).toBe('/precision');
      expect(taskPath({ type: 'drill', params: {}, targetCount: 10 })).toBe('/drills');
      expect(taskPath({ type: 'rated_game', params: {}, targetCount: 1 })).toBe('/play');
      expect(taskPath({ type: 'puzzle_rush', params: {}, targetCount: 1 })).toBe('/puzzle-rush');
    });

    it('неизвестный тип → /study', () => {
      expect(taskPath({ type: 'unknown_x', params: {}, targetCount: 1 })).toBe('/study');
    });

    it('тема экранируется в query', () => {
      expect(taskPath({ type: 'puzzle_theme', params: { theme: 'a b' }, targetCount: 8 }))
        .toBe('/puzzles?themes=a%20b');
    });
  });

  describe('taskLine', () => {
    it('puzzle_theme с темой и количеством', () => {
      expect(taskLine({ type: 'puzzle_theme', params: { theme: 'fork' }, targetCount: 10 }, t))
        .toBe('Solve 10 puzzles — theme: fork');
    });

    it('puzzle_theme без темы → mix-вариант', () => {
      expect(taskLine({ type: 'puzzle_theme', params: {}, targetCount: 8 }, t))
        .toBe('Solve 8 puzzles');
    });

    it('sm2_review с количеством', () => {
      expect(taskLine({ type: 'sm2_review', params: { lessonIds: ['a', 'b'] }, targetCount: 2 }, t))
        .toBe('Review lessons: 2');
    });
  });

  describe('buildTelegramText', () => {
    it('заголовок + нумерованные задания со ссылками + ссылка на /study', () => {
      const text = buildTelegramText(
        [
          { type: 'sm2_review', params: {}, targetCount: 2 },
          { type: 'puzzle_theme', params: { theme: 'fork' }, targetCount: 10 },
        ],
        'https://kingside.site',
        t,
      );
      expect(text).toContain('Training session');
      expect(text).toContain('1. Review lessons: 2 — https://kingside.site/lessons');
      expect(text).toContain(
        '2. Solve 10 puzzles — theme: fork — https://kingside.site/puzzles?themes=fork',
      );
      expect(text).toContain('Open the session: https://kingside.site/study');
    });
  });
});
