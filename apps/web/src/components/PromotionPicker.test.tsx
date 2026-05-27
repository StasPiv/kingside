import { describe, it, expect, vi } from 'vitest';
import userEvent from '@testing-library/user-event';

import { renderWithProviders, screen } from '../test/test-utils';
import { PromotionPicker } from './PromotionPicker';

/**
 * KS-3383 — PromotionPicker отображает SVG-фигуры из piece-set.
 *
 * Главная регрессия, ради которой задача: в KS-3320 удалён `cburnett`
 * piece-set (GPL → конфликт лицензий), но fallback в PromotionPicker
 * для `pieceSet === 'standard'` (внутренний react-chessboard SVG)
 * оставался на `/pieces/cburnett/*.svg`. В проде это давало 404 →
 * broken-image иконки в модалке выбора фигуры при превращении.
 *
 * Проверяем:
 *  - модалка скрыта при pending=null;
 *  - при pending — рендерятся 4 кнопки Q/R/B/N с SVG-фигурами;
 *  - src НИКОГДА не указывает на удалённый `cburnett` piece-set;
 *  - клик по фигуре вызывает onChoice с правильной буквой;
 *  - клик по подложке вызывает onCancel.
 */

describe('<PromotionPicker> — KS-3383 SVG icons rendering', () => {
  const pending = { from: 'e7', to: 'e8' } as const;

  it('возвращает null, если pending=null', () => {
    const { container } = renderWithProviders(
      <PromotionPicker
        pending={null}
        color="w"
        onChoice={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('рендерит 4 кнопки Q/R/B/N с SVG-картинками', () => {
    renderWithProviders(
      <PromotionPicker
        pending={pending}
        color="w"
        onChoice={() => {}}
        onCancel={() => {}}
      />,
    );

    for (const piece of ['q', 'r', 'b', 'n'] as const) {
      const btn = screen.getByTestId(`promotion-choice-${piece}`);
      const img = btn.querySelector('img.promotion-piece__svg');
      expect(img).not.toBeNull();
      const src = img!.getAttribute('src') ?? '';
      expect(src).toMatch(/^\/pieces\/[\w-]+\/[wb][QRBN]\.svg$/);
      // KS-3383: cburnett удалён в KS-3320, fallback не должен туда вести.
      expect(src).not.toContain('/cburnett/');
    }
  });

  it('src фигуры использует именно chessnut при дефолтных настройках', () => {
    // BoardSettingsProvider дефолтит pieceSet → 'chessnut' (KS-3320).
    // Здесь проверяем, что путь к SVG корректно формируется для штатного
    // пользовательского состояния (а не падает на удалённый cburnett).
    renderWithProviders(
      <PromotionPicker
        pending={pending}
        color="w"
        onChoice={() => {}}
        onCancel={() => {}}
      />,
    );

    const btn = screen.getByTestId('promotion-choice-q');
    const img = btn.querySelector('img.promotion-piece__svg');
    expect(img?.getAttribute('src')).toBe('/pieces/chessnut/wQ.svg');
  });

  it('fallback на chessnut при сохранённом pieceSet=standard в localStorage', () => {
    // Имитируем юзера, у которого в LS лежит `standard` (валидный
    // PieceSetId, но без своих SVG-файлов). Раньше шёл 404 на cburnett.
    localStorage.setItem('pieceSet', 'standard');
    try {
      renderWithProviders(
        <PromotionPicker
          pending={pending}
          color="b"
          onChoice={() => {}}
          onCancel={() => {}}
        />,
      );
      const btn = screen.getByTestId('promotion-choice-r');
      const img = btn.querySelector('img.promotion-piece__svg');
      expect(img?.getAttribute('src')).toBe('/pieces/chessnut/bR.svg');
    } finally {
      localStorage.removeItem('pieceSet');
    }
  });

  it('клик по фигуре вызывает onChoice с правильной буквой', async () => {
    const onChoice = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <PromotionPicker
        pending={pending}
        color="w"
        onChoice={onChoice}
        onCancel={() => {}}
      />,
    );

    await user.click(screen.getByTestId('promotion-choice-n'));
    expect(onChoice).toHaveBeenCalledWith('n');
  });

  it('клик по подложке вызывает onCancel, клик по диалогу — нет', async () => {
    const onCancel = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <PromotionPicker
        pending={pending}
        color="w"
        onChoice={() => {}}
        onCancel={onCancel}
      />,
    );

    // Клик внутри диалога — не должен закрыть.
    await user.click(screen.getByTestId('promotion-choice-b').parentElement!);
    expect(onCancel).not.toHaveBeenCalled();

    // Клик по overlay — закрывает.
    await user.click(screen.getByTestId('promotion-overlay'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
