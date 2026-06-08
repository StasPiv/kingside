/**
 * KS-3927. Unit-тесты helper'а, который дросселирует ре-рендер
 * `<AnalysisPage>` в `LectureReplayPage`: между событиями записи
 * ссылка `replay` остаётся стабильной, AnalysisPage не дёргается на
 * каждый кадр плеера (60 Hz) и аудио не прерывается щелчками.
 */
import { describe, it, expect } from 'vitest';

import { findApplicableEventIndex } from './LectureReplayPage';

const events = [
  { t: 0 },
  { t: 1500 },
  { t: 4200 },
  { t: 7000 },
];

describe('findApplicableEventIndex KS-3927', () => {
  it('пустой массив → -1', () => {
    expect(findApplicableEventIndex([], 0)).toBe(-1);
    expect(findApplicableEventIndex([], 1000)).toBe(-1);
  });

  it('currentTimeMs до первого события → -1', () => {
    expect(findApplicableEventIndex([{ t: 100 }, { t: 200 }], 0)).toBe(-1);
    expect(findApplicableEventIndex([{ t: 100 }, { t: 200 }], 99)).toBe(-1);
  });

  it('currentTimeMs совпадает с t события → возвращает индекс события', () => {
    expect(findApplicableEventIndex(events, 0)).toBe(0);
    expect(findApplicableEventIndex(events, 1500)).toBe(1);
    expect(findApplicableEventIndex(events, 4200)).toBe(2);
    expect(findApplicableEventIndex(events, 7000)).toBe(3);
  });

  it('currentTimeMs между событиями → индекс предыдущего', () => {
    expect(findApplicableEventIndex(events, 800)).toBe(0);
    expect(findApplicableEventIndex(events, 1499)).toBe(0);
    expect(findApplicableEventIndex(events, 1501)).toBe(1);
    expect(findApplicableEventIndex(events, 5000)).toBe(2);
    expect(findApplicableEventIndex(events, 9999)).toBe(3);
  });

  it('стабильность индекса между ходами — два разных currentTimeMs внутри одного интервала дают один индекс', () => {
    // Ключевое поведение для KS-3927: пока плеер тикает между
    // событиями (e.g. 1500 → 4200), индекс остаётся равным 1, и
    // вызывающая сторона (LectureReplayPage useMemo) не создаёт
    // новый объект `replay` — AnalysisPage не дёргается, аудио
    // продолжает декодироваться без прерываний.
    const idxAt1600 = findApplicableEventIndex(events, 1600);
    const idxAt2500 = findApplicableEventIndex(events, 2500);
    const idxAt4199 = findApplicableEventIndex(events, 4199);
    expect(idxAt1600).toBe(1);
    expect(idxAt2500).toBe(1);
    expect(idxAt4199).toBe(1);
  });

  it('бинарный поиск корректен для большого отсортированного массива', () => {
    const big = Array.from({ length: 10_000 }, (_, i) => ({ t: i * 17 }));
    // currentTimeMs == t конкретного индекса.
    expect(findApplicableEventIndex(big, 17 * 5000)).toBe(5000);
    // Между t индексов — индекс предыдущего.
    expect(findApplicableEventIndex(big, 17 * 5000 + 5)).toBe(5000);
    expect(findApplicableEventIndex(big, 17 * 5001 - 1)).toBe(5000);
  });
});
