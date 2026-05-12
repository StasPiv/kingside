import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { usePointerType } from '../hooks/usePointerType';

/**
 * KS-2840 (ADR-058 §11.1, §11.2, §11.4, §11.7) — двухуровневое меню
 * sidebar'а: hover-поповер для пунктов с подменю.
 *
 * UX-паттерн D (см. ADR §11.2):
 *  - mouse/trackpad (`pointer: fine`) — hover открывает поповер, click
 *    переключает (toggle).
 *  - touch (`pointer: coarse`) — только click-toggle, hover игнорируем
 *    (на touch hover синтетический и навязчивый).
 *  - всегда: Esc закрывает поповер, click outside закрывает.
 *
 * Поповер позиционируется через `position: fixed` относительно
 * parent-button (через `useRef` + `getBoundingClientRect`). При смене
 * scroll/resize позиция пересчитывается — иначе на длинных страницах
 * поповер «уезжает» от кнопки.
 *
 * ARIA:
 *  - parent: `<button aria-haspopup="menu" aria-expanded aria-controls>`.
 *  - popover: `<div role="menu" aria-labelledby>`.
 *  - подпункт: `<a role="menuitem">`.
 *
 * Keyboard:
 *  - Enter/Space на parent → открыть, фокус на первом подпункте.
 *  - Esc в поповере → закрыть, фокус на parent.
 *  - ↓/↑ в поповере → перейти между подпунктами.
 *  - Tab в поповере → закрыть и перейти к следующему элементу sidebar.
 *
 * **Mobile** (родитель решает через `useIsMobile`): не используем —
 * там `Sidebar` рендерит обычный `<Link>` на лобби-страницу `/train`
 * / `/analyze` без поповера.
 */

export interface SidebarSubmenuItem {
  /** Уникальный id для ARIA / тестов. */
  id: string;
  /** Маршрут подпункта. */
  to: string;
  /** Префиксы URL для active-highlight (см. KS-2842). */
  match: string[];
  icon: string;
  /** i18n-ключ метки. */
  labelKey: string;
  /** Fallback-текст метки. */
  labelFallback: string;
}

interface SidebarSubmenuProps {
  /** Уникальный id для ARIA (`aria-controls`, `aria-labelledby`). */
  id: string;
  /** Иконка parent-кнопки (emoji). */
  icon: string;
  /** i18n-ключ заголовка parent-кнопки. */
  titleKey: string;
  /** Fallback parent-кнопки. */
  titleFallback: string;
  /** Подпункты. */
  items: SidebarSubmenuItem[];
  /**
   * Активен ли в данный момент parent-пункт (один из подмаршрутов
   * соответствует текущему URL). Управляется родителем (Sidebar) через
   * существующий `isActive(path, match)`.
   */
  active: boolean;
  /**
   * Когда какой-либо submenu в Sidebar получает фокус/открывается —
   * остальные должны закрыться. Родитель передаёт коллбек, который
   * закроет все остальные через общий state.
   */
  isOpen: boolean;
  onOpen: () => void;
  onClose: () => void;
}

/** Задержка перед закрытием по mouseleave — защита от диагонального движения курсора. */
const CLOSE_DELAY_MS = 100;

export function SidebarSubmenu(props: SidebarSubmenuProps) {
  const { t } = useTranslation();
  const pointerType = usePointerType();
  const location = useLocation();

  const parentRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const itemRefs = useRef<Array<HTMLAnchorElement | null>>([]);

  const [popoverTop, setPopoverTop] = useState(0);
  const [popoverLeft, setPopoverLeft] = useState(0);

  const { id, items, active, isOpen, onOpen, onClose } = props;
  const isFine = pointerType === 'fine';
  const popoverId = `${id}-popover`;
  const parentId = `${id}-parent`;

  const clearCloseTimer = () => {
    if (closeTimerRef.current !== null) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  };

  const scheduleClose = useCallback(() => {
    clearCloseTimer();
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = null;
      onClose();
    }, CLOSE_DELAY_MS);
  }, [onClose]);

  // Пересчёт позиции поповера: при открытии и при scroll/resize.
  const recomputePosition = useCallback(() => {
    const el = parentRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPopoverTop(rect.top);
    setPopoverLeft(rect.right);
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    recomputePosition();
    const handler = () => recomputePosition();
    window.addEventListener('scroll', handler, true);
    window.addEventListener('resize', handler);
    return () => {
      window.removeEventListener('scroll', handler, true);
      window.removeEventListener('resize', handler);
    };
  }, [isOpen, recomputePosition]);

  // Закрытие при клике вне поповера и parent'а.
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: globalThis.MouseEvent) => {
      const target = e.target as Node;
      if (parentRef.current?.contains(target)) return;
      if (popoverRef.current?.contains(target)) return;
      onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [isOpen, onClose]);

  // Esc — закрытие из любого фокуса в поповере. Фокус возвращается на parent.
  // (Сами стрелки/Tab обрабатываются ниже на нодах.)
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        parentRef.current?.focus();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [isOpen, onClose]);

  // Cleanup таймера на unmount.
  useEffect(() => clearCloseTimer, []);

  // Автофокус на первом подпункте при открытии через клавиатуру.
  // KS-2840: для consistency делаем это всегда — это безопасно (фокус
  // выходит, когда пользователь кликнет в поповере или мышью по subitem'у).
  // Если изначально открыли мышью (mouseenter) — не перехватываем фокус,
  // чтобы не сбить контекст.
  const focusFirstItemRef = useRef(false);
  useEffect(() => {
    if (isOpen && focusFirstItemRef.current) {
      itemRefs.current[0]?.focus();
      focusFirstItemRef.current = false;
    }
  }, [isOpen]);

  const handleParentClick = () => {
    if (isOpen) {
      onClose();
    } else {
      onOpen();
    }
  };

  const handleParentMouseEnter = () => {
    if (!isFine) return;
    clearCloseTimer();
    if (!isOpen) onOpen();
  };

  const handleParentMouseLeave = () => {
    if (!isFine) return;
    scheduleClose();
  };

  const handlePopoverMouseEnter = () => {
    if (!isFine) return;
    clearCloseTimer();
  };

  const handlePopoverMouseLeave = () => {
    if (!isFine) return;
    scheduleClose();
  };

  const handleParentKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      focusFirstItemRef.current = true;
      if (!isOpen) onOpen();
      else itemRefs.current[0]?.focus();
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      focusFirstItemRef.current = true;
      if (!isOpen) onOpen();
      else itemRefs.current[0]?.focus();
    }
  };

  const handleItemKeyDown =
    (idx: number) => (e: KeyboardEvent<HTMLAnchorElement>) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        const next = itemRefs.current[idx + 1] ?? itemRefs.current[0];
        next?.focus();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        const prev =
          itemRefs.current[idx - 1] ??
          itemRefs.current[itemRefs.current.length - 1];
        prev?.focus();
      } else if (e.key === 'Tab') {
        // Tab уводит фокус вовне → закрываем поповер. Не preventDefault
        // — браузер сам переведёт фокус на следующий focusable.
        onClose();
      }
    };

  const handleItemClick = (_e: MouseEvent<HTMLAnchorElement>) => {
    // Навигация уже произошла через Link. Закрываем поповер.
    onClose();
  };

  // KS-2842 helper: проверка active для подпункта (для CSS).
  const isItemActive = (match: string[]) =>
    match.some(
      (p) => location.pathname === p || location.pathname.startsWith(p + '/'),
    );

  return (
    <div
      className="sidebar-submenu"
      data-testid={`sidebar-submenu-${id}`}
      onMouseEnter={handleParentMouseEnter}
      onMouseLeave={handleParentMouseLeave}
    >
      <button
        ref={parentRef}
        id={parentId}
        type="button"
        className={`sidebar-item sidebar-submenu__parent${active ? ' sidebar-item--active' : ''}${isOpen ? ' sidebar-submenu__parent--open' : ''}`}
        title={t(props.titleKey, props.titleFallback)}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-controls={popoverId}
        data-testid={`sidebar-submenu-parent-${id}`}
        onClick={handleParentClick}
        onKeyDown={handleParentKeyDown}
      >
        <span className="sidebar-icon">{props.icon}</span>
        <span className="sidebar-submenu__chevron" aria-hidden="true">
          ›
        </span>
      </button>
      {isOpen && (
        <div
          ref={popoverRef}
          id={popoverId}
          role="menu"
          aria-labelledby={parentId}
          className="sidebar-submenu__popover"
          data-testid={`sidebar-submenu-popover-${id}`}
          style={{
            position: 'fixed',
            top: popoverTop,
            left: popoverLeft,
          }}
          onMouseEnter={handlePopoverMouseEnter}
          onMouseLeave={handlePopoverMouseLeave}
        >
          {items.map((item, idx) => (
            <Link
              key={item.id}
              ref={(el) => {
                itemRefs.current[idx] = el;
              }}
              to={item.to}
              role="menuitem"
              tabIndex={0}
              className={`sidebar-submenu__item${isItemActive(item.match) ? ' sidebar-submenu__item--active' : ''}`}
              data-testid={`sidebar-submenu-item-${item.id}`}
              onClick={handleItemClick}
              onKeyDown={handleItemKeyDown(idx)}
            >
              <span className="sidebar-submenu__item-icon" aria-hidden="true">
                {item.icon}
              </span>
              <span className="sidebar-submenu__item-label">
                {t(item.labelKey, item.labelFallback)}
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
