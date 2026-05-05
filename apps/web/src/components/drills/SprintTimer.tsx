import { memo, useEffect, useState } from 'react';

/**
 * KS-2428 — sprint-таймер вынесен из `DrillSprintPlayPage`.
 *
 * До этой правки sprint-страница сама держала state `timeLeft`,
 * который обновлялся `setInterval(250)` → 4 ререндера в секунду
 * всего компонента. Это инвалидировало callback'и для DrillBoard,
 * влекло пересборку options-объекта react-chessboard и общее
 * ощущение «лагов» при переключении drill'а (KS-2424 round-robin
 * усугубил, потому что раньше блоки одного типа давали одинаковую
 * позицию и MemoChessboard не делал работы).
 *
 * Теперь тикает только этот компонент. Когда таймер дошёл до 0 —
 * он один раз вызывает `onExpire`, после чего сам себя гасит.
 *
 * # Контракт DOM
 *
 *   <div class="drill-sprint-play__timer" data-testid="drill-sprint-play-timer"
 *        data-ms-left="…">…</div>
 *
 * Совместим со старыми тестами `DrillSprintPlayPage.test.tsx`.
 */

export interface SprintTimerProps {
  /** Стартовое время сессии sprint'а (durationMs из /sprint/start). */
  durationMs: number;
  /** Время старта сессии в epoch ms. */
  startedAtMs: number;
  /** Префикс «Time left:» из i18n. */
  label: string;
  /** Колбэк, вызываемый ровно один раз когда таймер дошёл до 0. */
  onExpire: () => void;
}

function formatTime(ms: number): string {
  if (ms <= 0) return '0:00';
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export const SprintTimer = memo(function SprintTimer({
  durationMs,
  startedAtMs,
  label,
  onExpire,
}: SprintTimerProps) {
  const [timeLeft, setTimeLeft] = useState<number>(durationMs);

  useEffect(() => {
    let expired = false;
    const tick = () => {
      const remaining = durationMs - (Date.now() - startedAtMs);
      if (remaining <= 0) {
        if (!expired) {
          expired = true;
          setTimeLeft(0);
          onExpire();
        }
        return;
      }
      setTimeLeft(remaining);
    };
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [durationMs, startedAtMs, onExpire]);

  return (
    <div
      className="drill-sprint-play__timer"
      data-testid="drill-sprint-play-timer"
      data-ms-left={timeLeft}
    >
      {label}: {formatTime(timeLeft)}
    </div>
  );
});
