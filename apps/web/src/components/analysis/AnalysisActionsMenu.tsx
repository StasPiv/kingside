/**
 * KS-3421 (ADR-087 §8 F1). Единое меню действий AnalysisPage — один
 * items-source, два режима рендера:
 *  - `mode='dropdown'` (desktop ≥768px) — popover с section-разделителями,
 *    позиционируется относительно родителя caller'а (relative wrapper —
 *    `<div className="analysis-overflow-wrapper">`).
 *  - `mode='sheet'` (mobile <768px) — bottom-sheet по существующему
 *    паттерну (ADR-076/080: fixed-bottom, swipe-down/backdrop tap close,
 *    safe-area-inset через CSS, ✕ в header, один snap). См.
 *    PrecisionRatingSheet/PrecisionThemesSheet.
 *  - `mode='auto'` (по умолчанию) — выбор через `useIsMobile()`.
 *
 * Items-source — массив `AnalysisActionItem` (caller строит из своего
 * контекста: kind/owner/history/publicMode). Видимость определяется
 * `visible`; auth-gating для гостя — `disabled + disabledHint` (вариант
 * Б из ADR-087), а не скрытие.
 *
 * Иконки в этом MVP НЕ рендерим (M2). После тапа на пункт sheet
 * закрывается сразу — caller вызывает `onClose()` после выполнения
 * действия (в `onClick`).
 *
 * Подача в AnalysisPage — за `ANALYSIS_ACTIONS_MENU_V2_ENABLED` (см.
 * `src/config/analysisActionsMenu.ts`).
 */
import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { useIsMobile } from '../../hooks/useIsMobile';
import type { LectureDisabledTool } from '@kingside/shared';

export type AnalysisActionGroup =
  | 'gamePosition' // FEN / Game info / Find games
  | 'pgn' // Export / Copy
  | 'training' // Puzzle / Guess / Repertoires
  | 'sharing' // Share
  // KS-3755: live-трансляция анализа. Старт/копирование/завершение —
  // отдельная группа в конце меню, чтобы не смешиваться с действиями
  // над PGN/позицией.
  | 'broadcast';

export interface AnalysisActionItem {
  /** Стабильный id для data-testid и React-keys. */
  id: string;
  /** Группа для секционного разделения в dropdown/sheet. */
  group: AnalysisActionGroup;
  /** Текст пункта (готовый, переведённый caller'ом). */
  label: string;
  /** Действие; компонент дополнительно вызывает `onClose()` после. */
  onClick: () => void;
  /** Если false — пункт не рендерим (caller-side gating). */
  visible?: boolean;
  /** Disabled + tooltip; используется для auth-only пунктов гостям. */
  disabled?: boolean;
  /** Текст tooltip'а при disabled. */
  disabledHint?: string;
}

export type AnalysisActionsMenuMode = 'auto' | 'dropdown' | 'sheet';

export interface AnalysisActionsMenuProps {
  open: boolean;
  onClose: () => void;
  items: AnalysisActionItem[];
  /** Режим рендера. Дефолт — `'auto'` (по `useIsMobile()`). */
  mode?: AnalysisActionsMenuMode;
  /**
   * KS-3908 / ADR-117 C04. Список инструментов, запрещённых учителем
   * для учеников лекции. Меню само по себе items не модифицирует —
   * сейчас политика прокидывается «для будущих C03 шагов» (фильтрация
   * пунктов `analyze_game` / `generate_puzzle` / `find_by_position`
   * добавится отдельным шагом). Сделано опционально, чтобы старые
   * caller'ы не ломались.
   */
  studentToolsPolicy?: LectureDisabledTool[];
}

const GROUP_ORDER: AnalysisActionGroup[] = [
  'gamePosition',
  'pgn',
  'training',
  'sharing',
  // KS-3755: «broadcast» в самом конце — это дополнительная функция,
  // не основная (см. описание задачи: «трансляция — не основная,
  // должна быть в меню»).
  'broadcast',
];

function groupItems(
  items: AnalysisActionItem[],
): Array<{ group: AnalysisActionGroup; items: AnalysisActionItem[] }> {
  const visible = items.filter((it) => it.visible !== false);
  return GROUP_ORDER.map((group) => ({
    group,
    items: visible.filter((it) => it.group === group),
  })).filter((g) => g.items.length > 0);
}

function MenuButton({
  item,
  onClose,
  variant,
}: {
  item: AnalysisActionItem;
  onClose: () => void;
  variant: 'dropdown' | 'sheet';
}) {
  return (
    <button
      type="button"
      className={`analysis-actions-menu__item analysis-actions-menu__item--${variant}`}
      data-testid={`analysis-actions-item-${item.id}`}
      data-group={item.group}
      data-disabled={item.disabled ? 'true' : 'false'}
      disabled={item.disabled}
      title={item.disabled ? item.disabledHint : undefined}
      onClick={() => {
        if (item.disabled) return;
        item.onClick();
        onClose();
      }}
    >
      {item.label}
    </button>
  );
}

export function AnalysisActionsMenu({
  open,
  onClose,
  items,
  mode = 'auto',
  // KS-3908: пока не используется внутри (C03 подключит), пробрасываем
  // через пропсы чтобы зафиксировать API.
  studentToolsPolicy: _studentToolsPolicy,
}: AnalysisActionsMenuProps) {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const resolvedMode: 'dropdown' | 'sheet' =
    mode === 'auto' ? (isMobile ? 'sheet' : 'dropdown') : mode;

  // Esc → close. Стандарт для обоих режимов.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const grouped = groupItems(items);

  // KS-3431: останавливаем подъём mousedown/click из корня меню. Caller
  // AnalysisPage слушает `document.mousedown` для click-outside и
  // закрывает overflow по target вне `overflowMenuRef`. После KS-3428
  // sheet рендерится через портал в `document.body` — target вне ref,
  // и parent-handler закрывает меню РАНЬШЕ, чем React успевает
  // обработать onClick кнопки items: button unmount → onClick теряется.
  // `stopPropagation` на mousedown изолирует поведение компонента;
  // backdrop и Esc внутри компонента продолжают работать как было.
  const stopBubble = (e: { stopPropagation: () => void }) => e.stopPropagation();

  if (resolvedMode === 'dropdown') {
    return (
      <div
        className="analysis-actions-menu analysis-actions-menu--dropdown"
        data-testid="analysis-actions-menu"
        data-mode="dropdown"
        role="menu"
        onMouseDown={stopBubble}
        onClick={stopBubble}
      >
        {grouped.map((g, gi) => (
          <div
            key={g.group}
            className="analysis-actions-menu__group"
            data-testid={`analysis-actions-group-${g.group}`}
            data-group-index={gi}
          >
            {g.items.map((it) => (
              <MenuButton
                key={it.id}
                item={it}
                onClose={onClose}
                variant="dropdown"
              />
            ))}
          </div>
        ))}
      </div>
    );
  }

  // sheet — bottom-sheet по паттерну ADR-076/080.
  // KS-3428: рендерим через портал в document.body. Раньше sheet
  // монтировался внутрь `.analysis-overflow-wrapper` (inline-block,
  // ~32px широкий — обёртка кнопки ⋯). В некоторых браузерах parent
  // создаёт containing-block для `position:fixed` (transform/filter
  // на промежуточных предках), и панель получала ширину обёртки —
  // «треть экрана» из бага. Portal в body выводит fixed-оверлей за
  // пределы любого containing-block — panel занимает viewport.
  const sheet = (
    <div
      className="analysis-actions-menu analysis-actions-menu--sheet"
      data-testid="analysis-actions-menu"
      data-mode="sheet"
      role="dialog"
      aria-modal="true"
      aria-label={t('analysis.actionsMenu.title', 'Actions')}
      onMouseDown={stopBubble}
      onClick={stopBubble}
    >
      <button
        type="button"
        className="analysis-actions-menu__backdrop"
        data-testid="analysis-actions-menu-backdrop"
        onClick={onClose}
        aria-label={t('common.close', 'Close')}
      />
      <div className="analysis-actions-menu__panel">
        <header className="analysis-actions-menu__header">
          <h2 className="analysis-actions-menu__title">
            {t('analysis.actionsMenu.title', 'Actions')}
          </h2>
          <button
            type="button"
            className="analysis-actions-menu__close"
            data-testid="analysis-actions-menu-close"
            onClick={onClose}
            aria-label={t('common.close', 'Close')}
          >
            ×
          </button>
        </header>
        <div
          className="analysis-actions-menu__body"
          data-testid="analysis-actions-menu-body"
        >
          {grouped.map((g, gi) => (
            <section
              key={g.group}
              className="analysis-actions-menu__group"
              data-testid={`analysis-actions-group-${g.group}`}
              data-group-index={gi}
            >
              {g.items.map((it) => (
                <MenuButton
                  key={it.id}
                  item={it}
                  onClose={onClose}
                  variant="sheet"
                />
              ))}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
  if (typeof document === 'undefined') return sheet;
  return createPortal(sheet, document.body);
}
