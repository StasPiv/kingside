/**
 * KS-4652 / ADR-144 §3.4 — точное отображение шахматных часов.
 *
 * Поверх серверного снимка `whiteMs/blackMs/snapshotAt` хук
 * экстраполирует «текущий остаток» через `performance.now()`, считает
 * `urgency` обеих сторон по порогам ADR-144 §3.2 и выбирает
 * `mode` (формат вывода) — `normal` / `tenths` / `hundredths`.
 *
 * Стратегия частоты тика (по ADR §3.4):
 *  - Оба `urgency='normal'` → `setInterval(250)` — четверть секунды
 *    достаточно, чтобы цифра не «отставала», но без 60 fps-нагрузки.
 *  - Хоть один `urgency='low' | 'critical'` → `requestAnimationFrame`
 *    (~60 fps) — десятые/сотые бегут плавно.
 *
 * В скрытой вкладке `requestAnimationFrame` сам по себе приостанавливается
 * браузером; экстраполяция при возврате восстанавливается из
 * серверного snapshot'а — ловить `visibilitychange` отдельно не нужно.
 *
 * Чистая функция `computeClockDisplay(input, now)` экспортируется
 * отдельно — на ней удобно строить unit-тесты без таймеров.
 */
import { useEffect, useRef, useState } from 'react';
import {
  computeClockUrgency,
  type ClockMode,
  type ClockUrgency,
} from '../utils/formatGameClock';

export interface GameClockInput {
  /** Последний серверный остаток белых, мс. `null` — снимка ещё нет. */
  whiteMs: number | null;
  /** Последний серверный остаток чёрных, мс. */
  blackMs: number | null;
  /** Кто на ходу. `null` — партия не активна (waiting / finished). */
  activeColor: 'white' | 'black' | null;
  /** `performance.now()` в момент приёма последнего серверного снимка. */
  snapshotAt: number;
  /**
   * Начальное время контроля, мс. Нужен для расчёта порогов urgency
   * (§3.2). `null` — fallback emergency1=30_000, emergency2=8_000.
   */
  initialMs: number | null;
  /**
   * Партия завершена. При `true` экстраполяция остановлена — рендерим
   * статичные `whiteMs/blackMs`.
   */
  isFinished: boolean;
}

export interface GameClockOutput {
  whiteDisplayMs: number;
  blackDisplayMs: number;
  whiteUrgency: ClockUrgency;
  blackUrgency: ClockUrgency;
  whiteMode: ClockMode;
  blackMode: ClockMode;
}

/**
 * Для неактивной стороны режим всегда `normal` — даже если её
 * `urgency` уже `low`. Иначе десятые/сотые бегут у обоих игроков и
 * отвлекают (см. ADR §3.3, lichess делает так же).
 */
function urgencyToMode(
  urgency: ClockUrgency,
  isActiveAndRunning: boolean,
): ClockMode {
  if (!isActiveAndRunning) return 'normal';
  if (urgency === 'critical') return 'hundredths';
  if (urgency === 'low') return 'tenths';
  return 'normal';
}

/**
 * KS-4652 / ADR-144 §3.4. Чистый расчёт состояния часов для одного
 * момента времени `now` (`performance.now()`). Экстраполяция элапса
 * применяется только к активной стороне; неактивная остаётся на
 * серверном значении.
 *
 * Покрывается unit-тестами без таймеров.
 */
export function computeClockDisplay(
  input: GameClockInput,
  now: number,
): GameClockOutput {
  const wRaw = input.whiteMs ?? 0;
  const bRaw = input.blackMs ?? 0;
  // Партия активна и есть валидный снимок — считаем элапс с момента
  // снимка. Защита от обратного хода `now < snapshotAt`
  // (теоретический edge при манипуляциях с `performance.now()`):
  // `Math.max(0, ...)`.
  const running = !input.isFinished && input.activeColor != null;
  const elapsed = running ? Math.max(0, now - input.snapshotAt) : 0;

  let whiteDisplayMs = wRaw;
  let blackDisplayMs = bRaw;
  if (running && input.activeColor === 'white') {
    whiteDisplayMs = Math.max(0, wRaw - elapsed);
  } else if (running && input.activeColor === 'black') {
    blackDisplayMs = Math.max(0, bRaw - elapsed);
  }

  const whiteUrgency = computeClockUrgency(whiteDisplayMs, input.initialMs);
  const blackUrgency = computeClockUrgency(blackDisplayMs, input.initialMs);

  return {
    whiteDisplayMs,
    blackDisplayMs,
    whiteUrgency,
    blackUrgency,
    whiteMode: urgencyToMode(whiteUrgency, running && input.activeColor === 'white'),
    blackMode: urgencyToMode(blackUrgency, running && input.activeColor === 'black'),
  };
}

/** Точная стратегия тика — отдельно, чтобы можно было её отслеживать в эффекте. */
function tickStrategy(output: GameClockOutput): 'interval' | 'raf' {
  if (output.whiteUrgency !== 'normal') return 'raf';
  if (output.blackUrgency !== 'normal') return 'raf';
  return 'interval';
}

/**
 * KS-4652 / ADR-144 §3.4. Реактивный wrapper над `computeClockDisplay`.
 *
 * Перевычисляет output при изменениях входа (новый серверный снимок,
 * смена активной стороны, конец партии) и держит фоновой тик для
 * экстраполяции:
 *  - `setInterval(250)` для нормального режима;
 *  - `requestAnimationFrame` для low/critical (плавный бег десятых/сотых).
 *
 * При размонтировании — корректная очистка таймера/rAF, без утечки.
 *
 * `useGameClockDisplay` принимает «голый» input без мемоизации — мы
 * сравниваем его поля по примитивам в зависимостях эффекта, поэтому
 * родителю не нужно оборачивать объект в `useMemo`. NB: `initialMs`
 * считается стабильным после первого ответа REST.
 */
export function useGameClockDisplay(
  input: GameClockInput,
): GameClockOutput {
  const inputRef = useRef(input);
  inputRef.current = input;

  const nowFn = (): number => performance.now();

  const [output, setOutput] = useState<GameClockOutput>(() =>
    computeClockDisplay(input, nowFn()),
  );

  // Перерасчёт при изменении любого примитива во входе. Сюда же
  // попадает смена `snapshotAt` (новый серверный снимок) — мгновенно
  // подменяем экстраполированное значение на свежее серверное.
  useEffect(() => {
    setOutput(computeClockDisplay(inputRef.current, nowFn()));
  }, [
    input.whiteMs,
    input.blackMs,
    input.snapshotAt,
    input.activeColor,
    input.initialMs,
    input.isFinished,
  ]);

  const strategy = tickStrategy(output);

  useEffect(() => {
    // Партия не активна (waiting / finished) или нет активной стороны —
    // фон тика не нужен.
    if (input.isFinished || input.activeColor == null) return;

    let rafId: number | null = null;
    let intervalId: ReturnType<typeof setInterval> | null = null;

    const tick = (): void => {
      setOutput(computeClockDisplay(inputRef.current, nowFn()));
    };

    if (strategy === 'raf') {
      const loop = (): void => {
        tick();
        rafId = requestAnimationFrame(loop);
      };
      rafId = requestAnimationFrame(loop);
    } else {
      intervalId = setInterval(tick, 250);
    }

    return () => {
      if (rafId != null) cancelAnimationFrame(rafId);
      if (intervalId != null) clearInterval(intervalId);
    };
  }, [strategy, input.isFinished, input.activeColor]);

  return output;
}
