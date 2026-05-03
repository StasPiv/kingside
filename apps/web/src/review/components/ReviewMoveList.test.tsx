import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { fireEvent } from '@testing-library/react';

import { renderWithProviders, screen, waitFor } from '../../test/test-utils';
import { ReviewMoveList } from './ReviewMoveList';
import type { ChessMove } from '../types';

/**
 * KS-2266 (ADR-037 §6) — категорийная дедупликация NAG в UI.
 *
 * До фикса: правый клик `!!` после `!` давал `nags = [1, 3]`
 * (рендерилось как `! !!`). После фикса: setNagInCategory заменяет
 * NAG внутри категории `quality`, у хода остаётся ровно `[3]`.
 *
 * Покрытие:
 *  - replace within group: nags=[1] + клик `!!` → onSetNag(idx, [3]).
 *  - toggle off: nags=[3] + клик `!!` → onSetNag(idx, []).
 *  - cross-category coexistence: nags=[1, 14] + клик `!!` → [14, 3].
 *  - renderNagSymbols показывает по одному NAG категории даже при
 *    legacy-данных с дублями (`[1, 3]` → видим только `!!`).
 */

function makeMove(overrides: Partial<ChessMove> = {}): ChessMove {
  return {
    san: 'e4',
    fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1',
    from: 'e2',
    to: 'e4',
    piece: 'p',
    flags: 'b',
    lan: 'e2e4',
    before: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    after: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1',
    globalIndex: 1,
    ply: 1,
    ...overrides,
  };
}

beforeEach(() => {
  // Чтобы скроллы из useEffect не падали в jsdom/happy-dom.
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('<ReviewMoveList> KS-2266 — NAG категорийная дедупликация', () => {
  it('replace within quality: [1] + клик "!!" → onSetNag(idx, [3])', async () => {
    const onSetNag = vi.fn();
    const move = makeMove({ nags: [1] }); // `!`
    renderWithProviders(
      <ReviewMoveList
        history={[move]}
        currentGlobalIndex={1}
        onMoveClick={() => {}}
        onSetNag={onSetNag}
      />,
    );

    const moveEl = screen.getByTestId('review-move-1');
    fireEvent.contextMenu(moveEl);

    const user = userEvent.setup();
    const nagBtn = document.querySelector('button[data-nag="3"]') as HTMLButtonElement;
    expect(nagBtn).not.toBeNull();
    await user.click(nagBtn);

    expect(onSetNag).toHaveBeenCalledTimes(1);
    expect(onSetNag).toHaveBeenCalledWith(1, [3]);
  });

  it('toggle off: [3] + клик "!!" → onSetNag(idx, [])', async () => {
    const onSetNag = vi.fn();
    const move = makeMove({ nags: [3] });
    renderWithProviders(
      <ReviewMoveList
        history={[move]}
        currentGlobalIndex={1}
        onMoveClick={() => {}}
        onSetNag={onSetNag}
      />,
    );

    fireEvent.contextMenu(screen.getByTestId('review-move-1'));
    const user = userEvent.setup();
    await user.click(document.querySelector('button[data-nag="3"]') as HTMLButtonElement);

    expect(onSetNag).toHaveBeenCalledWith(1, []);
  });

  it('cross-category coexistence: [1, 14] + клик "!!" → [14, 3]', async () => {
    const onSetNag = vi.fn();
    // 14 — position-eval `⩲`, не из quality-категории.
    const move = makeMove({ nags: [1, 14] });
    renderWithProviders(
      <ReviewMoveList
        history={[move]}
        currentGlobalIndex={1}
        onMoveClick={() => {}}
        onSetNag={onSetNag}
      />,
    );

    fireEvent.contextMenu(screen.getByTestId('review-move-1'));
    const user = userEvent.setup();
    await user.click(document.querySelector('button[data-nag="3"]') as HTMLButtonElement);

    expect(onSetNag).toHaveBeenCalledWith(1, [14, 3]);
  });

  it('renderNagSymbols показывает по одному NAG категории (legacy [1, 3] → видим только "!!")', () => {
    // Симулируем legacy-данные с дублями quality-NAG (`[1, 3]`).
    const move = makeMove({ nags: [1, 3] });
    renderWithProviders(
      <ReviewMoveList
        history={[move]}
        currentGlobalIndex={1}
        onMoveClick={() => {}}
        onSetNag={() => {}}
      />,
    );

    const moveEl = screen.getByTestId('review-move-1');
    // Видим только последний quality-NAG категории.
    expect(moveEl).toHaveTextContent('!!');
    // Не видим пары `! !!` или `! !`.
    expect(moveEl.textContent).not.toMatch(/! !!/);
  });

  it('renderNagSymbols: один quality + один positionEval inline ([1, 14] → "! ⩲")', () => {
    const move = makeMove({ nags: [1, 14] });
    renderWithProviders(
      <ReviewMoveList
        history={[move]}
        currentGlobalIndex={1}
        onMoveClick={() => {}}
        onSetNag={() => {}}
      />,
    );
    const moveEl = screen.getByTestId('review-move-1');
    // Оба NAG (по одному из каждой категории) видны.
    expect(moveEl.textContent).toContain('!');
    expect(moveEl.textContent).toContain('⩲');
  });
});

describe('<ReviewMoveList> KS-2283 — интеграция NagPalette / NagPaletteSheet', () => {
  it('правый клик → монтирует NagPalette (desktop popup) с 14 кнопками + delete', () => {
    const move = makeMove({ nags: [1] });
    renderWithProviders(
      <ReviewMoveList
        history={[move]}
        currentGlobalIndex={1}
        onMoveClick={() => {}}
        onSetNag={() => {}}
      />,
    );
    fireEvent.contextMenu(screen.getByTestId('review-move-1'));
    expect(screen.getByTestId('nag-palette')).toBeInTheDocument();
    // 14 кнопок NAG.
    [1, 2, 3, 4, 5, 6, 10, 13, 14, 15, 16, 17, 18, 19].forEach((nag) => {
      expect(screen.getByTestId(`nag-palette-btn-${nag}`)).toBeInTheDocument();
    });
    expect(screen.getByTestId('nag-palette-delete')).toBeInTheDocument();
  });

  it('Esc → закрывает desktop popup', async () => {
    const move = makeMove({ nags: [] });
    const user = userEvent.setup();
    renderWithProviders(
      <ReviewMoveList
        history={[move]}
        currentGlobalIndex={1}
        onMoveClick={() => {}}
        onSetNag={() => {}}
      />,
    );
    fireEvent.contextMenu(screen.getByTestId('review-move-1'));
    expect(screen.getByTestId('nag-palette')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByTestId('nag-palette')).not.toBeInTheDocument();
  });

  it('long-press 500ms → монтирует NagPaletteSheet (mobile bottom-sheet)', async () => {
    // KS-2278: режим теперь зависит от device. Подменяем touch+viewport
    // чтобы useIsMobile() вернул true в этом тесте.
    const origW = window.innerWidth;
    const origT = navigator.maxTouchPoints;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 375 });
    Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: 5 });
    try {
      const move = makeMove({ nags: [3] });
      renderWithProviders(
        <ReviewMoveList
          history={[move]}
          currentGlobalIndex={1}
          onMoveClick={() => {}}
          onSetNag={() => {}}
        />,
      );
      const moveEl = screen.getByTestId('review-move-1');
      fireEvent.touchStart(moveEl, {
        touches: [{ clientX: 50, clientY: 100 }],
      });
      // long-press timer 500ms; ждём чуть дольше реальным setTimeout
      // (vi.useFakeTimers + React 19 не дружат с handleTouchStart timer).
      await new Promise((r) => setTimeout(r, 550));
      await waitFor(() =>
        expect(screen.getByTestId('nag-palette-sheet')).toBeInTheDocument(),
      );
      // Внутри sheet — NagPalette с активным `!!` (nag=3).
      expect(screen.getByTestId('nag-palette')).toBeInTheDocument();
      expect(
        screen.getByTestId('nag-palette-btn-3').className,
      ).toMatch(/--active/);
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: origW });
      Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: origT });
    }
  });

  it('mobile sheet: extraActions — comment / promote / truncate / delete рендерятся под палитрой', async () => {
    const origW = window.innerWidth;
    const origT = navigator.maxTouchPoints;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 375 });
    Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: 5 });
    try {
      const move = makeMove({ nags: [] });
      renderWithProviders(
        <ReviewMoveList
          history={[move]}
          currentGlobalIndex={1}
          onMoveClick={() => {}}
          onSetNag={() => {}}
          onSetComment={() => {}}
          onPromoteVariation={() => {}}
          onTruncateRemaining={() => {}}
          onDeleteVariation={() => {}}
        />,
      );
      fireEvent.touchStart(screen.getByTestId('review-move-1'), {
        touches: [{ clientX: 50, clientY: 100 }],
      });
      await new Promise((r) => setTimeout(r, 550));
      const actions = await screen.findByTestId('nag-palette-sheet-actions');
      expect(actions.textContent).toMatch(/Add comment/i);
      expect(actions.textContent).toMatch(/Promote/i);
      expect(actions.textContent).toMatch(/Truncate/i);
      expect(actions.textContent).toMatch(/Delete/i);
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: origW });
      Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: origT });
    }
  });

  it('read-only (editable=false): правый клик НЕ открывает палитру', () => {
    const move = makeMove({ nags: [1] });
    renderWithProviders(
      <ReviewMoveList
        history={[move]}
        currentGlobalIndex={1}
        onMoveClick={() => {}}
        readOnly
      />,
    );
    fireEvent.contextMenu(screen.getByTestId('review-move-1'));
    expect(screen.queryByTestId('nag-palette')).not.toBeInTheDocument();
    expect(screen.queryByTestId('nag-palette-sheet')).not.toBeInTheDocument();
  });

  it('read-only: long-press НЕ открывает sheet', async () => {
    const move = makeMove({ nags: [] });
    renderWithProviders(
      <ReviewMoveList
        history={[move]}
        currentGlobalIndex={1}
        onMoveClick={() => {}}
        readOnly
      />,
    );
    fireEvent.touchStart(screen.getByTestId('review-move-1'), {
      touches: [{ clientX: 50, clientY: 100 }],
    });
    await new Promise((r) => setTimeout(r, 600));
    expect(screen.queryByTestId('nag-palette-sheet')).not.toBeInTheDocument();
  });
});

describe('<ReviewMoveList> KS-2278 — device-detection mode', () => {
  // Хелпер: подменить touch+viewport, требуется ДО mount компонента,
  // чтобы useIsMobile взял правильное начальное значение.
  function setDevice(opts: { width: number; touch: number }) {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: opts.width,
    });
    Object.defineProperty(navigator, 'maxTouchPoints', {
      configurable: true,
      value: opts.touch,
    });
  }
  const originalWidth = window.innerWidth;
  const originalTouch = navigator.maxTouchPoints;

  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    setDevice({ width: originalWidth, touch: originalTouch });
  });

  it('mobile (touch + узкий viewport): right-click → открывается NagPaletteSheet, НЕ popup', () => {
    setDevice({ width: 375, touch: 5 });
    const move = makeMove({ nags: [] });
    renderWithProviders(
      <ReviewMoveList
        history={[move]}
        currentGlobalIndex={1}
        onMoveClick={() => {}}
        onSetNag={() => {}}
      />,
    );
    fireEvent.contextMenu(screen.getByTestId('review-move-1'));
    expect(screen.getByTestId('nag-palette-sheet')).toBeInTheDocument();
    expect(document.querySelector('.review-context-menu')).toBeNull();
  });

  it('desktop touch-screen ноут (touch + широкий viewport): long-press → popup, НЕ sheet', async () => {
    setDevice({ width: 1280, touch: 10 });
    const move = makeMove({ nags: [] });
    renderWithProviders(
      <ReviewMoveList
        history={[move]}
        currentGlobalIndex={1}
        onMoveClick={() => {}}
        onSetNag={() => {}}
      />,
    );
    fireEvent.touchStart(screen.getByTestId('review-move-1'), {
      touches: [{ clientX: 50, clientY: 100 }],
    });
    await new Promise((r) => setTimeout(r, 550));
    expect(document.querySelector('.review-context-menu')).not.toBeNull();
    expect(screen.queryByTestId('nag-palette-sheet')).not.toBeInTheDocument();
  });

  it('desktop без touch: right-click → popup', () => {
    setDevice({ width: 1920, touch: 0 });
    const move = makeMove({ nags: [] });
    renderWithProviders(
      <ReviewMoveList
        history={[move]}
        currentGlobalIndex={1}
        onMoveClick={() => {}}
        onSetNag={() => {}}
      />,
    );
    fireEvent.contextMenu(screen.getByTestId('review-move-1'));
    expect(document.querySelector('.review-context-menu')).not.toBeNull();
    expect(screen.queryByTestId('nag-palette-sheet')).not.toBeInTheDocument();
  });

  it('узкое окно desktop без touch (600px, touch=0): right-click → popup, НЕ sheet (false-positive защита)', () => {
    setDevice({ width: 600, touch: 0 });
    const move = makeMove({ nags: [] });
    renderWithProviders(
      <ReviewMoveList
        history={[move]}
        currentGlobalIndex={1}
        onMoveClick={() => {}}
        onSetNag={() => {}}
      />,
    );
    fireEvent.contextMenu(screen.getByTestId('review-move-1'));
    // Без touch — это desktop с пользователем за мышкой, sheet не нужен.
    expect(document.querySelector('.review-context-menu')).not.toBeNull();
    expect(screen.queryByTestId('nag-palette-sheet')).not.toBeInTheDocument();
  });
});

describe('<ReviewMoveList> KS-2282 — hotkey A для открытия палитры', () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('hotkey "A" → открывает палитру для текущего хода (currentGlobalIndex)', async () => {
    const move1 = makeMove({ globalIndex: 1, nags: [] });
    const move2 = makeMove({ globalIndex: 2, nags: [3], san: 'e5' });
    const user = userEvent.setup();
    renderWithProviders(
      <ReviewMoveList
        history={[move1, move2]}
        currentGlobalIndex={2}
        onMoveClick={() => {}}
        onSetNag={() => {}}
      />,
    );
    await user.keyboard('a');
    expect(screen.getByTestId('nag-palette')).toBeInTheDocument();
    // Внутри палитры активен NAG=3 (из move2.nags).
    expect(
      screen.getByTestId('nag-palette-btn-3').className,
    ).toMatch(/--active/);
  });

  it('hotkey "A" игнорируется в read-only', async () => {
    const move = makeMove({ globalIndex: 1 });
    const user = userEvent.setup();
    renderWithProviders(
      <ReviewMoveList
        history={[move]}
        currentGlobalIndex={1}
        onMoveClick={() => {}}
        readOnly
      />,
    );
    await user.keyboard('a');
    expect(screen.queryByTestId('nag-palette')).not.toBeInTheDocument();
  });

  it('hotkey "Ctrl+A" не открывает палитру (browser select-all не ломаем)', async () => {
    const move = makeMove({ globalIndex: 1 });
    const user = userEvent.setup();
    renderWithProviders(
      <ReviewMoveList
        history={[move]}
        currentGlobalIndex={1}
        onMoveClick={() => {}}
        onSetNag={() => {}}
      />,
    );
    await user.keyboard('{Control>}a{/Control}');
    expect(screen.queryByTestId('nag-palette')).not.toBeInTheDocument();
  });

  it('hotkey "A" не открывает палитру дважды (если уже открыта)', async () => {
    const move = makeMove({ globalIndex: 1 });
    const user = userEvent.setup();
    renderWithProviders(
      <ReviewMoveList
        history={[move]}
        currentGlobalIndex={1}
        onMoveClick={() => {}}
        onSetNag={() => {}}
      />,
    );
    await user.keyboard('a');
    expect(screen.getByTestId('nag-palette')).toBeInTheDocument();
    await user.keyboard('a');
    expect(screen.getAllByTestId('nag-palette').length).toBe(1);
  });
});

describe('<ReviewMoveList> KS-2297 — mobile sheet без onSetNag (regression)', () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 375 });
    Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: 5 });
  });
  afterEach(() => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
    Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: 0 });
  });

  it('mobile + editable=true (promote/delete/truncate) БЕЗ onSetNag → sheet НЕ открывается, fallback на actions-popup', async () => {
    const move = makeMove({ globalIndex: 1, nags: [] });
    renderWithProviders(
      <ReviewMoveList
        history={[move]}
        currentGlobalIndex={1}
        onMoveClick={() => {}}
        onPromoteVariation={() => {}}
        onDeleteVariation={() => {}}
        onTruncateRemaining={() => {}}
      />,
    );
    fireEvent.touchStart(screen.getByTestId('review-move-1'), {
      touches: [{ clientX: 50, clientY: 100 }],
    });
    await new Promise((r) => setTimeout(r, 550));
    // KS-2297: NagPaletteSheet НЕ должен появиться (нет onSetNag — клики
    // по NAG-кнопкам всё равно были бы no-op).
    expect(screen.queryByTestId('nag-palette-sheet')).not.toBeInTheDocument();
    expect(screen.queryByTestId('nag-palette')).not.toBeInTheDocument();
    // Но fallback popup с actions появляется (промоут/удалить — рабочие).
    expect(document.querySelector('.review-context-menu')).not.toBeNull();
  });

  it('mobile + onSetNag=fn → sheet открывается, click по NAG доходит до onSetNag (regression-fix)', async () => {
    const onSetNag = vi.fn();
    const move = makeMove({ globalIndex: 1, nags: [] });
    renderWithProviders(
      <ReviewMoveList
        history={[move]}
        currentGlobalIndex={1}
        onMoveClick={() => {}}
        onPromoteVariation={() => {}}
        onSetNag={onSetNag}
      />,
    );
    fireEvent.touchStart(screen.getByTestId('review-move-1'), {
      touches: [{ clientX: 50, clientY: 100 }],
    });
    await new Promise((r) => setTimeout(r, 550));
    expect(screen.getByTestId('nag-palette-sheet')).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByTestId('nag-palette-btn-3'));
    expect(onSetNag).toHaveBeenCalledWith(1, [3]);
  });
});

describe('<ReviewMoveList> KS-2295 — hotkey V для variation-color', () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('"V" → открывает палитру с focus="variationColor" для current move', async () => {
    const move = makeMove({ globalIndex: 1, nags: [] });
    const user = userEvent.setup();
    renderWithProviders(
      <ReviewMoveList
        history={[move]}
        currentGlobalIndex={1}
        onMoveClick={() => {}}
        onSetNag={() => {}}
        onSetVariationColor={() => {}}
      />,
    );
    await user.keyboard('v');
    const palette = screen.getByTestId('nag-palette');
    expect(palette).toBeInTheDocument();
    // На main-line variation-color section не показывается, но
    // initialFocus всё равно прокинут. Если ход main-line, focus
    // силой откатывается на 'nag' (см. NagPalette).
    expect(palette.getAttribute('data-focus')).toBe('nag');
  });

  it('"V" на ходе варианта → палитра открывается с focus="variationColor"', async () => {
    const branch = makeMove({ globalIndex: 2, san: 'd4', ply: 1 });
    const main = makeMove({ globalIndex: 1, variations: [[branch]] });
    const user = userEvent.setup();
    renderWithProviders(
      <ReviewMoveList
        history={[main]}
        currentGlobalIndex={2}
        onMoveClick={() => {}}
        onSetNag={() => {}}
        onSetVariationColor={() => {}}
      />,
    );
    await user.keyboard('v');
    const palette = await screen.findByTestId('nag-palette');
    expect(palette.getAttribute('data-focus')).toBe('variationColor');
    // Секция variation-color реально отрисована (не «недоступна»).
    expect(screen.getByTestId('nag-palette-variation-color')).toBeInTheDocument();
  });

  it('"V" → "1" на ходе варианта → onSetVariationColor(idx, "green")', async () => {
    const onSetVariationColor = vi.fn();
    const branch = makeMove({ globalIndex: 2, san: 'd4', ply: 1 });
    const main = makeMove({ globalIndex: 1, variations: [[branch]] });
    const user = userEvent.setup();
    renderWithProviders(
      <ReviewMoveList
        history={[main]}
        currentGlobalIndex={2}
        onMoveClick={() => {}}
        onSetNag={() => {}}
        onSetVariationColor={onSetVariationColor}
      />,
    );
    await user.keyboard('v');
    // Дождаться, пока mount NagPalette повесит window-listener (useEffect
    // выполняется после commit). findByTestId уже это гарантирует —
    // палитра видна → effect отработал.
    await screen.findByTestId('nag-palette');
    await user.keyboard('1');
    expect(onSetVariationColor).toHaveBeenCalledTimes(1);
    expect(onSetVariationColor).toHaveBeenCalledWith(2, 'green');
  });

  it('"V" игнорируется если onSetVariationColor не передан', async () => {
    const move = makeMove({ globalIndex: 1 });
    const user = userEvent.setup();
    renderWithProviders(
      <ReviewMoveList
        history={[move]}
        currentGlobalIndex={1}
        onMoveClick={() => {}}
        onSetNag={() => {}}
      />,
    );
    await user.keyboard('v');
    expect(screen.queryByTestId('nag-palette')).not.toBeInTheDocument();
  });

  it('Ctrl+V → не открывает палитру (paste shortcut пропускаем)', async () => {
    const move = makeMove({ globalIndex: 1 });
    const user = userEvent.setup();
    renderWithProviders(
      <ReviewMoveList
        history={[move]}
        currentGlobalIndex={1}
        onMoveClick={() => {}}
        onSetNag={() => {}}
        onSetVariationColor={() => {}}
      />,
    );
    await user.keyboard('{Control>}v{/Control}');
    expect(screen.queryByTestId('nag-palette')).not.toBeInTheDocument();
  });

});
