import { useCallback, useRef, useState } from 'react';

/**
 * `useReorderDnD` — HTML5 DnD reorder с клавиатурной a11y
 * (KS-1848 §3.8, KS-1856 / FE-R8).
 *
 * Встраивание: для каждого элемента списка получить два набора props
 * через `getDragProps(id)` и `getDropProps(id)`. Drag-handle получает
 * `getKeyboardProps(id)` — tabindex + Space для подхвата, ↑/↓ для
 * перемещения, Space/Enter для drop, Esc для отмены.
 *
 * Оптимистичный UI: хук сам НЕ делает API-вызовов. Колбэк `onReorder`
 * получает новый порядок ID'ов; родитель применяет PATCH/revert.
 *
 * # Что НЕ делает
 *
 * Touch-DnD (iOS/Android) отдельный тикет FE-R13 — здесь только
 * HTML5 DragEvent API, который на мобильных не работает. Поэтому
 * для mobile фаллбек — клавиатурный доступ (через экранные кнопки
 * ↑↓) + touch-dnd добавится позже.
 */

export interface DragState {
  draggingId: string | null;
  overId: string | null;
  /** true если drag управляется клавиатурой (Space активировал). */
  keyboardMode: boolean;
}

export interface UseReorderDnDOptions {
  /** Текущий порядок id'ов. */
  items: readonly string[];
  /** Вызывается при завершении перетаскивания с новым порядком. */
  onReorder: (nextIds: string[]) => void;
}

export interface UseReorderDnDReturn {
  dragState: DragState;
  getDragProps: (id: string) => {
    draggable: true;
    onDragStart: (e: React.DragEvent) => void;
    onDragEnd: () => void;
  };
  getDropProps: (id: string) => {
    onDragOver: (e: React.DragEvent) => void;
    onDragLeave: () => void;
    onDrop: (e: React.DragEvent) => void;
  };
  getKeyboardProps: (id: string) => {
    tabIndex: 0;
    role: 'button';
    'aria-grabbed': boolean;
    onKeyDown: (e: React.KeyboardEvent) => void;
  };
}

// ─── Pure helper ─────────────────────────────────────────────────────

/**
 * Возвращает новый массив id'ов: `fromId` перенесён на позицию
 * `toId`. Если один из id не найден / оба одинаковые — возвращается
 * тот же массив (для memoization / noop). Экспортируется для unit-
 * тестов.
 */
export function reorderByIds(
  items: readonly string[],
  fromId: string,
  toId: string,
): string[] {
  if (fromId === toId) return items.slice();
  const fromIdx = items.indexOf(fromId);
  const toIdx = items.indexOf(toId);
  if (fromIdx === -1 || toIdx === -1) return items.slice();
  const next = items.slice();
  const [moved] = next.splice(fromIdx, 1);
  // Семантика: drop «на» toId — moved занимает визуальную позицию toId,
  // target сдвигается в сторону, откуда moved пришёл.
  //  - fromIdx > toIdx (перенос вверх): после splice toIdx не сдвинулся,
  //    вставка в toIdx → target смещается вправо.
  //  - fromIdx < toIdx (перенос вниз): после splice toIdx сдвинулся на −1,
  //    но мы хотим чтобы moved оказался ПОСЛЕ (на визуальной позиции
  //    toId, который теперь на toIdx−1). В обоих случаях это `toIdx`
  //    в исходной индексации — с учётом что splice «съел» fromIdx.
  //    Так что формула одинакова: insertAt = toIdx.
  next.splice(toIdx, 0, moved);
  return next;
}

/** Переместить `id` на `direction` (−1 вверх, +1 вниз). Пограничные
 * позиции — noop (возвращается тот же массив). */
export function moveByDirection(
  items: readonly string[],
  id: string,
  direction: -1 | 1,
): string[] {
  const idx = items.indexOf(id);
  if (idx === -1) return items.slice();
  const target = idx + direction;
  if (target < 0 || target >= items.length) return items.slice();
  const next = items.slice();
  [next[idx], next[target]] = [next[target], next[idx]];
  return next;
}

// ─── Hook ────────────────────────────────────────────────────────────

export function useReorderDnD({
  items,
  onReorder,
}: UseReorderDnDOptions): UseReorderDnDReturn {
  const [state, setState] = useState<DragState>({
    draggingId: null,
    overId: null,
    keyboardMode: false,
  });
  // Актуальные items — ref чтобы колбэки в dataTransfer не замыкались
  // на stale copy.
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const finish = useCallback(
    (fromId: string, toId: string) => {
      if (fromId === toId) {
        setState({ draggingId: null, overId: null, keyboardMode: false });
        return;
      }
      const next = reorderByIds(itemsRef.current, fromId, toId);
      if (next.length > 0) onReorder(next);
      setState({ draggingId: null, overId: null, keyboardMode: false });
    },
    [onReorder],
  );

  const cancel = useCallback(() => {
    setState({ draggingId: null, overId: null, keyboardMode: false });
  }, []);

  const getDragProps = useCallback(
    (id: string) => ({
      draggable: true as const,
      onDragStart: (e: React.DragEvent) => {
        // dataTransfer нужен для некоторых браузеров чтобы drag
        // стартовал; содержание — id, не используем потом.
        try {
          e.dataTransfer.setData('text/plain', id);
          e.dataTransfer.effectAllowed = 'move';
        } catch {
          /* happy-dom иногда не поддерживает dataTransfer.setData */
        }
        setState({ draggingId: id, overId: null, keyboardMode: false });
      },
      onDragEnd: () => {
        setState({ draggingId: null, overId: null, keyboardMode: false });
      },
    }),
    [],
  );

  const getDropProps = useCallback(
    (id: string) => ({
      onDragOver: (e: React.DragEvent) => {
        // preventDefault НЕОБХОДИМ — иначе браузер не даст дропнуть.
        e.preventDefault();
        try {
          e.dataTransfer.dropEffect = 'move';
        } catch {
          /* noop */
        }
        setState((prev) =>
          prev.overId === id ? prev : { ...prev, overId: id },
        );
      },
      onDragLeave: () => {
        setState((prev) =>
          prev.overId === id ? { ...prev, overId: null } : prev,
        );
      },
      onDrop: (e: React.DragEvent) => {
        e.preventDefault();
        // Используем state.draggingId, а не dataTransfer — state надёжнее
        // в React-контексте (dataTransfer в jsdom часто undefined).
        setState((prev) => {
          const fromId = prev.draggingId;
          if (fromId && fromId !== id) {
            const next = reorderByIds(itemsRef.current, fromId, id);
            if (next.length > 0) onReorder(next);
          }
          return { draggingId: null, overId: null, keyboardMode: false };
        });
      },
    }),
    [onReorder],
  );

  const getKeyboardProps = useCallback(
    (id: string) => ({
      tabIndex: 0 as const,
      role: 'button' as const,
      'aria-grabbed': state.draggingId === id && state.keyboardMode,
      onKeyDown: (e: React.KeyboardEvent) => {
        // Space — подхватить (keyboardMode) или отпустить.
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault();
          setState((prev) => {
            if (prev.keyboardMode && prev.draggingId === id) {
              // Drop (остаёмся на текущей позиции — reorder уже
              // происходил по ↑/↓).
              return { draggingId: null, overId: null, keyboardMode: false };
            }
            return { draggingId: id, overId: id, keyboardMode: true };
          });
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          cancel();
          return;
        }
        if (
          (e.key === 'ArrowUp' || e.key === 'ArrowDown') &&
          state.keyboardMode &&
          state.draggingId === id
        ) {
          e.preventDefault();
          const dir: -1 | 1 = e.key === 'ArrowUp' ? -1 : 1;
          const next = moveByDirection(itemsRef.current, id, dir);
          onReorder(next);
        }
      },
    }),
    [cancel, onReorder, state.draggingId, state.keyboardMode],
  );
  // Избежать warning'а что finish не используется — экспортируем
  // как эффект onDrop напрямую; finish — helper для будущего расширения.
  void finish;

  return {
    dragState: state,
    getDragProps,
    getDropProps,
    getKeyboardProps,
  };
}
