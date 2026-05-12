import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent } from '@testing-library/react';

import { renderWithProviders, screen } from '../test/test-utils';
import { SidebarSubmenu, type SidebarSubmenuItem } from './SidebarSubmenu';

/**
 * KS-2840 (ADR-058 §11.1, §11.2, §11.4, §11.7): тесты двухуровневого
 * submenu. Покрываем: открытие/закрытие, ARIA, keyboard nav, mouse
 * hover, click-outside, click по подпункту → onClose.
 */

const pointerState: { type: 'fine' | 'coarse' } = { type: 'fine' };
vi.mock('../hooks/usePointerType', () => ({
  usePointerType: () => pointerState.type,
}));

const ITEMS: SidebarSubmenuItem[] = [
  {
    id: 'puzzles',
    to: '/puzzles',
    match: ['/puzzles'],
    icon: '🧩',
    labelKey: 'nav.puzzles',
    labelFallback: 'Puzzles',
  },
  {
    id: 'rush',
    to: '/puzzle-rush',
    match: ['/puzzle-rush'],
    icon: '⚡',
    labelKey: 'nav.puzzleRush',
    labelFallback: 'Puzzle Rush',
  },
  {
    id: 'drills',
    to: '/drills',
    match: ['/drills'],
    icon: '🧠',
    labelKey: 'nav.drills',
    labelFallback: 'Drills',
  },
];

function Harness({ initialOpen = false }: { initialOpen?: boolean }) {
  // Wrapping в маленьком обёрточном компоненте — onOpen/onClose
  // управляют state так же, как делает Sidebar.
  const [open, setOpen] = require('react').useState(initialOpen);
  return (
    <SidebarSubmenu
      id="train"
      icon="🧠"
      titleKey="nav.train"
      titleFallback="Train"
      items={ITEMS}
      active={false}
      isOpen={open}
      onOpen={() => setOpen(true)}
      onClose={() => setOpen(false)}
    />
  );
}

beforeEach(() => {
  pointerState.type = 'fine';
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('<SidebarSubmenu> (KS-2840)', () => {
  it('parent — <button> с aria-haspopup="menu" и aria-expanded', () => {
    renderWithProviders(<Harness />);
    const parent = screen.getByTestId('sidebar-submenu-parent-train');
    expect(parent.tagName).toBe('BUTTON');
    expect(parent.getAttribute('aria-haspopup')).toBe('menu');
    expect(parent.getAttribute('aria-expanded')).toBe('false');
    expect(parent.getAttribute('aria-controls')).toBe('train-popover');
  });

  it('click по parent → поповер открывается, aria-expanded=true', () => {
    renderWithProviders(<Harness />);
    const parent = screen.getByTestId('sidebar-submenu-parent-train');
    fireEvent.click(parent);
    expect(parent.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByTestId('sidebar-submenu-popover-train')).toBeInTheDocument();
    expect(screen.getByTestId('sidebar-submenu-item-puzzles')).toBeInTheDocument();
    expect(screen.getByTestId('sidebar-submenu-item-rush')).toBeInTheDocument();
    expect(screen.getByTestId('sidebar-submenu-item-drills')).toBeInTheDocument();
  });

  it('повторный click по parent → toggle закрывает поповер', () => {
    renderWithProviders(<Harness />);
    const parent = screen.getByTestId('sidebar-submenu-parent-train');
    fireEvent.click(parent);
    expect(screen.getByTestId('sidebar-submenu-popover-train')).toBeInTheDocument();
    fireEvent.click(parent);
    expect(
      screen.queryByTestId('sidebar-submenu-popover-train'),
    ).not.toBeInTheDocument();
  });

  it('mouseenter parent (pointer:fine) → открывает поповер', () => {
    renderWithProviders(<Harness />);
    fireEvent.mouseEnter(screen.getByTestId('sidebar-submenu-train'));
    expect(screen.getByTestId('sidebar-submenu-popover-train')).toBeInTheDocument();
  });

  it('mouseenter (pointer:coarse) → НЕ открывает (touch не использует hover)', () => {
    pointerState.type = 'coarse';
    renderWithProviders(<Harness />);
    fireEvent.mouseEnter(screen.getByTestId('sidebar-submenu-train'));
    expect(
      screen.queryByTestId('sidebar-submenu-popover-train'),
    ).not.toBeInTheDocument();
  });

  it('click по подпункту → onClose (поповер закрывается)', () => {
    renderWithProviders(<Harness />);
    fireEvent.click(screen.getByTestId('sidebar-submenu-parent-train'));
    fireEvent.click(screen.getByTestId('sidebar-submenu-item-puzzles'));
    expect(
      screen.queryByTestId('sidebar-submenu-popover-train'),
    ).not.toBeInTheDocument();
  });

  it('click outside поповера → закрытие', () => {
    renderWithProviders(
      <div>
        <Harness />
        <div data-testid="outside">outside</div>
      </div>,
    );
    fireEvent.click(screen.getByTestId('sidebar-submenu-parent-train'));
    expect(screen.getByTestId('sidebar-submenu-popover-train')).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByTestId('outside'));
    expect(
      screen.queryByTestId('sidebar-submenu-popover-train'),
    ).not.toBeInTheDocument();
  });

  it('Escape (document) → закрывает поповер и возвращает фокус на parent', () => {
    renderWithProviders(<Harness />);
    const parent = screen.getByTestId('sidebar-submenu-parent-train');
    fireEvent.click(parent);
    expect(screen.getByTestId('sidebar-submenu-popover-train')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(
      screen.queryByTestId('sidebar-submenu-popover-train'),
    ).not.toBeInTheDocument();
    expect(document.activeElement).toBe(parent);
  });

  it('ArrowDown на parent → открывает поповер и фокус на первый подпункт', () => {
    renderWithProviders(<Harness />);
    const parent = screen.getByTestId('sidebar-submenu-parent-train');
    parent.focus();
    fireEvent.keyDown(parent, { key: 'ArrowDown' });
    expect(screen.getByTestId('sidebar-submenu-popover-train')).toBeInTheDocument();
    expect(document.activeElement).toBe(
      screen.getByTestId('sidebar-submenu-item-puzzles'),
    );
  });

  it('ArrowDown/ArrowUp в поповере циркулирует между подпунктами', () => {
    renderWithProviders(<Harness />);
    fireEvent.click(screen.getByTestId('sidebar-submenu-parent-train'));
    const first = screen.getByTestId('sidebar-submenu-item-puzzles');
    const second = screen.getByTestId('sidebar-submenu-item-rush');
    const third = screen.getByTestId('sidebar-submenu-item-drills');
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(second);
    fireEvent.keyDown(second, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(third);
    // Циркуляция: ArrowDown на последнем → первый.
    fireEvent.keyDown(third, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(first);
    // ArrowUp на первом → последний.
    fireEvent.keyDown(first, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(third);
  });

  it('подпункт имеет role=menuitem и href', () => {
    renderWithProviders(<Harness />);
    fireEvent.click(screen.getByTestId('sidebar-submenu-parent-train'));
    const item = screen.getByTestId('sidebar-submenu-item-puzzles');
    expect(item.getAttribute('role')).toBe('menuitem');
    expect(item.getAttribute('href')).toBe('/puzzles');
  });

  it('chevron `›` рендерится у parent (визуальный маркер submenu)', () => {
    renderWithProviders(<Harness />);
    const parent = screen.getByTestId('sidebar-submenu-parent-train');
    expect(parent.textContent).toContain('›');
  });
});
