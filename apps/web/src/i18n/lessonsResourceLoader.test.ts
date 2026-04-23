import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import {
  loadLessonsResources,
  wrapLessonsBundle,
  __resetLoadedLngsForTests,
} from './lessonsResourceLoader';

/**
 * KS-1806: бэк отдаёт `GET /lessons/i18n/<lng>` без namespace-обёртки
 * (корневой объект — содержимое поддерева `lessons`). Фронт должен
 * обернуть перед `addResourceBundle`, иначе `t('lessons.demo.title')`
 * не найдёт ключ.
 */

describe('wrapLessonsBundle', () => {
  it('оборачивает payload без корневого `lessons`', () => {
    expect(wrapLessonsBundle({ demo: { title: 'Demo' } })).toEqual({
      lessons: { demo: { title: 'Demo' } },
    });
  });

  it('не удваивает обёртку, если бэк уже прислал `{ lessons: { ... } }`', () => {
    expect(wrapLessonsBundle({ lessons: { demo: { title: 'Demo' } } })).toEqual({
      lessons: { demo: { title: 'Demo' } },
    });
  });

  it('оборачивает, если корневых ключей несколько (т.е. это не namespace-обёртка)', () => {
    expect(wrapLessonsBundle({ demo: {}, advanced: {} })).toEqual({
      lessons: { demo: {}, advanced: {} },
    });
  });

  it('null/массивы/примитивы → null', () => {
    expect(wrapLessonsBundle(null)).toBeNull();
    expect(wrapLessonsBundle(undefined)).toBeNull();
    expect(wrapLessonsBundle([])).toBeNull();
    expect(wrapLessonsBundle('string')).toBeNull();
    expect(wrapLessonsBundle(42)).toBeNull();
  });
});

describe('loadLessonsResources — интеграция с i18next', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(async () => {
    __resetLoadedLngsForTests();
    if (!i18n.isInitialized) {
      await i18n.use(initReactI18next).init({
        lng: 'ru',
        fallbackLng: 'en',
        resources: {},
        interpolation: { escapeValue: false },
      });
    }
    // Полный сброс ресурсов между тестами — удаляем весь накопленный
    // bundle и заливаем фиксированный baseline, иначе данные предыдущих
    // тестов (addResourceBundle с deep-merge) просочатся сюда.
    i18n.removeResourceBundle('ru', 'translation');
    i18n.removeResourceBundle('en', 'translation');
    i18n.addResourceBundle('ru', 'translation', { lessons: { title: 'Уроки' } }, true, true);
    i18n.addResourceBundle('en', 'translation', { lessons: { title: 'Lessons' } }, true, true);
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('мержит backend-payload под `lessons.*`, не затирая bundled-строки', async () => {
    const payload = {
      demo: {
        title: 'Демо-курс',
        description: 'Описание',
        'quiz-demo': {
          title: 'Quiz',
          q1: { prompt: 'Вопрос 1', options: ['A', 'B'] },
        },
      },
    };
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => payload,
    }) as unknown as typeof fetch;

    await loadLessonsResources('ru');

    // Проверяем что ключи резолвятся как `lessons.demo.*`, а не `demo.*`.
    expect(i18n.t('lessons.demo.title', { lng: 'ru' })).toBe('Демо-курс');
    expect(i18n.t('lessons.demo.quiz-demo.title', { lng: 'ru' })).toBe('Quiz');
    expect(
      i18n.t('lessons.demo.quiz-demo.q1.prompt', { lng: 'ru' }),
    ).toBe('Вопрос 1');
    // Bundled-строки (lessons.title) не должны быть затёрты.
    expect(i18n.t('lessons.title', { lng: 'ru' })).toBe('Уроки');
  });

  it('идемпотентно принимает уже-обёрнутый payload `{ lessons: { ... } }`', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ lessons: { demo: { title: 'Course' } } }),
    }) as unknown as typeof fetch;

    await loadLessonsResources('en');

    expect(i18n.t('lessons.demo.title', { lng: 'en' })).toBe('Course');
    // Bundled-строки не затёрты.
    expect(i18n.t('lessons.title', { lng: 'en' })).toBe('Lessons');
  });

  it('не делает повторный fetch для одного и того же языка', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ demo: { title: 'D' } }),
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await loadLessonsResources('ru');
    await loadLessonsResources('ru');

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('404 с бэка → нет мёржа, bundled-строки остаются', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({}),
    }) as unknown as typeof fetch;

    await loadLessonsResources('ru');

    // demo-ключа нет — i18next вернёт сам ключ.
    expect(i18n.t('lessons.demo.title', { lng: 'ru' })).toBe('lessons.demo.title');
    // Bundled остался.
    expect(i18n.t('lessons.title', { lng: 'ru' })).toBe('Уроки');
  });

  it('сетевая ошибка → молча, без исключения', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network')) as unknown as typeof fetch;
    await expect(loadLessonsResources('ru')).resolves.toBeUndefined();
  });
});
