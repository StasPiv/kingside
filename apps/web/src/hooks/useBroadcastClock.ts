import { useEffect, useState } from 'react';

/**
 * KS-2700. Хук для отображения часов broadcast-партии. Backend KS-2699
 * отдаёт `whiteClockMs` / `blackClockMs` (оставшееся время в мс на момент
 * `clockUpdatedAt`) — фронт отсчитывает локально через `Date.now() -
 * clockUpdatedAt` для активной стороны.
 *
 * Логика:
 *  - Активная сторона (чей ход по `isBlackTurn`): тикает каждую секунду,
 *    значение = `clockMs - (now - clockUpdatedAt)`.
 *  - Неактивная: статичное `clockMs` без отсчёта.
 *  - Если `clockUpdatedAt === null` или один из `whiteClockMs/blackClockMs
 *    === null` — возвращаем `null` для обоих, рендерить таймеры не нужно
 *    (партия до старта / источник без `%clk`).
 *
 * Тикер чистится при unmount/смене входных значений. Cеточные расхождения
 * (системное время клиента vs сервера) игнорируем — это best-effort, как
 * в Lichess. Расхождение в пределах сетевой задержки приемлемо
 * (см. acceptance KS-2700, «Не делать»).
 */

export interface BroadcastClockInput {
  whiteClockMs: number | null | undefined;
  blackClockMs: number | null | undefined;
  clockUpdatedAt: string | null | undefined;
  /** Чья сторона на ходу. Определяется родителем через `Chess(fen).turn()`. */
  isBlackTurn: boolean;
  /**
   * Если партия завершена, тикать не нужно (фриз на последнем известном
   * значении). Передаём явно — Chess.fen() сам по себе не знает результат.
   */
  isFinished?: boolean;
}

export interface BroadcastClockState {
  /** Оставшиеся миллисекунды у белых; null если данных нет. */
  whiteRemainingMs: number | null;
  /** Оставшиеся миллисекунды у чёрных; null если данных нет. */
  blackRemainingMs: number | null;
  /** true если у партии вообще есть clocks для рендера. */
  hasClocks: boolean;
}

/**
 * Расчёт remaining-msов на конкретную точку во времени (`now`). Чистая
 * функция, экспортируется для unit-тестов.
 */
export function computeBroadcastClock(
  input: BroadcastClockInput,
  now: number,
): BroadcastClockState {
  const { whiteClockMs, blackClockMs, clockUpdatedAt, isBlackTurn, isFinished } =
    input;
  if (
    whiteClockMs == null ||
    blackClockMs == null ||
    !clockUpdatedAt
  ) {
    return {
      whiteRemainingMs: null,
      blackRemainingMs: null,
      hasClocks: false,
    };
  }
  const updatedAtMs = new Date(clockUpdatedAt).getTime();
  if (Number.isNaN(updatedAtMs)) {
    return {
      whiteRemainingMs: null,
      blackRemainingMs: null,
      hasClocks: false,
    };
  }
  const elapsed = isFinished ? 0 : Math.max(0, now - updatedAtMs);
  // Тикает только активная сторона; у неактивной время «приросло» обратно
  // к моменту последнего хода — рендерим как `clockMs` без вычета.
  const whiteRemainingMs = isBlackTurn
    ? whiteClockMs
    : Math.max(0, whiteClockMs - elapsed);
  const blackRemainingMs = isBlackTurn
    ? Math.max(0, blackClockMs - elapsed)
    : blackClockMs;
  return {
    whiteRemainingMs,
    blackRemainingMs,
    hasClocks: true,
  };
}

/**
 * Хук-обёртка над `computeBroadcastClock` с локальным интервалом 1 секунда
 * для активной стороны. Сбрасывает таймер при изменении входных данных
 * (ход → новый `clockUpdatedAt` → новый расчёт с нуля).
 */
export function useBroadcastClock(
  input: BroadcastClockInput,
): BroadcastClockState {
  const [state, setState] = useState<BroadcastClockState>(() =>
    computeBroadcastClock(input, Date.now()),
  );

  useEffect(() => {
    // Пересчитываем сразу при изменении входов, чтобы UI не ждал тика.
    setState(computeBroadcastClock(input, Date.now()));
    // Если данных нет или партия завершена — не запускаем интервал.
    if (
      input.whiteClockMs == null ||
      input.blackClockMs == null ||
      !input.clockUpdatedAt ||
      input.isFinished
    ) {
      return;
    }
    const id = setInterval(() => {
      setState(computeBroadcastClock(input, Date.now()));
    }, 1000);
    return () => clearInterval(id);
    // Перечисляем примитивные поля `input` явно — новый объект `input`
    // на каждом ререндере не должен пересоздавать interval. Если родитель
    // не мемоизирует `input`, такая зависимость даст «жидкий» таймер.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    input.whiteClockMs,
    input.blackClockMs,
    input.clockUpdatedAt,
    input.isBlackTurn,
    input.isFinished,
  ]);

  return state;
}

/**
 * Форматирование `mm:ss` или `H:MM:SS` (если ≥ 1 часа), с округлением
 * вниз до секунды. Negative/null входы → `null` (не рендерим).
 *
 * Pure-функция, без локали — формат единый для RU/EN
 * (двоеточия и цифры в обеих локалях одинаковые; «1:23:45» читается
 * однозначно).
 */
export function formatBroadcastClock(remainingMs: number | null): string | null {
  if (remainingMs == null) return null;
  const total = Math.max(0, Math.floor(remainingMs / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }
  return `${m}:${s.toString().padStart(2, '0')}`;
}
