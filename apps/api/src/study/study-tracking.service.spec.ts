import { StudyTrackingService } from './study-tracking.service';
import { PrismaService } from '../prisma/prisma.service';

describe('StudyTrackingService.localDayEnded (KS-4884)', () => {
  const svc = new StudyTrackingService({} as PrismaService);
  // Слот: 2026-07-11 19:30 Prague (17:30 UTC, лето UTC+2).
  const slot = new Date('2026-07-11T17:30:00Z');

  it('день ещё идёт → false', () => {
    expect(svc.localDayEnded(slot, 'Europe/Prague', new Date('2026-07-11T20:00:00Z'))).toBe(false);
  });

  it('локальная полночь наступила → true (21:59 UTC ещё 23:59 в Праге, 22:00 — полночь)', () => {
    expect(svc.localDayEnded(slot, 'Europe/Prague', new Date('2026-07-11T21:59:00Z'))).toBe(false);
    expect(svc.localDayEnded(slot, 'Europe/Prague', new Date('2026-07-11T22:00:00Z'))).toBe(true);
  });

  it('западная зона: день заканчивается позже UTC-даты', () => {
    // Слот 2026-07-11 20:00 в LA (12.07 03:00 UTC): конец локального дня —
    // 12.07 07:00 UTC.
    const laSlot = new Date('2026-07-12T03:00:00Z');
    expect(svc.localDayEnded(laSlot, 'America/Los_Angeles', new Date('2026-07-12T06:59:00Z'))).toBe(false);
    expect(svc.localDayEnded(laSlot, 'America/Los_Angeles', new Date('2026-07-12T07:00:00Z'))).toBe(true);
  });
});
