import { describe, it, expect, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

import {
  moveByDirection,
  reorderByIds,
  useReorderDnD,
} from './useReorderDnD';

/**
 * KS-1856 (FE-R8): тесты reorder-функций и хука.
 */

describe('reorderByIds (pure)', () => {
  it('перемещение вверх: b (idx 1) на a (idx 0) → [b,a,c]', () => {
    expect(reorderByIds(['a', 'b', 'c'], 'b', 'a')).toEqual(['b', 'a', 'c']);
  });

  it('перемещение вниз: a (idx 0) на c (idx 2) → [b,c,a]', () => {
    expect(reorderByIds(['a', 'b', 'c'], 'a', 'c')).toEqual(['b', 'c', 'a']);
  });

  it('fromId === toId → noop (копия массива)', () => {
    const input = ['a', 'b', 'c'];
    const out = reorderByIds(input, 'b', 'b');
    expect(out).toEqual(input);
    expect(out).not.toBe(input); // копия
  });

  it('несуществующий fromId → noop', () => {
    expect(reorderByIds(['a', 'b'], 'x', 'a')).toEqual(['a', 'b']);
  });

  it('несуществующий toId → noop', () => {
    expect(reorderByIds(['a', 'b'], 'a', 'x')).toEqual(['a', 'b']);
  });

  it('перемещение в середину: d (idx 3) на b (idx 1) → [a,d,b,c,e]', () => {
    expect(reorderByIds(['a', 'b', 'c', 'd', 'e'], 'd', 'b')).toEqual([
      'a',
      'd',
      'b',
      'c',
      'e',
    ]);
  });

  it('пустой массив → пустой массив', () => {
    expect(reorderByIds([], 'a', 'b')).toEqual([]);
  });
});

describe('moveByDirection (pure)', () => {
  it('↑ на середине → swap', () => {
    expect(moveByDirection(['a', 'b', 'c'], 'b', -1)).toEqual(['b', 'a', 'c']);
  });

  it('↓ на середине → swap', () => {
    expect(moveByDirection(['a', 'b', 'c'], 'b', 1)).toEqual(['a', 'c', 'b']);
  });

  it('↑ на первом → noop', () => {
    expect(moveByDirection(['a', 'b', 'c'], 'a', -1)).toEqual(['a', 'b', 'c']);
  });

  it('↓ на последнем → noop', () => {
    expect(moveByDirection(['a', 'b', 'c'], 'c', 1)).toEqual(['a', 'b', 'c']);
  });

  it('несуществующий id → noop', () => {
    expect(moveByDirection(['a', 'b'], 'x', 1)).toEqual(['a', 'b']);
  });
});

describe('useReorderDnD (hook)', () => {
  it('getDragProps.onDragStart → dragState.draggingId = id', () => {
    const onReorder = vi.fn();
    const { result } = renderHook(() =>
      useReorderDnD({ items: ['a', 'b', 'c'], onReorder }),
    );
    const dragProps = result.current.getDragProps('b');
    expect(dragProps.draggable).toBe(true);

    // Симулируем DragEvent без реального dataTransfer (jsdom особенность).
    const fakeEvent = {
      dataTransfer: {
        setData: vi.fn(),
        effectAllowed: '',
      },
    } as unknown as React.DragEvent;
    act(() => dragProps.onDragStart(fakeEvent));
    expect(result.current.dragState.draggingId).toBe('b');
  });

  it('onDragOver → dragState.overId = id, preventDefault вызывается', () => {
    const onReorder = vi.fn();
    const { result } = renderHook(() =>
      useReorderDnD({ items: ['a', 'b', 'c'], onReorder }),
    );
    const preventDefault = vi.fn();
    const fake = {
      preventDefault,
      dataTransfer: { dropEffect: '' },
    } as unknown as React.DragEvent;
    act(() => result.current.getDropProps('c').onDragOver(fake));
    expect(preventDefault).toHaveBeenCalled();
    expect(result.current.dragState.overId).toBe('c');
  });

  it('onDrop вызывает onReorder с новым порядком', () => {
    const onReorder = vi.fn();
    const { result } = renderHook(() =>
      useReorderDnD({ items: ['a', 'b', 'c'], onReorder }),
    );
    const fakeDrag = {
      dataTransfer: { setData: vi.fn(), effectAllowed: '' },
    } as unknown as React.DragEvent;
    act(() => result.current.getDragProps('a').onDragStart(fakeDrag));
    const fakeDrop = {
      preventDefault: vi.fn(),
      dataTransfer: { dropEffect: '' },
    } as unknown as React.DragEvent;
    act(() => result.current.getDropProps('c').onDrop(fakeDrop));
    expect(onReorder).toHaveBeenCalledWith(['b', 'c', 'a']);
    expect(result.current.dragState.draggingId).toBeNull();
  });

  it('onDragEnd (без drop) → state сбрасывается', () => {
    const { result } = renderHook(() =>
      useReorderDnD({ items: ['a', 'b'], onReorder: vi.fn() }),
    );
    const fake = {
      dataTransfer: { setData: vi.fn(), effectAllowed: '' },
    } as unknown as React.DragEvent;
    act(() => result.current.getDragProps('a').onDragStart(fake));
    expect(result.current.dragState.draggingId).toBe('a');
    act(() => result.current.getDragProps('a').onDragEnd());
    expect(result.current.dragState.draggingId).toBeNull();
  });

  it('keyboard: Space подхватывает (keyboardMode=true, aria-grabbed=true)', () => {
    const { result } = renderHook(() =>
      useReorderDnD({ items: ['a', 'b'], onReorder: vi.fn() }),
    );
    const keyboardProps = result.current.getKeyboardProps('a');
    expect(keyboardProps['aria-grabbed']).toBe(false);
    const preventDefault = vi.fn();
    act(() =>
      keyboardProps.onKeyDown({
        key: ' ',
        preventDefault,
      } as unknown as React.KeyboardEvent),
    );
    expect(preventDefault).toHaveBeenCalled();
    expect(result.current.dragState.keyboardMode).toBe(true);
    expect(result.current.dragState.draggingId).toBe('a');
  });

  it('keyboard: подхват + ↓ → onReorder(move down)', () => {
    const onReorder = vi.fn();
    const { result } = renderHook(() =>
      useReorderDnD({ items: ['a', 'b', 'c'], onReorder }),
    );
    const pd = () => vi.fn();
    // Подхватываем «b».
    act(() =>
      result.current.getKeyboardProps('b').onKeyDown({
        key: ' ',
        preventDefault: pd(),
      } as unknown as React.KeyboardEvent),
    );
    // ↓ → move down.
    act(() =>
      result.current.getKeyboardProps('b').onKeyDown({
        key: 'ArrowDown',
        preventDefault: pd(),
      } as unknown as React.KeyboardEvent),
    );
    expect(onReorder).toHaveBeenCalledWith(['a', 'c', 'b']);
  });

  it('keyboard: Escape → сброс без reorder', () => {
    const onReorder = vi.fn();
    const { result } = renderHook(() =>
      useReorderDnD({ items: ['a', 'b'], onReorder }),
    );
    const pd = vi.fn();
    act(() =>
      result.current.getKeyboardProps('a').onKeyDown({
        key: ' ',
        preventDefault: pd,
      } as unknown as React.KeyboardEvent),
    );
    expect(result.current.dragState.keyboardMode).toBe(true);
    act(() =>
      result.current.getKeyboardProps('a').onKeyDown({
        key: 'Escape',
        preventDefault: pd,
      } as unknown as React.KeyboardEvent),
    );
    expect(result.current.dragState.keyboardMode).toBe(false);
    expect(result.current.dragState.draggingId).toBeNull();
    expect(onReorder).not.toHaveBeenCalled();
  });

  it('keyboard: повторный Space → отпустить (drop) без reorder', () => {
    const onReorder = vi.fn();
    const { result } = renderHook(() =>
      useReorderDnD({ items: ['a', 'b'], onReorder }),
    );
    const pd = vi.fn();
    act(() =>
      result.current.getKeyboardProps('a').onKeyDown({
        key: ' ',
        preventDefault: pd,
      } as unknown as React.KeyboardEvent),
    );
    act(() =>
      result.current.getKeyboardProps('a').onKeyDown({
        key: ' ',
        preventDefault: pd,
      } as unknown as React.KeyboardEvent),
    );
    expect(result.current.dragState.keyboardMode).toBe(false);
    expect(result.current.dragState.draggingId).toBeNull();
    // onReorder не вызывается, т.к. перемещений через ↑↓ не было.
    expect(onReorder).not.toHaveBeenCalled();
  });
});
