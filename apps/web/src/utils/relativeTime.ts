/**
 * Форматирует «N дней назад» / «N часов назад» / «менее часа назад».
 * Для значений > 30 дней возвращает локализованную абсолютную дату.
 *
 * Используется в Hero Variant B (KS-1938) и на странице
 * `/lessons/my-active` (KS-1941). Логика — простая и консервативная:
 * Intl.RelativeTimeFormat / i18next-icu для 4 кейсов разворачивать
 * нерационально.
 *
 * Используемые i18n-ключи (должны существовать в словарях en/ru):
 *  - `lessons.hero.continue.relative.lessHour`
 *  - `lessons.hero.continue.relative.hours_*` (с plural)
 *  - `lessons.hero.continue.relative.days_*` (с plural)
 *
 * Хелпер живёт в `utils/`, чтобы и Hero, и MyActiveCoursesPage не
 * дублировали логику. Если в будущем понадобится поддержка «через N
 * дней» (для будущих review-due бейджей) — добавлять future-кейсы
 * сюда же.
 */

const MS_IN_HOUR = 60 * 60 * 1000;
const MS_IN_DAY = 24 * MS_IN_HOUR;

export function formatRelativeActivity(
  iso: string,
  now: number,
  t: (
    key: string,
    opts?: Record<string, unknown> & { defaultValue?: string },
  ) => string,
  locale: string,
): string {
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) {
    return iso;
  }
  const diff = Math.max(0, now - ts);
  if (diff < MS_IN_HOUR) {
    return t('lessons.hero.continue.relative.lessHour', {
      defaultValue: 'less than an hour ago',
    });
  }
  if (diff < MS_IN_DAY) {
    const hours = Math.floor(diff / MS_IN_HOUR);
    return t('lessons.hero.continue.relative.hours', {
      count: hours,
      defaultValue: '{{count}}h ago',
    });
  }
  const days = Math.floor(diff / MS_IN_DAY);
  if (days <= 30) {
    return t('lessons.hero.continue.relative.days', {
      count: days,
      defaultValue: '{{count}}d ago',
    });
  }
  try {
    return new Date(ts).toLocaleDateString(locale, {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  } catch {
    return new Date(ts).toISOString().slice(0, 10);
  }
}
