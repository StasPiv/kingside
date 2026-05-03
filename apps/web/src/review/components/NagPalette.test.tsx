import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { fireEvent } from '@testing-library/react';

import { renderWithProviders, screen } from '../../test/test-utils';
import { NagPalette } from './NagPalette';
import { NagPaletteSheet } from './NagPaletteSheet';

/**
 * KS-2269 (ADR-037 §3, §6, этап E2).
 *
 * Покрытие:
 *  - NagPalette рендерит 14 кнопок NAG (quality 1..6 + positionEval 10/13..19) + delete.
 *  - Кнопка с активным NAG помечена `nag-palette__btn--active` + aria-pressed.
 *  - Клик по NAG вызывает onChange с новым набором (через setNagInCategory):
 *    replace-within-group, toggle-off, multi-category coexistence.
 *  - Delete отдаёт onChange([]).
 *  - onClose вызывается после клика по NAG / delete.
 *  - NagPaletteSheet: open=false → null, open=true → backdrop + panel,
 *    клик по backdrop закрывает, Esc закрывает, клик внутри панели не закрывает.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

describe('<NagPalette> KS-2269', () => {
  it('рендерит 14 NAG-кнопок (quality 1..6 + positionEval 10/13..19) + delete', () => {
    renderWithProviders(
      <NagPalette nags={[]} onChange={() => {}} />,
    );
    // Все 14 кнопок присутствуют.
    [1, 2, 3, 4, 5, 6, 10, 13, 14, 15, 16, 17, 18, 19].forEach((nag) => {
      expect(screen.getByTestId(`nag-palette-btn-${nag}`)).toBeInTheDocument();
    });
    expect(screen.getByTestId('nag-palette-delete')).toBeInTheDocument();
  });

  it('активный NAG помечен модификатором + aria-pressed=true', () => {
    renderWithProviders(
      <NagPalette nags={[3, 14]} onChange={() => {}} />,
    );
    const active1 = screen.getByTestId('nag-palette-btn-3');
    const active2 = screen.getByTestId('nag-palette-btn-14');
    const inactive = screen.getByTestId('nag-palette-btn-1');
    expect(active1.className).toMatch(/nag-palette__btn--active/);
    expect(active1.getAttribute('aria-pressed')).toBe('true');
    expect(active2.className).toMatch(/nag-palette__btn--active/);
    expect(inactive.className).not.toMatch(/--active/);
    expect(inactive.getAttribute('aria-pressed')).toBe('false');
  });

  it('replace within quality: nags=[1] + клик `!!` → onChange([3])', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <NagPalette nags={[1]} onChange={onChange} />,
    );
    await user.click(screen.getByTestId('nag-palette-btn-3'));
    expect(onChange).toHaveBeenCalledWith([3]);
  });

  it('toggle off: nags=[3] + клик `!!` → onChange([])', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <NagPalette nags={[3]} onChange={onChange} />,
    );
    await user.click(screen.getByTestId('nag-palette-btn-3'));
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it('multi-category coexistence: nags=[1] + клик `⩲` ($14) → onChange([1, 14])', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <NagPalette nags={[1]} onChange={onChange} />,
    );
    await user.click(screen.getByTestId('nag-palette-btn-14'));
    expect(onChange).toHaveBeenCalledWith([1, 14]);
  });

  it('delete: nags=[1, 14] + клик delete → onChange([])', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <NagPalette nags={[1, 14]} onChange={onChange} />,
    );
    await user.click(screen.getByTestId('nag-palette-delete'));
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it('delete disabled при пустых nags', () => {
    renderWithProviders(
      <NagPalette nags={[]} onChange={() => {}} />,
    );
    expect(screen.getByTestId('nag-palette-delete')).toBeDisabled();
  });

  it('onClose вызывается после клика по NAG и после delete', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <NagPalette nags={[1]} onChange={() => {}} onClose={onClose} />,
    );
    await user.click(screen.getByTestId('nag-palette-btn-3'));
    expect(onClose).toHaveBeenCalledTimes(1);
    await user.click(screen.getByTestId('nag-palette-delete'));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('у кнопок выставлен type="button" (не submit-default)', () => {
    renderWithProviders(
      <NagPalette nags={[]} onChange={() => {}} />,
    );
    const btn = screen.getByTestId('nag-palette-btn-1') as HTMLButtonElement;
    expect(btn.getAttribute('type')).toBe('button');
    const del = screen.getByTestId('nag-palette-delete') as HTMLButtonElement;
    expect(del.getAttribute('type')).toBe('button');
  });
});

describe('<NagPaletteSheet> KS-2269', () => {
  it('open=false → ничего не рендерится', () => {
    const { container } = renderWithProviders(
      <NagPaletteSheet
        open={false}
        nags={[]}
        onChange={() => {}}
        onClose={() => {}}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('open=true → backdrop + panel + NagPalette внутри', () => {
    renderWithProviders(
      <NagPaletteSheet
        open
        nags={[1]}
        onChange={() => {}}
        onClose={() => {}}
      />,
    );
    expect(screen.getByTestId('nag-palette-sheet-backdrop')).toBeInTheDocument();
    expect(screen.getByTestId('nag-palette-sheet')).toBeInTheDocument();
    expect(screen.getByTestId('nag-palette')).toBeInTheDocument();
    // active NAG прокинут в внутренний NagPalette.
    expect(screen.getByTestId('nag-palette-btn-1').className).toMatch(/--active/);
  });

  it('клик по backdrop вызывает onClose', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <NagPaletteSheet
        open
        nags={[]}
        onChange={() => {}}
        onClose={onClose}
      />,
    );
    await user.click(screen.getByTestId('nag-palette-sheet-backdrop'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('клик внутри панели НЕ закрывает (stopPropagation)', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <NagPaletteSheet
        open
        nags={[]}
        onChange={() => {}}
        onClose={onClose}
      />,
    );
    await user.click(screen.getByTestId('nag-palette-sheet'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('Esc → onClose', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <NagPaletteSheet
        open
        nags={[]}
        onChange={() => {}}
        onClose={onClose}
      />,
    );
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('клик по NAG внутри sheet → onChange + onClose (через NagPalette.onClose)', async () => {
    const onChange = vi.fn();
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <NagPaletteSheet
        open
        nags={[]}
        onChange={onChange}
        onClose={onClose}
      />,
    );
    await user.click(screen.getByTestId('nag-palette-btn-3'));
    expect(onChange).toHaveBeenCalledWith([3]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('<NagPaletteSheet> KS-2277 — swipe-to-dismiss + half-height', () => {
  it('handle присутствует с aria-label и testid', () => {
    renderWithProviders(
      <NagPaletteSheet
        open
        nags={[]}
        onChange={() => {}}
        onClose={() => {}}
      />,
    );
    const handle = screen.getByTestId('nag-palette-sheet-handle');
    expect(handle).toBeInTheDocument();
    expect(handle.getAttribute('aria-label')).toMatch(/drag|закрыть|потяни/i);
  });

  it('swipe-down >= 80px на handle → onClose', () => {
    const onClose = vi.fn();
    renderWithProviders(
      <NagPaletteSheet
        open
        nags={[]}
        onChange={() => {}}
        onClose={onClose}
      />,
    );
    const handle = screen.getByTestId('nag-palette-sheet-handle');
    // touchstart на y=100 → touchmove на y=200 (Δy = 100) → touchend.
    fireEvent.touchStart(handle, {
      touches: [{ clientX: 50, clientY: 100 }],
    });
    fireEvent.touchMove(handle, {
      touches: [{ clientX: 50, clientY: 200 }],
    });
    fireEvent.touchEnd(handle);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('swipe-down < 80px → onClose НЕ вызывается, sheet возвращается на место', () => {
    const onClose = vi.fn();
    renderWithProviders(
      <NagPaletteSheet
        open
        nags={[]}
        onChange={() => {}}
        onClose={onClose}
      />,
    );
    const handle = screen.getByTestId('nag-palette-sheet-handle');
    fireEvent.touchStart(handle, {
      touches: [{ clientX: 50, clientY: 100 }],
    });
    fireEvent.touchMove(handle, {
      touches: [{ clientX: 50, clientY: 150 }], // Δy = 50, < threshold
    });
    fireEvent.touchEnd(handle);
    expect(onClose).not.toHaveBeenCalled();
    // После отпуска drag-offset вернулся на 0.
    const sheet = screen.getByTestId('nag-palette-sheet');
    expect(sheet.style.getPropertyValue('--nag-sheet-drag')).toBe('0px');
    expect(sheet.getAttribute('data-dragging')).toBe('false');
  });

  it('swipe-UP игнорируется (offset clamp в 0)', () => {
    const onClose = vi.fn();
    renderWithProviders(
      <NagPaletteSheet
        open
        nags={[]}
        onChange={() => {}}
        onClose={onClose}
      />,
    );
    const handle = screen.getByTestId('nag-palette-sheet-handle');
    fireEvent.touchStart(handle, {
      touches: [{ clientX: 50, clientY: 200 }],
    });
    fireEvent.touchMove(handle, {
      touches: [{ clientX: 50, clientY: 50 }], // Δy = -150 (вверх)
    });
    const sheet = screen.getByTestId('nag-palette-sheet');
    expect(sheet.style.getPropertyValue('--nag-sheet-drag')).toBe('0px');
    fireEvent.touchEnd(handle);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('drag визуально следует за пальцем (CSS-переменная --nag-sheet-drag обновляется)', () => {
    renderWithProviders(
      <NagPaletteSheet
        open
        nags={[]}
        onChange={() => {}}
        onClose={() => {}}
      />,
    );
    const handle = screen.getByTestId('nag-palette-sheet-handle');
    const sheet = screen.getByTestId('nag-palette-sheet');
    fireEvent.touchStart(handle, {
      touches: [{ clientX: 50, clientY: 100 }],
    });
    fireEvent.touchMove(handle, {
      touches: [{ clientX: 50, clientY: 130 }], // Δy = 30
    });
    expect(sheet.style.getPropertyValue('--nag-sheet-drag')).toBe('30px');
    expect(sheet.getAttribute('data-dragging')).toBe('true');
  });

  it('viewport < 700px → data-half-height="true" + CSS var --nag-sheet-max-height=50vh', () => {
    // Подменяем innerHeight ДО renderWithProviders, чтобы useEffect
    // открытия снял именно подменённое значение.
    const original = window.innerHeight;
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      value: 600,
    });
    try {
      renderWithProviders(
        <NagPaletteSheet
          open
          nags={[]}
          onChange={() => {}}
          onClose={() => {}}
        />,
      );
      const sheet = screen.getByTestId('nag-palette-sheet');
      expect(sheet.getAttribute('data-half-height')).toBe('true');
      expect(sheet.style.getPropertyValue('--nag-sheet-max-height')).toBe(
        '50vh',
      );
    } finally {
      Object.defineProperty(window, 'innerHeight', {
        configurable: true,
        value: original,
      });
    }
  });

  it('viewport >= 700px → data-half-height="false", CSS var не задана', () => {
    const original = window.innerHeight;
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      value: 900,
    });
    try {
      renderWithProviders(
        <NagPaletteSheet
          open
          nags={[]}
          onChange={() => {}}
          onClose={() => {}}
        />,
      );
      const sheet = screen.getByTestId('nag-palette-sheet');
      expect(sheet.getAttribute('data-half-height')).toBe('false');
      expect(sheet.style.getPropertyValue('--nag-sheet-max-height')).toBe('');
    } finally {
      Object.defineProperty(window, 'innerHeight', {
        configurable: true,
        value: original,
      });
    }
  });

  it('клик по handle (без drag) → onClose', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <NagPaletteSheet
        open
        nags={[]}
        onChange={() => {}}
        onClose={onClose}
      />,
    );
    await user.click(screen.getByTestId('nag-palette-sheet-handle'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('<NagPalette> KS-2282 — hotkeys 1..9 / Esc', () => {
  it.each([
    ['1', 1],
    ['2', 2],
    ['3', 3],
    ['4', 4],
    ['5', 5],
    ['6', 6],
    ['7', 10],
    ['8', 13],
    ['9', 14],
  ])('hotkey "%s" → onChange со setNagInCategory(nags, %s)', async (key, expectedNag) => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<NagPalette nags={[]} onChange={onChange} />);
    await user.keyboard(key);
    expect(onChange).toHaveBeenCalledWith([expectedNag]);
  });

  it('Esc → onClose', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <NagPalette nags={[]} onChange={() => {}} onClose={onClose} />,
    );
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('hotkey игнорируется, если фокус в <input>', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <>
        <input data-testid="other-input" defaultValue="" />
        <NagPalette nags={[]} onChange={onChange} />
      </>,
    );
    const input = screen.getByTestId('other-input') as HTMLInputElement;
    input.focus();
    await user.keyboard('1');
    // Цифра должна попасть в input, NAG не вызвался.
    expect(input.value).toBe('1');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('replace within group через hotkey: nags=[1] + "3" → onChange([3])', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<NagPalette nags={[1]} onChange={onChange} />);
    await user.keyboard('3');
    expect(onChange).toHaveBeenCalledWith([3]);
  });

  it('видимый hint содержит "1..9" и "Esc"', () => {
    renderWithProviders(<NagPalette nags={[]} onChange={() => {}} />);
    const hint = screen.getByTestId('nag-palette-hint');
    expect(hint).toBeInTheDocument();
    expect(hint.textContent).toContain('1..9');
    expect(hint.textContent?.toLowerCase()).toMatch(/esc/);
  });
});


beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});
