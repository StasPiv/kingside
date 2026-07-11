import { nextSlotWithin, zonedTimeToUtc } from './study-slot.util';

describe('study-slot.util (KS-4881)', () => {
  describe('zonedTimeToUtc', () => {
    it('Прага летом = UTC+2', () => {
      expect(
        zonedTimeToUtc(2026, 7, 11, 19, 30, 'Europe/Prague').toISOString(),
      ).toBe('2026-07-11T17:30:00.000Z');
    });

    it('Прага зимой = UTC+1', () => {
      expect(
        zonedTimeToUtc(2026, 1, 15, 19, 30, 'Europe/Prague').toISOString(),
      ).toBe('2026-01-15T18:30:00.000Z');
    });

    it('UTC-зона — без смещения', () => {
      expect(zonedTimeToUtc(2026, 7, 11, 12, 0, 'UTC').toISOString()).toBe(
        '2026-07-11T12:00:00.000Z',
      );
    });

    it('отрицательное смещение (Нью-Йорк, EDT = UTC−4)', () => {
      expect(
        zonedTimeToUtc(2026, 7, 11, 8, 0, 'America/New_York').toISOString(),
      ).toBe('2026-07-11T12:00:00.000Z');
    });
  });

  describe('nextSlotWithin', () => {
    // 2026-07-11 — суббота (dow=6).
    const sched = (days: number[], time = '19:30') => ({
      daysOfWeek: days,
      timeLocal: time,
      timezone: 'Europe/Prague',
    });

    it('слот сегодня, если время ещё впереди', () => {
      const now = new Date('2026-07-11T10:00:00Z'); // сб 12:00 Prague
      expect(nextSlotWithin(sched([6]), now, 25)?.toISOString()).toBe(
        '2026-07-11T17:30:00.000Z',
      );
    });

    it('время сегодня прошло → слот завтра (если день подходит)', () => {
      const now = new Date('2026-07-11T18:00:00Z'); // сб 20:00 Prague
      expect(nextSlotWithin(sched([6, 0]), now, 25)?.toISOString()).toBe(
        '2026-07-12T17:30:00.000Z', // воскресенье
      );
    });

    it('следующий подходящий день вне горизонта +25 ч → null', () => {
      const now = new Date('2026-07-11T18:00:00Z'); // сб вечер
      // Только суббота: следующий слот через неделю.
      expect(nextSlotWithin(sched([6]), now, 25)).toBeNull();
    });

    it('день недели определяется по локальной дате зоны', () => {
      // 23:30 сб в Праге = 21:30 UTC сб; для зоны Pacific это ещё день раньше.
      const now = new Date('2026-07-11T05:00:00Z');
      const slot = nextSlotWithin(
        { daysOfWeek: [5], timeLocal: '23:00', timezone: 'America/Los_Angeles' },
        now,
        25,
      );
      // В LA сейчас пт 22:00 (10.07, UTC−7) → слот пт 23:00 = сб 06:00 UTC.
      expect(slot?.toISOString()).toBe('2026-07-11T06:00:00.000Z');
    });

    it('ежедневное расписание всегда находит слот в пределах 25 ч', () => {
      const now = new Date('2026-07-11T18:00:00Z');
      const slot = nextSlotWithin(sched([0, 1, 2, 3, 4, 5, 6]), now, 25);
      expect(slot).not.toBeNull();
      expect(slot!.getTime()).toBeGreaterThan(now.getTime());
      expect(slot!.getTime() - now.getTime()).toBeLessThanOrEqual(25 * 3600_000);
    });
  });
});
