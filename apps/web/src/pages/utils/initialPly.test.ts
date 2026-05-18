import { describe, it, expect } from 'vitest';

import { parseInitialPly } from './initialPly';

/**
 * KS-3092: helper, который вытаскивает «полу-ход для viewer'а» из
 * navigation-state и URL-параметра `?ply=`. Используется AnalysisPage
 * при открытии партии из by-position-результатов архива.
 */
describe('parseInitialPly (KS-3092)', () => {
  it('берёт initialPly из state, игнорируя URL', () => {
    expect(
      parseInitialPly({ initialPly: 7 }, new URLSearchParams('ply=99')),
    ).toBe(7);
  });

  it('берёт ply из URL, если state.initialPly отсутствует', () => {
    expect(parseInitialPly(null, new URLSearchParams('ply=11'))).toBe(11);
  });

  it('берёт ply из URL, если state.initialPly не number', () => {
    expect(
      parseInitialPly(
        { initialPly: 'seven' as unknown as number },
        new URLSearchParams('ply=4'),
      ),
    ).toBe(4);
  });

  it('возвращает undefined при отсутствии и state, и URL ply', () => {
    expect(parseInitialPly(null, new URLSearchParams())).toBeUndefined();
    expect(parseInitialPly(undefined, null)).toBeUndefined();
    expect(parseInitialPly({}, new URLSearchParams())).toBeUndefined();
  });

  it('игнорирует ply=0 — это стартовая позиция, viewer и так там', () => {
    // Если протолкнуть pendingPositionRef.current = -1, gotoMove
    // получит null из searchInHistory и поведение станет неопределённым.
    // Безопаснее вернуть undefined и не трогать viewer.
    expect(parseInitialPly({ initialPly: 0 }, new URLSearchParams('ply=0'))).toBeUndefined();
  });

  it('игнорирует отрицательные и нечисловые URL-значения', () => {
    expect(parseInitialPly(null, new URLSearchParams('ply=-3'))).toBeUndefined();
    expect(parseInitialPly(null, new URLSearchParams('ply=abc'))).toBeUndefined();
    expect(parseInitialPly(null, new URLSearchParams('ply=7.5'))).toBeUndefined();
    expect(parseInitialPly(null, new URLSearchParams('ply=1e3'))).toBeUndefined();
  });

  it('игнорирует NaN/Infinity в state', () => {
    expect(parseInitialPly({ initialPly: NaN }, null)).toBeUndefined();
    expect(parseInitialPly({ initialPly: Infinity }, null)).toBeUndefined();
    expect(parseInitialPly({ initialPly: -1 }, null)).toBeUndefined();
  });

  it('допускает большие валидные значения (длинная партия)', () => {
    expect(parseInitialPly(null, new URLSearchParams('ply=250'))).toBe(250);
  });
});
