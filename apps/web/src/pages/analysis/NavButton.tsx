import { type ReactNode } from 'react';

import { useLongPress } from '../../hooks/useLongPress';
import { useBoardSettings } from '../../hooks/useBoardSettings';

/**
 * KS-3198: кнопка навигации по ходам с long-press авто-повтором.
 *
 * Используется для `⇤` / `←` / `→` / `⇥` в `.analysis-board-controls`.
 * Контракт совместим с обычной `<button>`:
 *   - `onClick` срабатывает на короткий tap (как раньше).
 *   - При удержании ≥ `warmUpDelay` запускается setInterval, который
 *     каждые `tickInterval` (зависит от пресета `navAutoRepeatSpeed`)
 *     дёргает тот же `onClick`.
 *   - `disabled` гасит и tap, и long-press (нет авто-перемотки за
 *     конец / начало партии).
 *
 * Скорость берётся из `BoardSettingsContext.navAutoRepeatSpeed`
 * (settings.localStorage), поэтому пользователь меняет её в одном
 * месте — в настройках.
 *
 * Haptic feedback включён всегда для touch — лёгкая вибрация (8ms)
 * на каждом авто-tick'е помогает понять, что повтор идёт. На iOS
 * `navigator.vibrate` отсутствует, gracefully ignored.
 */
export interface NavButtonProps {
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  className?: string;
  /**
   * Для тестов и для `aria-label`-fallback. Текст уже передаётся
   * через children, но в jsdom-тестах удобно дёргать кнопку по
   * `data-testid`.
   */
  testId?: string;
  children: ReactNode;
}

export function NavButton({
  onClick,
  disabled,
  title,
  className,
  testId,
  children,
}: NavButtonProps) {
  // KS-3415: интервал авто-повтора берём напрямую в мс из настроек
  // (ползунок). Раньше — маппинг preset-id → intervalMs.
  const { navAutoRepeatMs } = useBoardSettings();

  const longPress = useLongPress({
    onAction: onClick,
    tickInterval: navAutoRepeatMs,
    disabled,
    // Haptic — мягкая вибрация, помогает почувствовать каждый tick на
    // мобильных. На desktop и iOS — no-op (см. useLongPress).
    haptic: true,
  });

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={className}
      data-testid={testId}
      // KS-3198: блокируем нативное selection / context-menu, которые
      // на mobile срабатывают на длинном удержании и ломают UX
      // (Android Chrome показывает магнификатор поверх кнопки).
      // touch-action: manipulation убирает 300ms-delay tap.
      style={{ touchAction: 'manipulation', userSelect: 'none' }}
      {...longPress}
    >
      {children}
    </button>
  );
}
