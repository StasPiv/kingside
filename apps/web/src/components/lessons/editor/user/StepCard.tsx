import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type {
  StepPayload,
  UserLessonStepDto,
  UserStepType,
} from '@kingside/shared';

import type { AutoSaveStatus } from '../../../../hooks/useAutoSave';
import { StepRenderer } from '../../StepRenderer';
import {
  EndgameDrillFields,
  PuzzleFields,
  TextFields,
} from '../fields';

/**
 * `StepCard` — компактная карточка шага в user-редакторе курса
 * (KS-1848 §3.5, KS-1852 / FE-R4). Собирает в одном месте:
 *
 *  - Заголовок: drag-handle `⠿` + иконка типа + локализованный label
 *    + превью контента (первые N символов) + цветной status-dot +
 *    шеврон раскрытия + меню `[⋯]` с `duplicate` / `delete`.
 *  - Body (аккордеон): соответствующий `*Fields` компонент (TextFields /
 *    PuzzleFields / EndgameDrillFields) + toggle-превью, показывающий
 *    настоящий `StepRenderer` с тем же payload.
 *
 * # Почему status-dot здесь, а не в родителе
 *
 * Каждый шаг имеет свой автосохранённый scope — при быстром редактировании
 * разных полей разных шагов полезно видеть, какой именно шаг сейчас
 * «saving». `status` передаётся prop'ом (родитель держит `useAutoSave`
 * на каждый шаг или глобально + маппинг). Компонент — чисто презентационный.
 *
 * # Whitelist типов (ADR-026 §2.3)
 *
 * Поддерживаются только 3 типа user-курсов: `text`, `puzzle`,
 * `endgame_drill`. Если придёт шаг с другим типом (например из бекапа
 * админского курса) — показывается плашка «unsupported type», чтобы
 * редактор не падал.
 */

interface StepCardProps {
  step: UserLessonStepDto;
  /** Индекс для заголовка («Шаг N»). */
  index: number;
  /** Статус автосохранения именно этого шага. */
  saveStatus?: AutoSaveStatus;
  /** Раскрыт ли аккордеон (controlled). */
  expanded: boolean;
  onToggleExpand: () => void;
  onPayloadChange: (nextPayload: StepPayload) => void;
  onDelete: () => void;
  onDuplicate: () => void;
  /** Опциональный drag-handle (FE-R8 подключит dnd). */
  dragHandleProps?: Record<string, unknown>;
  /**
   * FE-R8: props для drop-зоны на root-элементе карточки (onDragOver /
   * onDragLeave / onDrop). Передаются родителем из `useReorderDnD`.
   */
  dropProps?: {
    onDragOver?: (e: React.DragEvent) => void;
    onDragLeave?: () => void;
    onDrop?: (e: React.DragEvent) => void;
  };
  /**
   * FE-R8: опц. keyboardProps для drag-handle (tabIndex/role/aria-grabbed/
   * onKeyDown). Если не задан — handle работает только через mouse-dnd.
   */
  handleKeyboardProps?: Record<string, unknown>;
}

const TYPE_ICONS: Record<UserStepType, string> = {
  text: '📝',
  puzzle: '♟️',
  endgame_drill: '⚔️',
};

const TYPE_LABEL_KEY: Record<UserStepType, string> = {
  text: 'lessons.my.stepType.text',
  puzzle: 'lessons.my.stepType.puzzle',
  endgame_drill: 'lessons.my.stepType.endgameDrill',
};

/** Длина превью текста заголовка. */
const PREVIEW_CHARS = 60;

function isUserStepType(type: string): type is UserStepType {
  return type === 'text' || type === 'puzzle' || type === 'endgame_drill';
}

function payloadPreview(payload: StepPayload): string {
  if (payload.type === 'text') {
    const raw = (payload.bodyMarkdown ?? '').trim();
    if (!raw) return '';
    // Убираем markdown-мусор (`#`, `*`, `{{diagram:N}}`) для читабельного
    // превью в заголовке; это не рендерер — просто короткий тизер.
    const cleaned = raw
      .replace(/\{\{diagram:\d+\}\}/g, '')
      .replace(/^#+\s+/gm, '')
      .replace(/[*_`]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    return cleaned.length > PREVIEW_CHARS
      ? `${cleaned.slice(0, PREVIEW_CHARS)}…`
      : cleaned;
  }
  if (payload.type === 'puzzle') {
    if (payload.selection.mode === 'ids') {
      const n = payload.selection.puzzleIds.length;
      return n === 0 ? '' : `${n} ID`;
    }
    const themes = payload.selection.themes.join(', ');
    return themes || '';
  }
  if (payload.type === 'endgame_drill') {
    const fen = payload.fen.split(' ')[0] ?? '';
    return fen.length > PREVIEW_CHARS
      ? `${fen.slice(0, PREVIEW_CHARS)}…`
      : fen;
  }
  return '';
}

export function StepCard({
  step,
  index,
  saveStatus = 'idle',
  expanded,
  onToggleExpand,
  onPayloadChange,
  onDelete,
  onDuplicate,
  dragHandleProps,
  dropProps,
  handleKeyboardProps,
}: StepCardProps) {
  const { t } = useTranslation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [menuPos, setMenuPos] = useState<{
    top: number;
    right: number;
  } | null>(null);

  /**
   * KS-1861-FIX: StepCard живёт внутри `<SortableItem>` из
   * `@dnd-kit/sortable`. Drag-handle ⠿ получает activator-listeners
   * от TouchSensor'а; на iOS/Android long-press по любому потомку
   * sortable-`<li>` интерпретировался браузером как начало
   * pointer-interaction и блокировал синтетический `click` на
   * вложенных кнопках (меню `⋯`, chevron, preview-toggle).
   *
   * dnd-kit регистрирует pointer-listener'ы напрямую через
   * `addEventListener` (не через React) — synthetic
   * `e.stopPropagation()` их не остановит. Используем
   * `e.nativeEvent.stopPropagation()` чтобы native bubbling
   * не дошёл ни до handle activator, ни до document-level
   * перехватчиков dnd-kit.
   */
  const stopPointerPropagation = useCallback(
    (e: React.PointerEvent) => {
      e.stopPropagation();
      e.nativeEvent.stopPropagation();
    },
    [],
  );

  /**
   * KS-1872: меню рендерим в портал на `document.body`. У `.step-card`
   * установлен `overflow: hidden` (нужен для скруглённого `__body`
   * внутри card), и `__menu` с `position: absolute; top: 100%`
   * выходил за границу карточки — в DOM он был, но клиппился родителем
   * и был не виден пользователю. Portal + `position: fixed` обходят
   * `overflow: hidden` независимо от вложенности.
   *
   * Координаты — viewport-relative от `triggerRef.getBoundingClientRect`,
   * пересчёт при каждом open. `useLayoutEffect` чтобы избежать flash
   * на нулевых координатах в момент первого рендера.
   */
  useLayoutEffect(() => {
    if (!menuOpen) {
      setMenuPos(null);
      return;
    }
    const el = triggerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setMenuPos({
      top: rect.bottom + 4,
      right: window.innerWidth - rect.right,
    });
  }, [menuOpen]);

  /**
   * KS-1872: click-outside для портального popover'а. В обычном CSS-
   * варианте меню исчезало при повторном tap'е по trigger (toggle);
   * после переноса в портал нужен явный outside-click handler — иначе
   * меню висело бы поверх всей страницы пока пользователь снова не
   * нажмёт на trigger.
   */
  useEffect(() => {
    if (!menuOpen) return;
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (menuRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      setMenuOpen(false);
    };
    // capture-phase, чтобы перехватить клик до того как dnd-kit или
    // другие компоненты возможно `stopPropagation`-нут его.
    document.addEventListener('mousedown', onDocClick, true);
    document.addEventListener('touchstart', onDocClick, true);
    return () => {
      document.removeEventListener('mousedown', onDocClick, true);
      document.removeEventListener('touchstart', onDocClick, true);
    };
  }, [menuOpen]);

  const isSupported = isUserStepType(step.type);
  const icon = isSupported ? TYPE_ICONS[step.type] : '❓';
  const typeLabel = isSupported
    ? t(TYPE_LABEL_KEY[step.type], step.type)
    : step.type;
  const preview = useMemo(() => payloadPreview(step.payload), [step.payload]);

  const syntheticRendererStep = useMemo(
    () => ({
      id: `preview-${step.id}`,
      lessonId: step.userLessonId,
      order: step.order,
      type: step.type,
      payload: step.payload,
    }),
    [step],
  );

  return (
    <div
      className={`step-card${expanded ? ' step-card--expanded' : ''}`}
      data-testid={`step-card-${step.id}`}
      data-step-type={step.type}
      data-expanded={expanded ? 'true' : 'false'}
      onDragOver={dropProps?.onDragOver}
      onDragLeave={dropProps?.onDragLeave}
      onDrop={dropProps?.onDrop}
    >
      <header className="step-card__header">
        <button
          type="button"
          className="step-card__drag-handle"
          data-testid={`step-card-drag-${step.id}`}
          aria-label={t('editor.moveUp', 'Move up')}
          {...dragHandleProps}
          {...handleKeyboardProps}
        >
          ⠿
        </button>
        <span className="step-card__icon" aria-hidden="true">
          {icon}
        </span>
        <div className="step-card__title-group">
          <span className="step-card__order">#{index + 1}</span>
          <span className="step-card__type-label">{typeLabel}</span>
          {preview && (
            <span
              className="step-card__preview"
              data-testid={`step-card-preview-${step.id}`}
            >
              {preview}
            </span>
          )}
        </div>
        <span
          className={`step-card__status-dot step-card__status-dot--${saveStatus}`}
          data-testid={`step-card-status-${step.id}`}
          data-status={saveStatus}
          aria-label={saveStatus}
        />
        <button
          type="button"
          ref={triggerRef}
          className="step-card__menu-trigger"
          data-testid={`step-card-menu-trigger-${step.id}`}
          onClick={() => setMenuOpen((v) => !v)}
          onPointerDown={stopPointerPropagation}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label={t('editor.step.menu', 'Step actions')}
        >
          ⋯
        </button>
        {menuOpen &&
          menuPos &&
          createPortal(
            <div
              ref={menuRef}
              className="step-card__menu step-card__menu--portal"
              role="menu"
              data-testid={`step-card-menu-${step.id}`}
              style={{
                position: 'fixed',
                top: menuPos.top,
                right: menuPos.right,
              }}
            >
              <button
                type="button"
                role="menuitem"
                data-testid={`step-card-menu-duplicate-${step.id}`}
                onClick={() => {
                  setMenuOpen(false);
                  onDuplicate();
                }}
                onPointerDown={stopPointerPropagation}
              >
                {t('editor.step.duplicate', 'Duplicate')}
              </button>
              <button
                type="button"
                role="menuitem"
                className="step-card__menu-delete"
                data-testid={`step-card-menu-delete-${step.id}`}
                onClick={() => {
                  setMenuOpen(false);
                  onDelete();
                }}
                onPointerDown={stopPointerPropagation}
              >
                {t('editor.remove', 'Remove')}
              </button>
            </div>,
            document.body,
          )}
        <button
          type="button"
          className="step-card__chevron"
          data-testid={`step-card-chevron-${step.id}`}
          onClick={onToggleExpand}
          onPointerDown={stopPointerPropagation}
          aria-expanded={expanded}
          aria-label={t('editor.preview', 'Preview')}
        >
          {expanded ? '▾' : '▸'}
        </button>
      </header>

      {expanded && (
        <div
          className="step-card__body"
          data-testid={`step-card-body-${step.id}`}
        >
          {step.payload.type === 'text' && (
            <TextFields payload={step.payload} onChange={onPayloadChange} />
          )}
          {step.payload.type === 'puzzle' && (
            <PuzzleFields payload={step.payload} onChange={onPayloadChange} />
          )}
          {step.payload.type === 'endgame_drill' && (
            <EndgameDrillFields
              payload={step.payload}
              onChange={onPayloadChange}
            />
          )}
          {!isSupported && (
            <p
              className="step-card__unsupported"
              data-testid={`step-card-unsupported-${step.id}`}
            >
              {t(
                'lessons.my.editor.unsupportedStep',
                'This step type is not editable in user courses yet.',
              )}
            </p>
          )}

          <div className="step-card__preview-toggle">
            <button
              type="button"
              onClick={() => setPreviewOpen((v) => !v)}
              onPointerDown={stopPointerPropagation}
              data-testid={`step-card-preview-toggle-${step.id}`}
              aria-expanded={previewOpen}
            >
              {previewOpen
                ? t('editor.hidePreview', 'Hide preview')
                : t('editor.preview', 'Preview')}
            </button>
          </div>
          {previewOpen && (
            <div
              className="step-card__preview-body"
              data-testid={`step-card-preview-body-${step.id}`}
            >
              <StepRenderer step={syntheticRendererStep} hideNext />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
