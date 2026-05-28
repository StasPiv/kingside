import { describe, it, expect, vi } from 'vitest';
import userEvent from '@testing-library/user-event';

import { renderWithProviders, screen } from '../test/test-utils';
import { PromotionPicker } from './PromotionPicker';

/**
 * KS-3383 → KS-3395 — PromotionPicker рендерит фигуры ТЕМ ЖЕ стилем, что
 * доска для текущего pieceSet (один источник, что и `buildCustomPieces`):
 *  - кастомные наборы (chessnut и др.) → `/pieces/<set>/<code>.svg` (img);
 *  - `standard` → встроенные фигуры react-chessboard (`defaultPieces`),
 *    как на доске при `customPieces=undefined` (а НЕ chessnut-fallback).
 *
 * Проверяем:
 *  - модалка скрыта при pending=null;
 *  - кастомный набор: 4 кнопки Q/R/B/N с `/pieces/<set>/` img, не cburnett;
 *  - standard: встроенный svg react-chessboard, без `/pieces/` img;
 *  - клик по фигуре вызывает onChoice; клик по подложке — onCancel.
 */

describe('<PromotionPicker> — KS-3395 piece style matches board', () => {
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

  it('standard: рендерит встроенную фигуру react-chessboard (defaultPieces), без /pieces/ img', () => {
    // KS-3395: pieceSet='standard' → доска рисует встроенные фигуры
    // react-chessboard. Picker должен рендерить ИХ ЖЕ (defaultPieces),
    // а не chessnut-картинку. Проверяем: нет /pieces/ img, есть встроенный
    // svg в span.promotion-piece__svg--builtin.
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
      // Нет картинки кастомного набора.
      expect(btn.querySelector('img.promotion-piece__svg')).toBeNull();
      // Есть встроенный svg react-chessboard.
      const builtin = btn.querySelector('.promotion-piece__svg--builtin svg');
      expect(builtin).not.toBeNull();
      // Источник стиля совпадает с доской (pieceSet).
      expect(btn.getAttribute('data-piece-style')).toBe('standard');
    } finally {
      localStorage.removeItem('pieceSet');
    }
  });

  it('кастомный набор: data-piece-style == pieceSet, src из того же /pieces/<set>/, что доска', () => {
    // KS-3395: picker и доска (buildCustomPieces) берут один путь
    // /pieces/<set>/<code>.svg. Дефолт — chessnut.
    renderWithProviders(
      <PromotionPicker
        pending={pending}
        color="w"
        onChoice={() => {}}
        onCancel={() => {}}
      />,
    );
    const btn = screen.getByTestId('promotion-choice-b');
    expect(btn.getAttribute('data-piece-style')).toBe('chessnut');
    const img = btn.querySelector('img.promotion-piece__svg');
    expect(img?.getAttribute('src')).toBe('/pieces/chessnut/wB.svg');
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
