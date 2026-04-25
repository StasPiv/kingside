import { describe, it, expect, beforeAll } from 'vitest';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import en from './locales/en/translation.json';
import ru from './locales/ru/translation.json';

/**
 * KS-1884: i18n-фикс прогресса.
 *
 *  1. `lessons.progressFull` — плейсхолдер `{{completed}}` теперь
 *     совпадает с тем, что передают вызовы `t(...)` в
 *     `UserLessonPage.tsx` и `CoursePage.tsx`. До фикса
 *     `UserLessonPage` передавал `done`, а строка ждала `completed` →
 *     в шапке отображалось `{{completed}}/2 (50%)`.
 *  2. `lessons.my.progress` — переведено с «шагов» / «steps» на
 *     «уроков» / «lessons», т.к. в `UserCoursePage` подставляется
 *     количество уроков курса. Для RU добавлены формы `_one`/`_few`/
 *     `_many`/`_other`; для EN — `_one`/`_other`. i18next выбирает
 *     форму по `count`.
 *
 * Тесты гоняют реальные локали через i18next без React, чтобы
 * гарантировать что подстановка работает обеими сторонами.
 */

beforeAll(async () => {
  if (!i18n.isInitialized) {
    await i18n.use(initReactI18next).init({
      resources: {
        en: { translation: en },
        ru: { translation: ru },
      },
      lng: 'en',
      fallbackLng: 'en',
      interpolation: { escapeValue: false },
    });
  }
});

describe('lessons.progressFull (KS-1884 #1)', () => {
  it('EN: подставляет completed/total/percent — без сырых {{}}', async () => {
    await i18n.changeLanguage('en');
    const out = i18n.t('lessons.progressFull', { completed: 2, total: 4, percent: 50 });
    expect(out).toBe('2/4 (50%)');
    expect(out).not.toContain('{{');
  });

  it('RU: подставляет completed/total/percent — без сырых {{}}', async () => {
    await i18n.changeLanguage('ru');
    const out = i18n.t('lessons.progressFull', { completed: 2, total: 4, percent: 50 });
    expect(out).toBe('2/4 (50%)');
    expect(out).not.toContain('{{');
  });
});

describe('lessons.my.progress (KS-1884 #2): про уроки, не шаги', () => {
  it('EN _one: 0/1 — "Completed 0/1 lesson"', async () => {
    await i18n.changeLanguage('en');
    const out = i18n.t('lessons.my.progress', { count: 1, done: 0 });
    expect(out).toBe('Completed 0/1 lesson');
    expect(out).toContain('lesson');
    expect(out).not.toContain('step');
  });

  it('EN _other: 2/5 — "Completed 2/5 lessons"', async () => {
    await i18n.changeLanguage('en');
    const out = i18n.t('lessons.my.progress', { count: 5, done: 2 });
    expect(out).toBe('Completed 2/5 lessons');
    expect(out).not.toContain('step');
  });

  it('RU _one: 0/1 — "Пройдено 0/1 урока"', async () => {
    await i18n.changeLanguage('ru');
    const out = i18n.t('lessons.my.progress', { count: 1, done: 0 });
    expect(out).toBe('Пройдено 0/1 урока');
    expect(out).not.toContain('шаг');
  });

  it('RU _few: 0/2 — "Пройдено 0/2 уроков"', async () => {
    await i18n.changeLanguage('ru');
    const out = i18n.t('lessons.my.progress', { count: 2, done: 0 });
    expect(out).toBe('Пройдено 0/2 уроков');
    expect(out).not.toContain('шаг');
  });

  it('RU _many: 2/5 — "Пройдено 2/5 уроков"', async () => {
    await i18n.changeLanguage('ru');
    const out = i18n.t('lessons.my.progress', { count: 5, done: 2 });
    expect(out).toBe('Пройдено 2/5 уроков');
    expect(out).not.toContain('шаг');
  });

  it('RU _many: 0/10 — "Пройдено 0/10 уроков"', async () => {
    await i18n.changeLanguage('ru');
    const out = i18n.t('lessons.my.progress', { count: 10, done: 0 });
    expect(out).toBe('Пройдено 0/10 уроков');
  });
});
