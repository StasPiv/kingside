import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

type Outcome = 'win' | 'loss' | 'draw';

interface GameResultSheetProps {
  /**
   * Управление видимостью — родитель монтирует компонент только при
   * `status === 'finished'`. Внутреннее состояние свёрнуто/раскрыто
   * хранится в компоненте, если не используются `expanded`/
   * `onExpandedChange` (controlled mode для интеграции с
   * `GameActionBar`, KS-4290).
   */
  outcome: Outcome;
  /** Заголовок панели — «Партия завершена». */
  title: string;
  /** Однострочное описание исхода («Ничья», «Белые победили», …). */
  detail: string;
  /**
   * Блок с рейтингом (rating before → after, diff). Передаётся
   * родителем в готовом виде, чтобы не дублировать ту же разметку,
   * что уже используется в модальном окне на desktop.
   */
  ratingBlock?: ReactNode;
  /**
   * Набор кнопок действий (реванш / возврат в турнир / новая партия
   * / в анализ / на главную). Родитель передаёт `renderResultActions(...)`,
   * чтобы один источник истины для набора действий оставался в
   * `GameShell.tsx`.
   */
  actions: ReactNode;
  /**
   * Закрытие подложки тапом по затемнённой области — для паритета
   * с поведением модального окна на desktop. Опционально: если не
   * передано, тап по подложке только сворачивает sheet в полоску.
   */
  onCloseOverlay?: () => void;
  /**
   * KS-4290 (ADR-134 §2): контролируемое состояние свёрнуто/раскрыто.
   * При передаче `expanded`+`onExpandedChange` компонент работает в
   * controlled-режиме — автономная свёрнутая полоска не рендерится,
   * вместо неё в свёрнутом состоянии компонент возвращает `null`
   * (полоску показывает `GameActionBar` в слоте post-game и
   * вызывает `onExpandedChange(true)` для раскрытия). Если хотя бы
   * один из двух пропов отсутствует — uncontrolled-режим как раньше
   * (см. unit-тесты компонента).
   */
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
}

const SWIPE_DOWN_THRESHOLD_PX = 60;

/**
 * KS-4288 / ADR-134 §1: bottom-sheet результата партии на mobile.
 *
 * Заменяет одновременно модальное окно `.game-result-modal-overlay` и
 * встроенный блок `.game-result` в `.game-sidebar` на ширине
 * `max-width: 899px`. Десктоп не трогается — там оба элемента
 * продолжают работать как раньше (CSS-правила см. в `game.css`).
 *
 * Состояния:
 *  - expanded: панель раскрыта, видна подложка с затемнением.
 *  - collapsed: панель свёрнута в полоску «Партия завершена ▲» внизу
 *    экрана; тап по полоске возвращает в expanded.
 *
 * Сворачивание выполняется свайпом вниз по drag-handle (touchstart →
 * touchmove → touchend; если суммарный delta по Y превысил порог —
 * переходим в collapsed).
 *
 * KS-4289 (action-bar): полоска сейчас рендерится автономно поверх
 * нижнего края экрана. Когда action-bar появится, полоску нужно будет
 * встроить внутрь bar'а в качестве отдельного слота.
 */
export function GameResultSheet({
  outcome,
  title,
  detail,
  ratingBlock,
  actions,
  onCloseOverlay,
  expanded: controlledExpanded,
  onExpandedChange,
}: GameResultSheetProps) {
  const { t } = useTranslation();
  // KS-4290: controlled vs uncontrolled. Controlled — когда передан и
  // `expanded`, и `onExpandedChange` (родитель — `GameShell` —
  // синхронизирует с `GameActionBar`). Иначе — внутреннее состояние.
  const isControlled =
    controlledExpanded !== undefined && onExpandedChange !== undefined;
  const [internalExpanded, setInternalExpanded] = useState(true);
  const expanded = isControlled ? controlledExpanded : internalExpanded;
  const setExpanded = (next: boolean) => {
    if (isControlled) onExpandedChange(next);
    else setInternalExpanded(next);
  };
  const [dragOffset, setDragOffset] = useState(0);
  const dragStartYRef = useRef<number | null>(null);

  // Сброс при появлении нового результата (если когда-нибудь
  // компонент будет переиспользован между партиями без unmount).
  // В controlled-режиме сброс выполняет родитель.
  useEffect(() => {
    if (!isControlled) setInternalExpanded(true);
    setDragOffset(0);
  }, [outcome, detail, isControlled]);

  const handleTouchStart = (e: React.TouchEvent) => {
    dragStartYRef.current = e.touches[0]?.clientY ?? null;
    setDragOffset(0);
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (dragStartYRef.current == null) return;
    const currentY = e.touches[0]?.clientY ?? dragStartYRef.current;
    const delta = currentY - dragStartYRef.current;
    // Только вниз — тяга вверх не двигает панель.
    setDragOffset(Math.max(0, delta));
  };

  const handleTouchEnd = () => {
    if (dragStartYRef.current == null) return;
    if (dragOffset > SWIPE_DOWN_THRESHOLD_PX) {
      setExpanded(false);
    }
    dragStartYRef.current = null;
    setDragOffset(0);
  };

  const handleOverlayClick = () => {
    if (onCloseOverlay) onCloseOverlay();
    else setExpanded(false);
  };

  if (!expanded) {
    // KS-4290: в controlled-режиме свёрнутую полоску показывает
    // GameActionBar — здесь возвращаем null, чтобы не дублировать.
    if (isControlled) return null;
    return (
      <button
        type="button"
        className="game-result-pill"
        data-testid="game-result-pill"
        onClick={() => setExpanded(true)}
      >
        {title} ▲
      </button>
    );
  }

  return (
    <div
      className="game-result-sheet-overlay"
      data-testid="game-result-sheet-overlay"
      onClick={handleOverlayClick}
    >
      <div
        className={`game-result-sheet game-result-sheet--${outcome}`}
        data-testid="game-result-sheet"
        style={dragOffset > 0 ? { transform: `translateY(${dragOffset}px)` } : undefined}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="game-result-sheet__handle-area"
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
          aria-label={t('gameResult.dragToCollapse', 'Drag down to collapse')}
        >
          <span className="game-result-sheet__handle" />
        </div>
        <div className="game-result-sheet__header">
          <h2 className="game-result-sheet__title">{title}</h2>
          <p className="game-result-sheet__detail">{detail}</p>
          {ratingBlock && (
            <div className="game-result-sheet__rating">{ratingBlock}</div>
          )}
        </div>
        <div className="game-result-sheet__actions">{actions}</div>
      </div>
    </div>
  );
}
