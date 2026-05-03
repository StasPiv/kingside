import { useEffect } from 'react';

/**
 * KS-2234 (ADR-035 §7.3, E3) — 4 кнопки 1-4 для ответа на drill с
 * `shape='number'` (например, «сколько фигур атакует e5?»).
 *
 * Полностью controlled-компонент: хост хранит `selected` и обрабатывает
 * `onSelect`. После выбора кнопки можно дизейблить весь блок (`disabled`)
 * до перехода к следующему drill'у.
 *
 * Hotkeys: цифры `1`..`4` на клавиатуре — то же что клик. Игнорируется,
 * если фокус в `<input>` / `<textarea>` / contenteditable, или нажат
 * Cmd/Ctrl/Alt (системные шорткаты не перехватываем).
 *
 * # Контракт DOM
 *
 *   <div class="drill-count-attackers" data-testid="drill-count-attackers">
 *     <button class="drill-count-attackers__btn"
 *             data-testid="drill-count-attackers-btn-1"
 *             data-active="true|false"
 *             type="button"
 *             aria-pressed="true|false"
 *             disabled?>1</button>
 *     … 2, 3, 4
 *   </div>
 */
export type DrillCountValue = 1 | 2 | 3 | 4;

export interface DrillCountAttackersButtonsProps {
  selected?: DrillCountValue | null;
  disabled?: boolean;
  onSelect: (value: DrillCountValue) => void;
}

const VALUES: DrillCountValue[] = [1, 2, 3, 4];

export function DrillCountAttackersButtons({
  selected = null,
  disabled = false,
  onSelect,
}: DrillCountAttackersButtonsProps) {
  useEffect(() => {
    if (disabled) return;
    const handler = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)
      ) {
        return;
      }
      const n = Number(e.key);
      if (Number.isInteger(n) && n >= 1 && n <= 4) {
        e.preventDefault();
        onSelect(n as DrillCountValue);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [disabled, onSelect]);

  return (
    <div
      className="drill-count-attackers"
      data-testid="drill-count-attackers"
      role="group"
      aria-label="Count attackers"
    >
      {VALUES.map((v) => {
        const active = selected === v;
        return (
          <button
            key={v}
            type="button"
            className={`drill-count-attackers__btn${active ? ' drill-count-attackers__btn--active' : ''}`}
            data-testid={`drill-count-attackers-btn-${v}`}
            data-active={active ? 'true' : 'false'}
            aria-pressed={active}
            disabled={disabled}
            onClick={() => onSelect(v)}
          >
            {v}
          </button>
        );
      })}
    </div>
  );
}
