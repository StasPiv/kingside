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
import { useTranslation } from 'react-i18next';

import { useIsMobile } from '../../hooks/useIsMobile';

export type AnalysisActionGroup =
  | 'gamePosition' // FEN / Game info / Find games
  | 'pgn' // Export / Copy
  | 'training' // Puzzle / Guess / Repertoires
  | 'sharing'; // Share

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
}

const GROUP_ORDER: AnalysisActionGroup[] = [
  'gamePosition',
  'pgn',
  'training',
  'sharing',
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

  if (resolvedMode === 'dropdown') {
    return (
      <div
        className="analysis-actions-menu analysis-actions-menu--dropdown"
        data-testid="analysis-actions-menu"
        data-mode="dropdown"
        role="menu"
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
  return (
    <div
      className="analysis-actions-menu analysis-actions-menu--sheet"
      data-testid="analysis-actions-menu"
      data-mode="sheet"
      role="dialog"
      aria-modal="true"
      aria-label={t('analysis.actionsMenu.title', 'Actions')}
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
}
