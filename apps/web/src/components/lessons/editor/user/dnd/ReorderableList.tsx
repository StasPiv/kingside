import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

/**
 * `ReorderableList` + `SortableItem` (KS-1861 / FE-R13) — обёртка
 * вокруг `@dnd-kit/core` + `@dnd-kit/sortable` для list-reorder с
 * полноценной поддержкой touch.
 *
 * Заменяет HTML5-DnD из FE-R8 (`useReorderDnD`):
 *  - HTML5 `DragEvent` API вообще не поддерживается на iOS/Android.
 *    `@dnd-kit` слушает pointer/touch напрямую, так что reorder работает
 *    мышью на десктопе и пальцем на мобильных одинаково.
 *  - Клавиатурный reorder (Tab → Space → ↑/↓ → Space, Esc — cancel)
 *    реализуется штатным `KeyboardSensor` + `sortableKeyboardCoordinates`,
 *    с правильными ARIA live-announcements из коробки.
 *
 * # Сенсоры
 *
 *  - `PointerSensor` `distance: 5` — drag активируется только после
 *    смещения на 5px, поэтому обычные клики на handle (например,
 *    `aria-label`) не превращаются в drag.
 *  - `TouchSensor` `delay: 250ms`, `tolerance: 5px` — long-press для
 *    активации, чтобы перетаскивание не стартовало при попытке
 *    проскроллить страницу пальцем по списку.
 *  - `KeyboardSensor` с `sortableKeyboardCoordinates` — стандартный
 *    coordinate-getter из `@dnd-kit/sortable`, корректно вычисляет
 *    позиции при ↑/↓ для vertical-strategy.
 *
 * # Использование
 *
 * ```tsx
 * <ReorderableList itemIds={ids} onReorder={setOrder}>
 *   <ol>
 *     {items.map((item) => (
 *       <SortableItem key={item.id} id={item.id}>
 *         {(h) => (
 *           <li ref={h.containerRef} style={h.style}>
 *             <button ref={h.handleRef} {...h.attributes} {...h.listeners}>⠿</button>
 *             {item.label}
 *           </li>
 *         )}
 *       </SortableItem>
 *     ))}
 *   </ol>
 * </ReorderableList>
 * ```
 *
 * `containerRef` идёт на корневой DOM-узел item'а (для transform
 * во время drag); `handleRef` + `attributes` + `listeners` — на
 * drag-handle (`<button>` с символом `⠿`). KeyboardSensor требует
 * чтобы `handleRef` был именно на handle (не на корневом узле),
 * иначе focus будет «съедаться» всем item'ом.
 */

// ─── Pure helper ─────────────────────────────────────────────────────

/**
 * Перенос элемента `from` на позицию `to` в массиве `ids`. Враппер
 * над `arrayMove` из `@dnd-kit/sortable` с обработкой несуществующих
 * id'ов (возвращает копию исходного массива). Чистая функция, удобно
 * для unit-тестов.
 */
export function reorderById(
  ids: readonly string[],
  fromId: string,
  toId: string,
): string[] {
  if (fromId === toId) return ids.slice();
  const fromIdx = ids.indexOf(fromId);
  const toIdx = ids.indexOf(toId);
  if (fromIdx === -1 || toIdx === -1) return ids.slice();
  return arrayMove(ids.slice(), fromIdx, toIdx);
}

// ─── Components ──────────────────────────────────────────────────────

export interface ReorderableListProps {
  /** Текущий порядок ID элементов (контролируется родителем). */
  itemIds: readonly string[];
  /**
   * Колбэк с новым порядком после drop. Вызывается ТОЛЬКО если
   * порядок реально изменился (active.id !== over.id).
   */
  onReorder: (orderedIds: string[]) => void;
  children: React.ReactNode;
}

export function ReorderableList({
  itemIds,
  onReorder,
  children,
}: ReorderableListProps) {
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 },
    }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 250, tolerance: 5 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const next = reorderById(itemIds, String(active.id), String(over.id));
    onReorder(next);
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={handleDragEnd}
    >
      <SortableContext
        items={itemIds.slice()}
        strategy={verticalListSortingStrategy}
      >
        {children}
      </SortableContext>
    </DndContext>
  );
}

export interface SortableHandleBag {
  /** Ref для корневого DOM-узла item'а (получает transform/transition). */
  containerRef: (node: HTMLElement | null) => void;
  /**
   * Ref для drag-handle (`<button>`). Обязателен для KeyboardSensor —
   * именно с этого элемента начинается клавиатурный pickup.
   */
  handleRef: (node: HTMLElement | null) => void;
  /** Inline-style с transform/transition; вешать на корневой узел. */
  style: React.CSSProperties;
  /**
   * ARIA-атрибуты от dnd-kit (role, tabIndex, aria-roledescription и т.п.).
   * Вешать на drag-handle.
   */
  attributes: Record<string, unknown>;
  /**
   * Event-листенеры активации drag (onPointerDown, onKeyDown, onTouchStart).
   * Вешать на drag-handle.
   */
  listeners: Record<string, unknown>;
  isDragging: boolean;
  isOver: boolean;
}

export interface SortableItemProps {
  id: string;
  children: (handle: SortableHandleBag) => React.ReactNode;
}

export function SortableItem({ id, children }: SortableItemProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
    isOver,
  } = useSortable({ id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    // Полупрозрачность + поверх остальных, чтобы пользователь видел что
    // элемент «приподнят». Без этого drop-positions неинтуитивны.
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 10 : undefined,
  };

  return (
    <>
      {children({
        containerRef: setNodeRef,
        handleRef: setActivatorNodeRef,
        style,
        attributes: attributes as unknown as Record<string, unknown>,
        listeners: (listeners ?? {}) as unknown as Record<string, unknown>,
        isDragging,
        isOver,
      })}
    </>
  );
}
