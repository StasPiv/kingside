/**
 * KS-4652 / ADR-144 §3.4 — тесты `computeClockDisplay` и хука
 * `useGameClockDisplay`. Чистая функция покрывает основную логику
 * (экстраполяция активной стороны, urgency/mode, isFinished),
 * хук — что таймер действительно тикает между серверными снимками.
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  computeClockDisplay,
  useGameClockDisplay,
  type GameClockInput,
} from './useGameClockDisplay';

function makeInput(overrides: Partial<GameClockInput> = {}): GameClockInput {
  return {
    whiteMs: 60_000,
    blackMs: 60_000,
    activeColor: 'white',
    snapshotAt: 1_000,
    initialMs: 60_000,
    isFinished: false,
    ...overrides,
  };
}

describe('computeClockDisplay — чистая функция', () => {
  it('активная сторона уменьшается на elapsed, неактивная — нет', () => {
    const out = computeClockDisplay(
      makeInput({ activeColor: 'white' }),
      1_500, // 500 мс после snapshot
    );
    expect(out.whiteDisplayMs).toBe(59_500);
    expect(out.blackDisplayMs).toBe(60_000);
  });

  it('активная чёрная — уменьшается чёрная', () => {
    const out = computeClockDisplay(
      makeInput({ activeColor: 'black' }),
      1_750,
    );
    expect(out.whiteDisplayMs).toBe(60_000);
    expect(out.blackDisplayMs).toBe(59_250);
  });

  it('isFinished=true → ничего не уменьшается', () => {
    const out = computeClockDisplay(
      makeInput({
        activeColor: 'white',
        whiteMs: 12_000,
        blackMs: 34_000,
        isFinished: true,
      }),
      10_000,
    );
    expect(out.whiteDisplayMs).toBe(12_000);
    expect(out.blackDisplayMs).toBe(34_000);
  });

  it('activeColor=null → не уменьшается ни одна', () => {
    const out = computeClockDisplay(
      makeInput({ activeColor: null, whiteMs: 12_000, blackMs: 34_000 }),
      10_000,
    );
    expect(out.whiteDisplayMs).toBe(12_000);
    expect(out.blackDisplayMs).toBe(34_000);
  });

  it('whiteMs/blackMs=null → нолики, без падения', () => {
    const out = computeClockDisplay(
      makeInput({ whiteMs: null, blackMs: null, activeColor: 'white' }),
      2_000,
    );
    expect(out.whiteDisplayMs).toBe(0);
    expect(out.blackDisplayMs).toBe(0);
  });

  it('экстраполяция не уходит ниже нуля', () => {
    const out = computeClockDisplay(
      makeInput({ whiteMs: 100, activeColor: 'white' }),
      1_500, // прошло 500 мс, осталось бы -400
    );
    expect(out.whiteDisplayMs).toBe(0);
  });

  it('защита от обратного хода now < snapshotAt → элапс 0', () => {
    const out = computeClockDisplay(
      makeInput({ whiteMs: 60_000, activeColor: 'white', snapshotAt: 2_000 }),
      1_000, // backward
    );
    expect(out.whiteDisplayMs).toBe(60_000);
  });

  it('mode неактивной стороны — всегда normal, даже при low', () => {
    const out = computeClockDisplay(
      makeInput({
        whiteMs: 7_000, // <8_000 → low
        blackMs: 7_000, // тоже low по тому же initialMs
        activeColor: 'white',
        snapshotAt: 0,
      }),
      0,
    );
    expect(out.whiteUrgency).toBe('low');
    expect(out.blackUrgency).toBe('low');
    expect(out.whiteMode).toBe('tenths'); // активная сторона видит десятые
    expect(out.blackMode).toBe('normal'); // неактивная — без долей
  });

  it('mode активной white critical → hundredths', () => {
    const out = computeClockDisplay(
      makeInput({
        whiteMs: 1_500, // <2_000 → critical для bullet 1+0
        blackMs: 30_000,
        activeColor: 'white',
        initialMs: 60_000,
        snapshotAt: 0,
      }),
      0,
    );
    expect(out.whiteUrgency).toBe('critical');
    expect(out.whiteMode).toBe('hundredths');
    expect(out.blackUrgency).toBe('normal');
    expect(out.blackMode).toBe('normal');
  });

  it('isFinished → mode всегда normal, даже при critical urgency', () => {
    const out = computeClockDisplay(
      makeInput({
        whiteMs: 500,
        blackMs: 500,
        activeColor: 'white',
        isFinished: true,
      }),
      0,
    );
    // Урgency считается по числу — оно мало, но mode у обоих normal,
    // потому что часы остановлены.
    expect(out.whiteUrgency).toBe('critical');
    expect(out.whiteMode).toBe('normal');
    expect(out.blackMode).toBe('normal');
  });

  it('пороги вычисляются по initialMs (rapid 15+10)', () => {
    const out = computeClockDisplay(
      makeInput({
        whiteMs: 25_000,
        blackMs: 25_000,
        activeColor: 'white',
        initialMs: 900_000, // emergency1 = 30_000 (clamp max)
        snapshotAt: 0,
      }),
      0,
    );
    // 25_000 <= 30_000 → low.
    expect(out.whiteUrgency).toBe('low');
  });
});

describe('useGameClockDisplay — реактивный wrapper', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    let t = 1_000;
    vi.spyOn(performance, 'now').mockImplementation(() => t);
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(
      (cb: FrameRequestCallback): number => {
        // эмулируем «следующий кадр» как timeout(16).
        const id = setTimeout(() => {
          t += 16;
          cb(t);
        }, 16);
        return id as unknown as number;
      },
    );
    vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(
      (id: number) => clearTimeout(id),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('по setInterval(250) пересчитывает displayMs (нормальный режим)', () => {
    const { result } = renderHook(() =>
      useGameClockDisplay({
        whiteMs: 60_000,
        blackMs: 60_000,
        activeColor: 'white',
        snapshotAt: 1_000,
        initialMs: 60_000,
        isFinished: false,
      }),
    );

    expect(result.current.whiteDisplayMs).toBe(60_000);

    // Сдвигаем «часы» на 300 мс и срабатываем интервал.
    act(() => {
      vi.setSystemTime(new Date(1_300));
      (performance.now as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
        1_300,
      );
      vi.advanceTimersByTime(250);
    });
    expect(result.current.whiteDisplayMs).toBeLessThan(60_000);
    expect(result.current.whiteDisplayMs).toBeGreaterThanOrEqual(59_500);
  });

  it('переход white → low ставит mode=tenths и не падает', () => {
    const { result, rerender } = renderHook(
      (props: { whiteMs: number; snapshotAt: number }) =>
        useGameClockDisplay({
          whiteMs: props.whiteMs,
          blackMs: 60_000,
          activeColor: 'white',
          snapshotAt: props.snapshotAt,
          initialMs: 60_000,
          isFinished: false,
        }),
      { initialProps: { whiteMs: 60_000, snapshotAt: 1_000 } },
    );

    expect(result.current.whiteUrgency).toBe('normal');
    expect(result.current.whiteMode).toBe('normal');

    // Серверный снимок «у вас 5 секунд» (<8_000 → low) при свежем snapshot.
    rerender({ whiteMs: 5_000, snapshotAt: 1_000 });
    expect(result.current.whiteUrgency).toBe('low');
    expect(result.current.whiteMode).toBe('tenths');
  });

  it('isFinished=true → таймер не запускается, output статичен', () => {
    const { result } = renderHook(() =>
      useGameClockDisplay({
        whiteMs: 12_000,
        blackMs: 34_000,
        activeColor: 'white',
        snapshotAt: 1_000,
        initialMs: 60_000,
        isFinished: true,
      }),
    );

    expect(result.current.whiteDisplayMs).toBe(12_000);
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    // Без таймера значения не изменились.
    expect(result.current.whiteDisplayMs).toBe(12_000);
  });

  it('смена активной стороны переключает экстраполяцию', () => {
    const { result, rerender } = renderHook(
      (props: { activeColor: 'white' | 'black'; snapshotAt: number }) =>
        useGameClockDisplay({
          whiteMs: 60_000,
          blackMs: 60_000,
          activeColor: props.activeColor,
          snapshotAt: props.snapshotAt,
          initialMs: 60_000,
          isFinished: false,
        }),
      { initialProps: { activeColor: 'white', snapshotAt: 1_000 } },
    );

    act(() => {
      vi.setSystemTime(new Date(1_500));
      (performance.now as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
        1_500,
      );
      vi.advanceTimersByTime(250);
    });
    const whiteBefore = result.current.whiteDisplayMs;
    expect(whiteBefore).toBeLessThan(60_000);

    // Ход переходит к чёрным: сервер шлёт новый снимок со свежим
    // `snapshotAt = текущее время`, экстраполяция чёрных стартует с
    // нулевого элапса. Белые «застывают» — экстраполяция к ним
    // больше не применяется.
    rerender({ activeColor: 'black', snapshotAt: 1_500 });
    expect(result.current.blackDisplayMs).toBe(60_000);
    expect(result.current.whiteDisplayMs).toBe(60_000);
  });
});
