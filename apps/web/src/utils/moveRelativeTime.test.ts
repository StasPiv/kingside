import { describe, it, expect } from 'vitest';
import { formatMoveAgo } from './moveRelativeTime';

/**
 * KS-2795. Чистая функция, лёгкие edge-case'ы. i18n-функцию мокаем
 * примитивно: возвращаем шаблон с подставленным count, чтобы видеть
 * выбранную ветку, не цепляясь к точному переводу.
 */

const tMock = (
  key: string,
  opts?: Record<string, unknown> & { defaultValue?: string },
): string => {
  const count = (opts?.count as number | undefined) ?? 0;
  return `${key}:${count}`;
};

describe('formatMoveAgo', () => {
  const now = new Date('2026-05-12T12:00:00.000Z').getTime();

  it('null/пустой/невалидный iso → null', () => {
    expect(formatMoveAgo(null, now, tMock)).toBeNull();
    expect(formatMoveAgo('', now, tMock)).toBeNull();
    expect(formatMoveAgo('not-a-date', now, tMock)).toBeNull();
  });

  it('<10 секунд → justNow', () => {
    const iso = new Date(now - 3 * 1000).toISOString();
    expect(formatMoveAgo(iso, now, tMock)).toBe('broadcastRound.lastMove.justNow:0');
  });

  it('секунды (10–59) → secondsAgo с count', () => {
    const iso = new Date(now - 42 * 1000).toISOString();
    expect(formatMoveAgo(iso, now, tMock)).toBe(
      'broadcastRound.lastMove.secondsAgo:42',
    );
  });

  it('минуты (1–59) → minutesAgo с count', () => {
    const iso = new Date(now - 5 * 60 * 1000).toISOString();
    expect(formatMoveAgo(iso, now, tMock)).toBe(
      'broadcastRound.lastMove.minutesAgo:5',
    );
  });

  it('часы (1–23) → hoursAgo с count', () => {
    const iso = new Date(now - 3 * 60 * 60 * 1000).toISOString();
    expect(formatMoveAgo(iso, now, tMock)).toBe(
      'broadcastRound.lastMove.hoursAgo:3',
    );
  });

  it('дни (≥1) → daysAgo с count', () => {
    const iso = new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString();
    expect(formatMoveAgo(iso, now, tMock)).toBe(
      'broadcastRound.lastMove.daysAgo:2',
    );
  });

  it('будущее (>2 сек вперёд) → null', () => {
    const iso = new Date(now + 10 * 1000).toISOString();
    expect(formatMoveAgo(iso, now, tMock)).toBeNull();
  });

  it('лёгкий рассинхрон (-1 сек) → justNow, не null', () => {
    const iso = new Date(now + 1 * 1000).toISOString();
    expect(formatMoveAgo(iso, now, tMock)).toBe(
      'broadcastRound.lastMove.justNow:0',
    );
  });
});
