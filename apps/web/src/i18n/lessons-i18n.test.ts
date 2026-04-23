import { describe, it, expect } from 'vitest';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import en from './locales/en/translation.json';
import ru from './locales/ru/translation.json';

/**
 * KS-1782: ключи курса «beginner» (titleI18nKey/summaryI18nKey, которые
 * приходят с бэка через L-04 API и L-14 seed) должны разрешаться в обоих
 * локалях, иначе UI показывает slug. Этот тест — гард, чтобы при
 * переименовании уроков в seed мы быстро увидели рассинхрон.
 */

const KEYS_TO_CHECK: string[] = [
  // курс
  'lessons.beginner.title',
  'lessons.beginner.description',
  // несколько уроков из разных групп (полный список — 30, держим спот-проверку)
  'lessons.beginner.board-coordinates.title',
  'lessons.beginner.board-coordinates.summary',
  'lessons.beginner.knight-moves.title',
  'lessons.beginner.fork.title',
  'lessons.beginner.mate-rook-king.title',
  'lessons.beginner.king-pawn-vs-king.title',
];

function makeInstance(lng: 'en' | 'ru') {
  const inst = i18n.createInstance();
  inst.use(initReactI18next).init({
    resources: { en: { translation: en }, ru: { translation: ru } },
    lng,
    fallbackLng: 'en',
    interpolation: { escapeValue: false },
  });
  return inst;
}

describe('lessons.beginner i18n keys (KS-1782)', () => {
  it.each(['en', 'ru'] as const)('locale %s: все ключи курса резолвятся в строки', (lng) => {
    const inst = makeInstance(lng);
    for (const key of KEYS_TO_CHECK) {
      const value = inst.t(key);
      expect(value, `${lng}: ${key}`).not.toBe(key);
      expect(typeof value).toBe('string');
      expect((value as string).length).toBeGreaterThan(0);
    }
  });

  it('структура одинакова в en и ru — нет ключей в одной локали без второй', () => {
    const enKeys = collectLeafKeys((en as Record<string, unknown>).lessons as Record<string, unknown>, 'lessons.beginner');
    const ruKeys = collectLeafKeys((ru as Record<string, unknown>).lessons as Record<string, unknown>, 'lessons.beginner');
    const onlyInEn = enKeys.filter((k) => !ruKeys.includes(k));
    const onlyInRu = ruKeys.filter((k) => !enKeys.includes(k));
    expect(onlyInEn).toEqual([]);
    expect(onlyInRu).toEqual([]);
  });
});

function collectLeafKeys(obj: Record<string, unknown> | undefined, prefix: string): string[] {
  if (!obj) return [];
  // Идём по поддереву lessons.beginner.
  const root = (obj as Record<string, unknown>).beginner;
  if (!root || typeof root !== 'object') return [];
  const out: string[] = [];
  walk(root as Record<string, unknown>, `${prefix}`, out);
  return out;
}

function walk(node: Record<string, unknown>, path: string, out: string[]) {
  for (const k of Object.keys(node)) {
    const v = node[k];
    const next = `${path}.${k}`;
    if (v && typeof v === 'object') walk(v as Record<string, unknown>, next, out);
    else out.push(next);
  }
}
