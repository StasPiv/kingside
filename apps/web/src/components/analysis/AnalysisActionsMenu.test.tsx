import { describe, it, expect, vi } from 'vitest';
import { renderWithProviders, screen } from '../../test/test-utils';
import {
  AnalysisActionsMenu,
  type AnalysisActionItem,
} from './AnalysisActionsMenu';

/**
 * KS-3421 (ADR-087 §8 F1) — unit-тесты единого меню. Проверяем
 *   - dropdown/sheet рендерят одни и те же items по группам;
 *   - тап на пункт вызывает onClick + onClose;
 *   - disabled (auth-only для гостя) не триггерит onClick, отображает
 *     tooltip через title-атрибут;
 *   - visible=false скрывает пункт.
 */

const baseItems = (): AnalysisActionItem[] => [
  {
    id: 'set-position',
    group: 'gamePosition',
    label: 'Set Position (FEN)',
    onClick: vi.fn(),
  },
  {
    id: 'export-pgn',
    group: 'pgn',
    label: 'Export PGN',
    onClick: vi.fn(),
  },
  {
    id: 'guess-moves',
    group: 'training',
    label: 'Guess the moves',
    onClick: vi.fn(),
  },
  {
    id: 'share',
    group: 'sharing',
    label: 'Share',
    onClick: vi.fn(),
    disabled: true,
    disabledHint: 'Sign in to share',
  },
];

describe('<AnalysisActionsMenu>', () => {
  it('dropdown: 4 группы, 4 пункта, корректные testid + порядок', () => {
    const onClose = vi.fn();
    renderWithProviders(
      <AnalysisActionsMenu
        open
        onClose={onClose}
        items={baseItems()}
        mode="dropdown"
      />,
    );
    expect(
      screen.getByTestId('analysis-actions-menu').getAttribute('data-mode'),
    ).toBe('dropdown');
    expect(screen.getByTestId('analysis-actions-group-gamePosition')).toBeTruthy();
    expect(screen.getByTestId('analysis-actions-group-pgn')).toBeTruthy();
    expect(screen.getByTestId('analysis-actions-group-training')).toBeTruthy();
    expect(screen.getByTestId('analysis-actions-group-sharing')).toBeTruthy();
    expect(screen.getByTestId('analysis-actions-item-set-position')).toBeTruthy();
    expect(screen.getByTestId('analysis-actions-item-export-pgn')).toBeTruthy();
    expect(screen.getByTestId('analysis-actions-item-guess-moves')).toBeTruthy();
    expect(screen.getByTestId('analysis-actions-item-share')).toBeTruthy();
  });

  it('sheet: рендерит backdrop + close + те же items', () => {
    const onClose = vi.fn();
    renderWithProviders(
      <AnalysisActionsMenu
        open
        onClose={onClose}
        items={baseItems()}
        mode="sheet"
      />,
    );
    expect(
      screen.getByTestId('analysis-actions-menu').getAttribute('data-mode'),
    ).toBe('sheet');
    expect(screen.getByTestId('analysis-actions-menu-backdrop')).toBeTruthy();
    expect(screen.getByTestId('analysis-actions-menu-close')).toBeTruthy();
    expect(screen.getByTestId('analysis-actions-item-guess-moves')).toBeTruthy();
  });

  it('тап на enabled-пункт → onClick + onClose; на disabled — ни того ни другого, есть title', () => {
    const onClose = vi.fn();
    const items = baseItems();
    renderWithProviders(
      <AnalysisActionsMenu
        open
        onClose={onClose}
        items={items}
        mode="dropdown"
      />,
    );
    (screen.getByTestId('analysis-actions-item-guess-moves') as HTMLButtonElement).click();
    expect((items[2].onClick as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
      1,
    );
    expect(onClose).toHaveBeenCalledTimes(1);

    // disabled (Share)
    const shareBtn = screen.getByTestId(
      'analysis-actions-item-share',
    ) as HTMLButtonElement;
    expect(shareBtn.disabled).toBe(true);
    expect(shareBtn.getAttribute('title')).toBe('Sign in to share');
    shareBtn.click();
    expect((items[3].onClick as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
      0,
    );
    // onClose не должен вырасти от disabled-клика.
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('visible=false скрывает пункт', () => {
    const items = baseItems();
    items[1].visible = false; // export-pgn
    renderWithProviders(
      <AnalysisActionsMenu
        open
        onClose={() => {}}
        items={items}
        mode="dropdown"
      />,
    );
    expect(screen.queryByTestId('analysis-actions-item-export-pgn')).toBeNull();
    // Группа pgn целиком исчезла (был один пункт).
    expect(screen.queryByTestId('analysis-actions-group-pgn')).toBeNull();
  });

  it('KS-3431: тап по пункту не всплывает до document.mousedown (parent click-outside не сработает)', () => {
    const onClose = vi.fn();
    const items = baseItems();
    // Эмулируем parent click-outside listener (как в AnalysisPage:
    // document.addEventListener('mousedown', …)).
    const outsideHandler = vi.fn();
    document.addEventListener('mousedown', outsideHandler);
    try {
      renderWithProviders(
        <AnalysisActionsMenu
          open
          onClose={onClose}
          items={items}
          mode="sheet"
        />,
      );
      const btn = screen.getByTestId(
        'analysis-actions-item-guess-moves',
      ) as HTMLButtonElement;
      // Симулируем реальный тап: mousedown → click.
      btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      btn.click();
      expect(
        (items[2].onClick as ReturnType<typeof vi.fn>).mock.calls.length,
      ).toBe(1);
      expect(onClose).toHaveBeenCalledTimes(1);
      // Корень меню остановил mousedown — parent-listener не сработал.
      expect(outsideHandler).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener('mousedown', outsideHandler);
    }
  });

  it('open=false → ничего не рендерим', () => {
    renderWithProviders(
      <AnalysisActionsMenu
        open={false}
        onClose={() => {}}
        items={baseItems()}
        mode="dropdown"
      />,
    );
    expect(screen.queryByTestId('analysis-actions-menu')).toBeNull();
  });
});
