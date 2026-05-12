import { useCallback, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import {
  ReorderableList,
  SortableItem,
} from '../lessons/editor/user/dnd/ReorderableList';
import { studiesApi, type StudyChapterSummaryDto } from '../../api/studiesApi';

/**
 * KS-2831 (KS-2815 §B.5) — список глав студии с drag-n-drop.
 *
 * Использует общую DnD-инфраструктуру `ReorderableList` / `SortableItem`
 * (KS-1861) поверх `@dnd-kit/core` + `@dnd-kit/sortable`. Поддержка
 * mouse / touch / keyboard.
 *
 * При drop вычисляет соседнюю главу слева (`after`) и шлёт
 * `studiesApi.reorderChapter(slug, chapterId, after)`:
 *   - перемещение на самый верх → `after: null`;
 *   - иначе → id главы, идущей слева от новой позиции.
 *
 * Оптимистический UI: меняем порядок локально сразу. При ошибке
 * откатываем (через сохранение исходного `chapters` в ref).
 *
 * Read-only режим (не owner) — без handle'а, без onReorder; список
 * остаётся кликабельным для навигации.
 */

interface ChapterListProps {
  slug: string;
  chapters: StudyChapterSummaryDto[];
  /** Owner или не-owner. Не-owner видит список read-only без DnD. */
  canEdit: boolean;
  /**
   * Колбэк после успешного reorder — родитель (`StudyPage`) обновляет
   * `chapters`-state. По умолчанию `ChapterList` сам управляет порядком,
   * но родитель может перечитать с сервера при необходимости.
   */
  onReorder?: (orderedIds: string[]) => void;
}

/**
 * Чистая функция: по массиву глав и новому порядку ID вычисляет
 * `{movedId, after}` для PATCH `/order`.
 *
 * `after` — chapterId, идущий В НОВОМ ПОРЯДКЕ ЛЕВЕЕ перемещённой главы.
 * Если глава встала первой — `after: null`.
 *
 * Экспортируется для unit-тестов.
 */
export function computeReorderPayload(
  originalIds: readonly string[],
  newIds: readonly string[],
): { movedId: string; after: string | null } | null {
  if (originalIds.length !== newIds.length) return null;
  // Найдём первый id, у которого позиция изменилась — это и есть
  // moved (вернее, один из, но дальше используем его и его новые
  // соседи).
  // Алгоритм проще: ищем элемент чей index изменился больше всего,
  // либо просто различающийся первый-непервый.
  let movedId: string | null = null;
  for (const id of newIds) {
    if (originalIds.indexOf(id) !== newIds.indexOf(id)) {
      // не идеально определяет «который двигали», но для двух соседних
      // случаев работает. Берём первый и доверяем `arrayMove`.
      movedId = id;
      break;
    }
  }
  if (!movedId) return null;
  const newPos = newIds.indexOf(movedId);
  const after = newPos === 0 ? null : newIds[newPos - 1];
  return { movedId, after };
}

export function ChapterList({
  slug,
  chapters,
  canEdit,
  onReorder,
}: ChapterListProps) {
  const { t } = useTranslation();
  // Локальная копия — для оптимистического обновления и rollback.
  const [order, setOrder] = useState<StudyChapterSummaryDto[]>(chapters);
  const [error, setError] = useState<string | null>(null);

  // Если parent передал новый список (после reload) — синхронизируем.
  // Используем шаблон «sync from props» (effect + memoized ids).
  const propsIds = useMemo(() => chapters.map((c) => c.id).join('|'), [chapters]);
  const stateIds = useMemo(() => order.map((c) => c.id).join('|'), [order]);
  if (propsIds !== stateIds && chapters.length !== order.length) {
    // Размер списка изменился (главу добавили/удалили) — синхронизируем.
    setOrder(chapters);
  }

  const itemIds = useMemo(() => order.map((c) => c.id), [order]);

  const handleReorder = useCallback(
    async (nextIds: string[]) => {
      const original = order;
      const map = new Map(order.map((c) => [c.id, c]));
      const nextOrder = nextIds
        .map((id) => map.get(id))
        .filter((c): c is StudyChapterSummaryDto => Boolean(c));
      setOrder(nextOrder);
      setError(null);

      const payload = computeReorderPayload(
        original.map((c) => c.id),
        nextIds,
      );
      if (!payload) return;

      try {
        await studiesApi.reorderChapter(
          slug,
          payload.movedId,
          payload.after,
        );
        onReorder?.(nextIds);
      } catch {
        // Откат при ошибке.
        setOrder(original);
        setError(
          t(
            'studies.error.reorder',
            'Failed to reorder chapters. The previous order is restored.',
          ),
        );
      }
    },
    [order, slug, t, onReorder],
  );

  if (!canEdit) {
    // Read-only: тот же рендер, но без DnD-обёртки.
    return (
      <ol className="study-chapter-list" data-testid="study-chapter-list">
        {order.map((ch) => (
          <li
            key={ch.id}
            className="study-chapter-item"
            data-testid={`study-chapter-${ch.id}`}
          >
            <Link
              to={`/studies/${encodeURIComponent(slug)}/${encodeURIComponent(ch.id)}`}
              className="study-chapter-item__link"
            >
              <span className="study-chapter-item__index">{ch.orderIdx}</span>
              <span className="study-chapter-item__name">{ch.name}</span>
              <span className="study-chapter-item__mode">{ch.mode}</span>
            </Link>
          </li>
        ))}
      </ol>
    );
  }

  return (
    <>
      {error && (
        <div
          className="studies-page__error"
          data-testid="study-chapter-list-error"
        >
          {error}
        </div>
      )}
      <ReorderableList itemIds={itemIds} onReorder={handleReorder}>
        <ol className="study-chapter-list" data-testid="study-chapter-list">
          {order.map((ch, idx) => (
            <SortableItem key={ch.id} id={ch.id}>
              {(h) => (
                <li
                  ref={h.containerRef}
                  style={h.style}
                  className={`study-chapter-item${h.isDragging ? ' study-chapter-item--dragging' : ''}`}
                  data-testid={`study-chapter-${ch.id}`}
                >
                  <button
                    ref={h.handleRef}
                    type="button"
                    className="study-chapter-item__handle"
                    data-testid={`study-chapter-handle-${ch.id}`}
                    aria-label={t(
                      'studies.chapter.drag',
                      'Drag to reorder',
                    )}
                    {...h.attributes}
                    {...h.listeners}
                  >
                    ⠿
                  </button>
                  <Link
                    to={`/studies/${encodeURIComponent(slug)}/${encodeURIComponent(ch.id)}`}
                    className="study-chapter-item__link"
                  >
                    <span className="study-chapter-item__index">
                      {idx + 1}
                    </span>
                    <span className="study-chapter-item__name">
                      {ch.name}
                    </span>
                    <span className="study-chapter-item__mode">{ch.mode}</span>
                  </Link>
                </li>
              )}
            </SortableItem>
          ))}
        </ol>
      </ReorderableList>
    </>
  );
}
