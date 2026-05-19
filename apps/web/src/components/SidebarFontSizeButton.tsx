import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  SIDEBAR_FONT_SIZES,
  useBoardSettings,
} from '../hooks/useBoardSettings';

/**
 * KS-3099 v2: компактная Aa-кнопка для шапки правой панели анализа.
 * При клике раскрывается popover c тремя кнопками S/M/L. Состояние
 * хранится в `BoardSettingsContext.sidebarFontSize` (localStorage
 * `analysisSidebarFontSize`), CSS-переменная
 * `--analysis-sidebar-font-scale` управляет размером шрифта в sidebar.
 *
 * Первая итерация KS-3099 имела две S/M/L группы под доской (board-size
 * + font-size), пользователь попросил один общий контрол. Это «вариант
 * Б» из описания задачи — компактная кнопка с dropdown.
 */
export function SidebarFontSizeButton() {
  const { t } = useTranslation();
  const { sidebarFontSize, setSidebarFontSize } = useBoardSettings();
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  // Закрытие по клику вне.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      const node = wrapperRef.current;
      if (node && e.target instanceof Node && !node.contains(e.target)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  // Закрытие на Esc.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  const handleToggle = useCallback((e: React.MouseEvent) => {
    // Контейнер sidebar-header может перехватывать клик (например,
    // toggle collapse). stopPropagation обязательно.
    e.stopPropagation();
    setOpen((v) => !v);
  }, []);

  const handlePick = useCallback(
    (size: typeof sidebarFontSize) => {
      setSidebarFontSize(size);
      setOpen(false);
    },
    [setSidebarFontSize],
  );

  const label = t('analysis.sidebarFontSize', 'Sidebar font size');

  return (
    <div
      className="sidebar-font-size"
      ref={wrapperRef}
      onClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        className="sidebar-font-size__trigger"
        onClick={handleToggle}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${label}: ${sidebarFontSize.toUpperCase()}`}
        title={label}
        data-testid="sidebar-font-size-button"
      >
        <span className="sidebar-font-size__a" aria-hidden="true">
          A
        </span>
        <span className="sidebar-font-size__a sidebar-font-size__a--small" aria-hidden="true">
          a
        </span>
      </button>
      {open && (
        <div
          className="sidebar-font-size__menu"
          role="menu"
          data-testid="sidebar-font-size-menu"
        >
          {SIDEBAR_FONT_SIZES.map((preset) => (
            <button
              key={preset.id}
              type="button"
              role="menuitemradio"
              aria-checked={sidebarFontSize === preset.id}
              className={`sidebar-font-size__item${
                sidebarFontSize === preset.id ? ' is-active' : ''
              }`}
              onClick={() => handlePick(preset.id)}
              data-testid={`sidebar-font-size-item-${preset.id}`}
            >
              {preset.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
