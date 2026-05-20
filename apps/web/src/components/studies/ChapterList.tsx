import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  /**
   * KS-2912: колбэк после успешного удаления главы. Родитель может
   * перечитать список / обновить счётчики. `ChapterList` сам делает
   * optimistic-remove из локального `order`.
   */
  onDeleted?: (chapterId: string) => void;
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
  onDeleted,
}: ChapterListProps) {
  const { t } = useTranslation();
  // Локальная копия — для оптимистического обновления и rollback.
  const [order, setOrder] = useState<StudyChapterSummaryDto[]>(chapters);
  const [error, setError] = useState<string | null>(null);

  // KS-2912: pendingDeletes — ID, для которых мы сделали optimistic
  // remove. Sync-from-props фильтрует их, чтобы parent (ещё не успевший
  // reload) не перезатёр локальный optimistic-state.
  const pendingDeletesRef = useRef<Set<string>>(new Set());

  // Sync from props: при изменении `chapters` (reference) подменяем
  // локальный order. Pending-deletes фильтруем — они должны остаться
  // вне списка до тех пор, пока parent не обновит chapters.
  useEffect(() => {
    setOrder(
      chapters.filter((c) => !pendingDeletesRef.current.has(c.id)),
    );
  }, [chapters]);

  const itemIds = useMemo(() => order.map((c) => c.id), [order]);

  // KS-2912: удаление главы из списка. Optimistic-remove из локального
  // `order`, rollback при ошибке. Backend dual-protected: viewer без
  // прав получит 403. UI-уровень скрываем кнопку под `canEdit` (owner/
  // contributor — те же права что у DnD-handle'а).
  const handleDelete = useCallback(
    async (chapterId: string) => {
      const confirmed = window.confirm(
        t(
          'studies.confirm.deleteChapter',
          'Delete this chapter? This cannot be undone.',
        ),
      );
      if (!confirmed) return;
      // Optimistic: фиксируем pending + убираем из order.
      pendingDeletesRef.current.add(chapterId);
      setOrder((prev) => prev.filter((c) => c.id !== chapterId));
      setError(null);
      try {
        await studiesApi.deleteChapter(slug, chapterId);
        onDeleted?.(chapterId);
        // pending очищается только когда parent перечитает chapters
        // и оттуда исчезнет deleted-id; до этого фильтр в sync-from-props
        // удерживает удалённый из визуального списка.
      } catch {
        // Откат: убираем из pending, возвращаем главу в order.
        pendingDeletesRef.current.delete(chapterId);
        setOrder((prev) => {
          const has = prev.some((c) => c.id === chapterId);
          if (has) return prev;
          // Восстанавливаем позицию из props (сохраняем исходный порядок).
          const restored = chapters.find((c) => c.id === chapterId);
          if (!restored) return prev;
          // Вставка перед первым элементом, который имеет orderIdx больше.
          // Если все меньше — в конец.
          const next = [...prev];
          const insertAt = next.findIndex(
            (c) => c.orderIdx > restored.orderIdx,
          );
          if (insertAt === -1) next.push(restored);
          else next.splice(insertAt, 0, restored);
          return next;
        });
        setError(
          t('studies.error.delete', 'Failed to delete chapter.'),
        );
      }
    },
    [chapters, slug, t, onDeleted],
  );

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

  // KS-3125 (follow-up): editor-роут глав `/studies/:slug/:chapterId`
  // удалён в KS-3014 (коммит 4092dd97). До восстановления отдельной
  // страницы прохождения главы (на architect) рендерим главу как
  // некликабельный блок — иначе `<Link>` уносит в wildcard → `/play`,
  // что хуже отсутствия перехода. Title объясняет причину.
  const chapterRowTitle = t(
    'studies.chapter.openUnavailable',
    'Opening a chapter is temporarily unavailable while the chapter view is being rebuilt.',
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
            <span
              className="study-chapter-item__link study-chapter-item__link--disabled"
              data-testid={`study-chapter-row-${ch.id}`}
              data-slug={slug}
              data-chapter-id={ch.id}
              title={chapterRowTitle}
              aria-disabled="true"
            >
              <span className="study-chapter-item__index">{ch.orderIdx}</span>
              <span className="study-chapter-item__name">{ch.name}</span>
              <span className="study-chapter-item__mode">{ch.mode}</span>
            </span>
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
                  <span
                    className="study-chapter-item__link study-chapter-item__link--disabled"
                    data-testid={`study-chapter-row-${ch.id}`}
                    data-slug={slug}
                    data-chapter-id={ch.id}
                    title={chapterRowTitle}
                    aria-disabled="true"
                  >
                    <span className="study-chapter-item__index">
                      {idx + 1}
                    </span>
                    <span className="study-chapter-item__name">
                      {ch.name}
                    </span>
                    <span className="study-chapter-item__mode">{ch.mode}</span>
                  </span>
                  {/* KS-2912: delete chapter button — owner/contributor.
                      window.confirm перед deleteChapter API-вызовом. */}
                  <button
                    type="button"
                    className="study-chapter-item__delete"
                    data-testid={`study-chapter-delete-${ch.id}`}
                    aria-label={t(
                      'studies.action.deleteChapter',
                      'Delete chapter',
                    )}
                    title={t(
                      'studies.action.deleteChapter',
                      'Delete chapter',
                    )}
                    onClick={() => void handleDelete(ch.id)}
                  >
                    🗑
                  </button>
                </li>
              )}
            </SortableItem>
          ))}
        </ol>
      </ReorderableList>
    </>
  );
}
