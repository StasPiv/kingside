/**
 * KS-2924 / KS-2932 Phase B2 — общий компонент `SavedFiltersDropdown`.
 *
 * Generic dropdown поверх `useSavedFilters` (KS-2931). Работает для
 * обеих секций (`workshop` / `archive`); страница передаёт `section`,
 * текущий снапшот фильтра `currentParams`, опциональный `activeFilterId`
 * (для подсветки галочкой), и колбэк `onApply` — фактическое применение
 * пресета (URL/state — забота родителя).
 *
 * Поведение / Acceptance (см. KS-2932):
 *   - Тогл: «Saved filters (N) ▾», при N=0 — «Save filter».
 *   - Popover с поиском по name, прокручиваемым списком, kebab-меню
 *     (Rename / Update from current / Delete), inline-вводом нового
 *     имени и пустым состоянием.
 *   - 409 (`duplicate_name`) → inline-подсказка под полем name
 *     (save или rename). 400 (`limit_reached`) → toast.
 *   - A11y: focus-trap внутри popover (Tab/Shift+Tab циклически),
 *     Esc закрывает (каскад: rename → save → kebab → popover),
 *     при закрытии фокус возвращается на тогл.
 *   - i18n — все строки через `t('saved_filters.*')` без дефолтов:
 *     ресурсы en/ru залиты в `translation.json` в KS-2939 (C4).
 *
 * Контракт DOM/классов — согласован с @layout (KS-2934), см.
 * `SavedFiltersDropdown.css` (заглушка) и обсуждение в KS-2934.
 *
 * Что НЕ делается тут (по решению координатора):
 *   - подсветка «modified» при ручном изменении после apply — отложено;
 *   - drag-and-drop порядка пресетов.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import type {
  SavedFilterDto,
  SavedFilterParams,
  SavedFilterSection,
} from '@kingside/shared';
import {
  SavedFiltersError,
  useSavedFilters,
} from '../../hooks/useSavedFilters';
import './SavedFiltersDropdown.css';

/** Должно совпадать с MAX_FILTERS_PER_SECTION на backend (KS-2927). */
const MAX_FILTERS_PER_SECTION = 20;

/** Длительность auto-dismiss всплывающего toast'а (мс). */
const TOAST_DURATION_MS = 3000;

/**
 * KS-2942 — 3-state индикация активного пресета:
 *   - 'active'   — `currentParams` ровно совпадают с пресетом X,
 *                  отображаем чекмарк, никаких отметок «modified»;
 *   - 'modified' — пресет X был применён ранее (URL содержит
 *                  `?savedFilter=<id>`), но текущие фильтры уже не
 *                  совпадают: чекмарк заменяется индикатором «изменён»,
 *                  на toggle добавляется точка, в kebab появляется
 *                  «Reset to saved» (применить params пресета заново).
 *   - `null` — ни один пресет не совпал и нет «модифицированного» hint'а.
 */
export interface ActiveSavedFilterState {
  id: string;
  state: 'active' | 'modified';
}

export interface SavedFiltersDropdownProps<T extends SavedFilterParams> {
  section: SavedFilterSection;
  /** Снапшот текущих фильтров — используется для «Save» и «Update». */
  currentParams: T;
  /**
   * Применить пресет: родитель пишет в URL/state. Второй аргумент
   * (`presetId`) передаётся для KS-2942 — родитель сохраняет hint
   * `?savedFilter=<id>` в URL, чтобы детектить «modified» состояние
   * после ручного изменения фильтра.
   */
  onApply: (params: T, presetId?: string) => void;
  /**
   * KS-2942: 3-state индикация. `null` — нет активного пресета.
   * Передаётся родителем после вычисления через свой matcher
   * (см. `findMatchingFilter` в `ArchiveGamesPage`).
   */
  activeFilter?: ActiveSavedFilterState | null;
  /**
   * KS-2937 (C2): уведомляет родителя об актуальном списке пресетов
   * (после загрузки/мутации). Нужно, чтобы страница могла сама
   * вычислять `activeFilter` через свой matcher, не дублируя GET-запрос.
   * Не передавать, если активный пресет считается извне иначе или не
   * считается вовсе.
   */
  onFiltersChange?: (filters: SavedFilterDto[]) => void;
  /**
   * KS-2944: гость или авторизованный. Если `true` — хук работает в
   * LS-режиме (CRUD без сети, лимит 20, уникальность имени). По
   * умолчанию `false` (auth-режим) — обратная совместимость с
   * существующими тестами и страницами, передающими DI явно.
   * Страницы-родители вычисляют через `useAuth()` и пробрасывают сюда.
   */
  isGuest?: boolean;
}

interface ToastState {
  tone: 'error' | 'success';
  message: string;
}

/**
 * Собирает фокусируемые элементы внутри popover'а для focus-trap.
 * Список селекторов покрывает буттоны/инпуты/линки; отключённые
 * элементы (disabled, tabindex="-1") исключены.
 */
function getFocusable(root: HTMLElement): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      [
        'button:not([disabled])',
        'input:not([disabled])',
        'a[href]',
        '[tabindex]:not([tabindex="-1"])',
      ].join(','),
    ),
  );
}

export function SavedFiltersDropdown<
  T extends SavedFilterParams = SavedFilterParams,
>(props: SavedFiltersDropdownProps<T>) {
  const {
    section,
    currentParams,
    onApply,
    activeFilter = null,
    onFiltersChange,
    isGuest = false,
  } = props;
  const { t } = useTranslation();
  const { filters, loading, error, isGuestMode, create, rename, update, remove } =
    useSavedFilters<T>(section, { isGuest });

  // KS-2937 (C2): пробрасываем filters наверх, чтобы родитель мог
  // считать `activeFilterId` без второго инстанса useSavedFilters.
  // Не зовём при первом render'e с пустым массивом — это значение
  // совпадает с initial state хука, поэтому effect отработает один
  // раз и далее на каждое обновление.
  useEffect(() => {
    onFiltersChange?.(filters);
  }, [filters, onFiltersChange]);

  // UI state
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const [savingMode, setSavingMode] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [saveError, setSaveError] = useState<'duplicate_name' | null>(null);
  const [savePending, setSavePending] = useState(false);

  const [kebabOpenId, setKebabOpenId] = useState<string | null>(null);

  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameName, setRenameName] = useState('');
  const [renameError, setRenameError] = useState<'duplicate_name' | null>(
    null,
  );
  const [renamePending, setRenamePending] = useState(false);

  const [toast, setToast] = useState<ToastState | null>(null);

  // Refs
  const rootRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const saveInputRef = useRef<HTMLInputElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);

  /** Показать toast с авто-скрытием. */
  const showToast = useCallback(
    (tone: ToastState['tone'], message: string) => {
      setToast({ tone, message });
      window.setTimeout(() => {
        setToast((cur) =>
          cur && cur.message === message ? null : cur,
        );
      }, TOAST_DURATION_MS);
    },
    [],
  );

  /** Сбросить все саб-состояния и закрыть popover, фокус → тогл. */
  const closePopover = useCallback(() => {
    setOpen(false);
    setSavingMode(false);
    setSaveName('');
    setSaveError(null);
    setKebabOpenId(null);
    setRenameId(null);
    setRenameName('');
    setRenameError(null);
    setQuery('');
    // Возврат фокуса — после unmount popover'а.
    window.setTimeout(() => {
      toggleRef.current?.focus();
    }, 0);
  }, []);

  const handleToggleClick = useCallback(() => {
    if (open) {
      closePopover();
      return;
    }
    setOpen(true);
    // KS-2932 §1: при N=0 текст тогла «Save filter» — пользователь
    // ожидает сразу попасть в форму ввода имени, а не в пустой список.
    if (filters.length === 0) {
      setSavingMode(true);
    }
  }, [open, closePopover, filters.length]);

  // Click outside → close
  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (target && rootRef.current && !rootRef.current.contains(target)) {
        closePopover();
      }
    };
    window.addEventListener('mousedown', onMouseDown);
    return () => window.removeEventListener('mousedown', onMouseDown);
  }, [open, closePopover]);

  // Auto-focus при открытии popover'а: search-input.
  useEffect(() => {
    if (!open) return;
    // Без rAF — popover уже в DOM на этапе useEffect.
    searchInputRef.current?.focus();
  }, [open]);

  // Auto-focus при входе в save-mode.
  useEffect(() => {
    if (!savingMode) return;
    saveInputRef.current?.focus();
    saveInputRef.current?.select();
  }, [savingMode]);

  // Auto-focus при входе в rename-mode.
  useEffect(() => {
    if (renameId === null) return;
    renameInputRef.current?.focus();
    renameInputRef.current?.select();
  }, [renameId]);

  // Esc + Tab focus-trap. Слушаем на window, фильтруем по `open`.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        // Каскад: rename → save → kebab → popover.
        if (renameId !== null) {
          setRenameId(null);
          setRenameName('');
          setRenameError(null);
          return;
        }
        if (savingMode) {
          setSavingMode(false);
          setSaveName('');
          setSaveError(null);
          return;
        }
        if (kebabOpenId !== null) {
          setKebabOpenId(null);
          return;
        }
        closePopover();
        return;
      }
      if (e.key === 'Tab' && popoverRef.current) {
        const focusables = getFocusable(popoverRef.current);
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement as HTMLElement | null;
        const insidePopover =
          active !== null && popoverRef.current.contains(active);
        if (e.shiftKey) {
          if (!insidePopover || active === first) {
            e.preventDefault();
            last.focus();
          }
        } else {
          if (!insidePopover || active === last) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, savingMode, kebabOpenId, renameId, closePopover]);

  // Фильтрация по поиску (clientside, по name).
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return filters;
    return filters.filter((f) => f.name.toLowerCase().includes(q));
  }, [filters, query]);

  // === Save current ===
  const handleSaveSubmit = useCallback(async () => {
    const name = saveName.trim();
    if (!name || savePending) return;
    setSavePending(true);
    setSaveError(null);
    try {
      await create(name, currentParams);
      setSavingMode(false);
      setSaveName('');
    } catch (e) {
      if (e instanceof SavedFiltersError) {
        if (e.code === 'duplicate_name') {
          setSaveError('duplicate_name');
        } else if (e.code === 'limit_reached') {
          showToast(
            'error',
            t('saved_filters.errorLimitReached', {
              max: MAX_FILTERS_PER_SECTION,
            }),
          );
        }
      } else {
        showToast('error', t('saved_filters.saveError'));
      }
    } finally {
      setSavePending(false);
    }
  }, [saveName, savePending, create, currentParams, showToast, t]);

  // === Rename ===
  const handleRenameSubmit = useCallback(async () => {
    if (renameId === null) return;
    const name = renameName.trim();
    if (!name || renamePending) return;
    setRenamePending(true);
    setRenameError(null);
    try {
      await rename(renameId, name);
      setRenameId(null);
      setRenameName('');
    } catch (e) {
      if (e instanceof SavedFiltersError && e.code === 'duplicate_name') {
        setRenameError('duplicate_name');
      } else {
        showToast('error', t('saved_filters.renameError'));
      }
    } finally {
      setRenamePending(false);
    }
  }, [renameId, renameName, renamePending, rename, showToast, t]);

  // === Apply pre-set ===
  const handleApply = useCallback(
    (f: SavedFilterDto) => {
      // KS-2942: presetId передаётся, чтобы родитель добавил
      // `?savedFilter=<id>` в URL и мог детектить «modified» после
      // ручного изменения фильтра.
      onApply(f.params as T, f.id);
      closePopover();
    },
    [onApply, closePopover],
  );

  /**
   * KS-2942: «Reset to saved» — пункт kebab'а, видимый только если
   * `activeFilter.state === 'modified'` И `f.id === activeFilter.id`.
   * Применяет params пресета без изменений — currentParams снова
   * совпадают, state переключается обратно в 'active'.
   */
  const handleResetToSaved = useCallback(
    (f: SavedFilterDto) => {
      setKebabOpenId(null);
      onApply(f.params as T, f.id);
      closePopover();
    },
    [onApply, closePopover],
  );

  // === Update from current ===
  const handleUpdate = useCallback(
    async (id: string) => {
      setKebabOpenId(null);
      try {
        await update(id, currentParams);
        showToast('success', t('saved_filters.updateSuccess'));
      } catch {
        showToast('error', t('saved_filters.updateError'));
      }
    },
    [update, currentParams, showToast, t],
  );

  // === Delete ===
  const handleDelete = useCallback(
    async (f: SavedFilterDto) => {
      setKebabOpenId(null);
      const confirmed = window.confirm(
        t('saved_filters.confirmDelete', { name: f.name }),
      );
      if (!confirmed) return;
      try {
        await remove(f.id);
      } catch {
        showToast('error', t('saved_filters.deleteError'));
      }
    },
    [remove, showToast, t],
  );

  const toggleLabel =
    filters.length === 0
      ? t('saved_filters.toggleEmpty')
      : t('saved_filters.toggleWithCount', { count: filters.length });

  // KS-2942: 3-state — 'active' | 'modified' | 'none'. Атрибут на root
  // используется в CSS для подсветки и в тестах для проверки состояния
  // без зависимости от layout-классов.
  const activeStateValue: 'active' | 'modified' | 'none' =
    activeFilter?.state ?? 'none';

  return (
    <div
      className="saved-filters-dropdown"
      data-testid="saved-filters-dropdown"
      data-state={open ? 'open' : 'closed'}
      data-active-state={activeStateValue}
      ref={rootRef}
    >
      <button
        type="button"
        ref={toggleRef}
        className={`saved-filters-dropdown__toggle${
          activeStateValue === 'modified'
            ? ' saved-filters-dropdown__toggle--modified'
            : ''
        }`}
        data-testid="saved-filters-toggle"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={handleToggleClick}
      >
        <span className="saved-filters-dropdown__toggle-label">
          {toggleLabel}
        </span>
        {activeStateValue === 'modified' && (
          <span
            className="saved-filters-dropdown__toggle-indicator"
            data-testid="saved-filters-toggle-modified"
            aria-hidden
          >
            ●
          </span>
        )}
      </button>

      {open && (
        <div
          ref={popoverRef}
          className="saved-filters-dropdown__popover"
          role="dialog"
          aria-label={t('saved_filters.popoverAriaLabel')}
          data-testid="saved-filters-popover"
        >
          <input
            ref={searchInputRef}
            type="text"
            className="saved-filters-dropdown__search"
            data-testid="saved-filters-search"
            placeholder={t('saved_filters.searchPlaceholder')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />

          <div className="saved-filters-dropdown__save-row">
            {savingMode ? (
              <form
                className="saved-filters-dropdown__save-form"
                data-testid="saved-filters-save-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  void handleSaveSubmit();
                }}
              >
                <input
                  ref={saveInputRef}
                  type="text"
                  className="saved-filters-dropdown__save-input"
                  data-testid="saved-filters-save-input"
                  value={saveName}
                  placeholder={t('saved_filters.saveInputPlaceholder')}
                  onChange={(e) => {
                    setSaveName(e.target.value);
                    if (saveError) setSaveError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      e.preventDefault();
                      e.stopPropagation();
                      setSavingMode(false);
                      setSaveName('');
                      setSaveError(null);
                    }
                  }}
                  aria-invalid={saveError !== null}
                  aria-describedby={
                    saveError ? 'saved-filters-save-error' : undefined
                  }
                />
                <button
                  type="submit"
                  className="saved-filters-dropdown__save-confirm"
                  data-testid="saved-filters-save-confirm"
                  disabled={!saveName.trim() || savePending}
                >
                  {t('saved_filters.saveConfirm')}
                </button>
                <button
                  type="button"
                  className="saved-filters-dropdown__save-cancel"
                  data-testid="saved-filters-save-cancel"
                  onClick={() => {
                    setSavingMode(false);
                    setSaveName('');
                    setSaveError(null);
                  }}
                >
                  {t('saved_filters.saveCancel')}
                </button>
                {saveError === 'duplicate_name' && (
                  <span
                    id="saved-filters-save-error"
                    className="saved-filters-dropdown__save-error"
                    data-testid="saved-filters-save-error"
                  >
                    {t('saved_filters.errorDuplicateName')}
                  </span>
                )}
              </form>
            ) : (
              <button
                type="button"
                className="saved-filters-dropdown__save-btn"
                data-testid="saved-filters-save-btn"
                onClick={() => setSavingMode(true)}
              >
                {t('saved_filters.saveCurrent')}
              </button>
            )}
          </div>

          {loading ? (
            <div
              className="saved-filters-dropdown__loading"
              data-testid="saved-filters-loading"
            >
              {t('saved_filters.loading')}
            </div>
          ) : error ? (
            <div
              className="saved-filters-dropdown__loading"
              data-testid="saved-filters-load-error"
            >
              {t('saved_filters.loadError')}
            </div>
          ) : filters.length === 0 ? (
            <div
              className="saved-filters-dropdown__empty"
              data-testid="saved-filters-empty"
            >
              {t('saved_filters.empty')}
            </div>
          ) : (
            <ul
              className="saved-filters-dropdown__list"
              role="menu"
              data-testid="saved-filters-list"
            >
              {filtered.map((f) => {
                const isActive =
                  activeFilter?.state === 'active' &&
                  f.id === activeFilter.id;
                const isModified =
                  activeFilter?.state === 'modified' &&
                  f.id === activeFilter.id;
                const isRenaming = renameId === f.id;
                const isKebabOpen = kebabOpenId === f.id;
                const itemClassNames = [
                  'saved-filters-dropdown__item',
                  isActive ? 'saved-filters-dropdown__item--active' : '',
                  isModified ? 'saved-filters-dropdown__item--modified' : '',
                ]
                  .filter(Boolean)
                  .join(' ');
                return (
                  <li
                    key={f.id}
                    className={itemClassNames}
                    data-testid={`saved-filters-item-${f.id}`}
                    data-item-state={
                      isActive ? 'active' : isModified ? 'modified' : 'none'
                    }
                    role="none"
                  >
                    {isRenaming ? (
                      <form
                        className="saved-filters-dropdown__rename-form"
                        data-testid={`saved-filters-rename-form-${f.id}`}
                        onSubmit={(e) => {
                          e.preventDefault();
                          void handleRenameSubmit();
                        }}
                      >
                        <input
                          ref={renameInputRef}
                          type="text"
                          className="saved-filters-dropdown__rename-input"
                          data-testid={`saved-filters-rename-input-${f.id}`}
                          value={renameName}
                          onChange={(e) => {
                            setRenameName(e.target.value);
                            if (renameError) setRenameError(null);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Escape') {
                              e.preventDefault();
                              e.stopPropagation();
                              setRenameId(null);
                              setRenameName('');
                              setRenameError(null);
                            }
                          }}
                          aria-invalid={renameError !== null}
                        />
                        <button
                          type="submit"
                          className="saved-filters-dropdown__rename-confirm"
                          data-testid={`saved-filters-rename-confirm-${f.id}`}
                          disabled={!renameName.trim() || renamePending}
                        >
                          {t('saved_filters.renameConfirm')}
                        </button>
                        <button
                          type="button"
                          className="saved-filters-dropdown__rename-cancel"
                          data-testid={`saved-filters-rename-cancel-${f.id}`}
                          onClick={() => {
                            setRenameId(null);
                            setRenameName('');
                            setRenameError(null);
                          }}
                        >
                          {t('saved_filters.renameCancel')}
                        </button>
                        {renameError === 'duplicate_name' && (
                          <span
                            className="saved-filters-dropdown__rename-error"
                            data-testid={`saved-filters-rename-error-${f.id}`}
                          >
                            {t('saved_filters.errorDuplicateName')}
                          </span>
                        )}
                      </form>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="saved-filters-dropdown__item-name"
                          data-testid={`saved-filters-apply-${f.id}`}
                          role="menuitem"
                          onClick={() => handleApply(f)}
                        >
                          {isActive && (
                            <span
                              className="saved-filters-dropdown__item-check"
                              data-testid={`saved-filters-item-check-${f.id}`}
                              aria-hidden
                            >
                              ✓
                            </span>
                          )}
                          {isModified && (
                            <span
                              className="saved-filters-dropdown__item-modified"
                              data-testid={`saved-filters-item-modified-${f.id}`}
                              aria-hidden
                            >
                              ●
                            </span>
                          )}
                          <span className="saved-filters-dropdown__item-text">
                            {f.name}
                          </span>
                          {isActive && (
                            <span className="sr-only">
                              {t('saved_filters.itemActive')}
                            </span>
                          )}
                          {isModified && (
                            <span className="sr-only">
                              {t('saved_filters.itemModified')}
                            </span>
                          )}
                        </button>
                        <button
                          type="button"
                          className="saved-filters-dropdown__item-kebab"
                          data-testid={`saved-filters-kebab-${f.id}`}
                          aria-label={t('saved_filters.kebabAriaLabel', {
                            name: f.name,
                          })}
                          aria-haspopup="menu"
                          aria-expanded={isKebabOpen}
                          onClick={(e) => {
                            e.stopPropagation();
                            setKebabOpenId((cur) =>
                              cur === f.id ? null : f.id,
                            );
                          }}
                        >
                          ⋮
                        </button>
                        {isKebabOpen && (
                          <div
                            className="saved-filters-dropdown__kebab-menu"
                            role="menu"
                            data-testid={`saved-filters-kebab-menu-${f.id}`}
                          >
                            <button
                              type="button"
                              className="saved-filters-dropdown__kebab-item"
                              data-testid={`saved-filters-kebab-rename-${f.id}`}
                              role="menuitem"
                              onClick={() => {
                                setRenameId(f.id);
                                setRenameName(f.name);
                                setRenameError(null);
                                setKebabOpenId(null);
                              }}
                            >
                              {t('saved_filters.menuRename')}
                            </button>
                            <button
                              type="button"
                              className="saved-filters-dropdown__kebab-item"
                              data-testid={`saved-filters-kebab-update-${f.id}`}
                              role="menuitem"
                              onClick={() => void handleUpdate(f.id)}
                            >
                              {t('saved_filters.menuUpdate')}
                            </button>
                            <button
                              type="button"
                              className="saved-filters-dropdown__kebab-item"
                              data-testid={`saved-filters-kebab-delete-${f.id}`}
                              role="menuitem"
                              onClick={() => void handleDelete(f)}
                            >
                              {t('saved_filters.menuDelete')}
                            </button>
                            {isModified && (
                              <button
                                type="button"
                                className="saved-filters-dropdown__kebab-item saved-filters-dropdown__kebab-item--reset"
                                data-testid={`saved-filters-kebab-reset-${f.id}`}
                                role="menuitem"
                                onClick={() => handleResetToSaved(f)}
                              >
                                {t('saved_filters.menuResetToSaved')}
                              </button>
                            )}
                          </div>
                        )}
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          {isGuestMode && (
            <div
              className="saved-filters-dropdown__guest-note"
              data-testid="saved-filters-guest-note"
            >
              {t('saved_filters.guestNote')}
            </div>
          )}
        </div>
      )}

      {toast && (
        <div
          className={`saved-filters-dropdown__toast saved-filters-dropdown__toast--${toast.tone}`}
          role="status"
          aria-live="polite"
          data-testid="saved-filters-toast"
          data-tone={toast.tone}
        >
          {toast.message}
        </div>
      )}
    </div>
  );
}
