import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { lessonsApi, normalizeLang } from './lessonsApi';
import { api } from '../api';

/**
 * KS-2099: фронт передаёт `lang` в API курсов и резолвит версию по
 * UI-языку. Здесь — юнит-тесты на нормализацию языка и формирование
 * URL запросов lessonsApi.
 */

describe('normalizeLang (KS-2099)', () => {
  it('en → en, en-US → en, en-GB → en', () => {
    expect(normalizeLang('en')).toBe('en');
    expect(normalizeLang('en-US')).toBe('en');
    expect(normalizeLang('EN-GB')).toBe('en');
  });

  it('ru, ru-RU, и любой неизвестный код → ru (дефолт)', () => {
    expect(normalizeLang('ru')).toBe('ru');
    expect(normalizeLang('ru-RU')).toBe('ru');
    expect(normalizeLang('uk')).toBe('ru');
    expect(normalizeLang('de')).toBe('ru');
  });

  it('null/undefined/пустая строка → ru', () => {
    expect(normalizeLang(null)).toBe('ru');
    expect(normalizeLang(undefined)).toBe('ru');
    expect(normalizeLang('')).toBe('ru');
  });
});

describe('lessonsApi: проброс lang в URL (KS-2099)', () => {
  let getSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // listActiveCourses ждёт `{ data?: ActiveCourseDto[] }`, остальные —
    // raw payload. Возвращаем минимальный ответ для unit-теста; здесь
    // важна только форма URL, а не содержимое.
    getSpy = vi
      .spyOn(api, 'get')
      .mockResolvedValue({ data: [], items: [] } as never);
  });

  afterEach(() => {
    getSpy.mockRestore();
  });

  it('listCourses(lang="en") → /lessons/courses?lang=en', async () => {
    await lessonsApi.listCourses('en');
    expect(getSpy).toHaveBeenCalledWith('/lessons/courses?lang=en');
  });

  it('listCourses(lang="ru-RU") → /lessons/courses?lang=ru', async () => {
    await lessonsApi.listCourses('ru-RU');
    expect(getSpy).toHaveBeenCalledWith('/lessons/courses?lang=ru');
  });

  it('listCourses() без lang → дефолт ru в querystring', async () => {
    await lessonsApi.listCourses();
    expect(getSpy).toHaveBeenCalledWith('/lessons/courses?lang=ru');
  });

  it('getCourse(slug, "en") → /lessons/courses/<slug>?lang=en', async () => {
    await lessonsApi.getCourse('capablanca-fundamentals', 'en');
    expect(getSpy).toHaveBeenCalledWith(
      '/lessons/courses/capablanca-fundamentals?lang=en',
    );
  });

  it('getCourse слаг с пробелами/спецсимволами → encodeURIComponent', async () => {
    await lessonsApi.getCourse('a b/c', 'ru');
    expect(getSpy).toHaveBeenCalledWith('/lessons/courses/a%20b%2Fc?lang=ru');
  });

  it('listActiveCourses(lang) → /lessons/active-courses?lang=…', async () => {
    await lessonsApi.listActiveCourses('en');
    expect(getSpy).toHaveBeenCalledWith('/lessons/active-courses?lang=en');
  });
});
