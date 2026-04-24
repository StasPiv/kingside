import { describe, it, expect, vi } from 'vitest';

import { renderWithProviders, screen } from '../../../../../test/test-utils';
import {
  ReorderableList,
  SortableItem,
  reorderById,
} from './ReorderableList';

/**
 * KS-1861 (FE-R13): тесты `ReorderableList` + `SortableItem`.
 *
 * Pure-helper `reorderById` покрывается напрямую (как `reorderByIds`
 * в FE-R8).
 *
 * Сами DnD-сценарии (touch/mouse/keyboard) на dnd-kit'е через jsdom
 * прогонять не имеет смысла — happy-dom не симулирует реальные
 * pointer/touch события так, как их видит KeyboardSensor / TouchSensor.
 * Полный сценарий покрывается e2e-тестом против реального браузера
 * (см. KS-1871 + ручной mobile-skim в `/tmp/KS-1861/`).
 *
 * Здесь — smoke-тесты структуры: компоненты рендерятся без ошибок,
 * SortableItem отдаёт bag с ref'ами, drag-handle получает ARIA-
 * атрибуты от useSortable.
 */

describe('reorderById (pure)', () => {
  it('перенос вниз: a → c в [a,b,c] → [b,c,a]', () => {
    expect(reorderById(['a', 'b', 'c'], 'a', 'c')).toEqual(['b', 'c', 'a']);
  });

  it('перенос вверх: c → a в [a,b,c] → [c,a,b]', () => {
    expect(reorderById(['a', 'b', 'c'], 'c', 'a')).toEqual(['c', 'a', 'b']);
  });

  it('from === to → noop (но возвращает копию)', () => {
    const input = ['a', 'b', 'c'];
    const out = reorderById(input, 'b', 'b');
    expect(out).toEqual(input);
    expect(out).not.toBe(input);
  });

  it('несуществующий fromId → noop (копия)', () => {
    expect(reorderById(['a', 'b'], 'x', 'a')).toEqual(['a', 'b']);
  });

  it('несуществующий toId → noop (копия)', () => {
    expect(reorderById(['a', 'b'], 'a', 'x')).toEqual(['a', 'b']);
  });

  it('пустой список → пустой массив', () => {
    expect(reorderById([], 'a', 'b')).toEqual([]);
  });

  it('перенос в середину: [a,b,c,d,e] d→b → [a,d,b,c,e]', () => {
    expect(reorderById(['a', 'b', 'c', 'd', 'e'], 'd', 'b')).toEqual([
      'a',
      'd',
      'b',
      'c',
      'e',
    ]);
  });
});

describe('<ReorderableList> + <SortableItem>', () => {
  it('рендерит children без ошибок и пробрасывает bag в render-prop', () => {
    const onReorder = vi.fn();
    let observedBagId: string | null = null;
    renderWithProviders(
      <ReorderableList itemIds={['a', 'b']} onReorder={onReorder}>
        <ul data-testid="list">
          <SortableItem id="a">
            {(h) => {
              observedBagId = h.isDragging ? 'dragging' : 'idle';
              return (
                <li
                  ref={h.containerRef}
                  style={h.style}
                  data-testid="item-a"
                >
                  <button
                    type="button"
                    ref={h.handleRef}
                    data-testid="handle-a"
                    {...h.attributes}
                    {...h.listeners}
                  >
                    ⠿
                  </button>
                </li>
              );
            }}
          </SortableItem>
        </ul>
      </ReorderableList>,
    );
    expect(screen.getByTestId('list')).toBeInTheDocument();
    expect(screen.getByTestId('item-a')).toBeInTheDocument();
    // Initial state — не dragging.
    expect(observedBagId).toBe('idle');

    // dnd-kit ставит role/tabIndex/aria-roledescription на handle через
    // attributes; проверяем что они дошли до DOM.
    const handle = screen.getByTestId('handle-a');
    expect(handle.getAttribute('role')).toBe('button');
    expect(handle.getAttribute('aria-roledescription')).toBeTruthy();
    // tabIndex обязательно для KeyboardSensor (focus → Space → pickup).
    expect(handle.getAttribute('tabindex')).toBe('0');
  });

  it('onReorder НЕ вызывается на простом рендере (без drag-события)', () => {
    const onReorder = vi.fn();
    renderWithProviders(
      <ReorderableList itemIds={['a', 'b']} onReorder={onReorder}>
        <SortableItem id="a">
          {(h) => (
            <div ref={h.containerRef} style={h.style}>
              <button ref={h.handleRef} {...h.attributes} {...h.listeners}>
                a
              </button>
            </div>
          )}
        </SortableItem>
      </ReorderableList>,
    );
    expect(onReorder).not.toHaveBeenCalled();
  });
});
