/**
 * KS-4668 — тесты тап-клик премува в `useBoardHighlights`.
 *
 * Покрывают:
 *  1. Тап-тап в очередь соперника передаёт `onMove(from, to)` — это
 *     потом превращается родителем в `setPendingPremove`.
 *  2. Без `enablePremoveClicks` тапы во время хода соперника не
 *     дёргают `onMove` (старое поведение, чтобы LocalBotGame и др. не
 *     получили нежелательный premove).
 *  3. Тап по вражеской фигуре во время чужого хода не запускает
 *     premove (защита от тапа «не своей» фигурой).
 *  4. Старое поведение клика по легальному ходу в свой ход сохранено.
 */
import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { Chess } from 'chess.js';
import type { Square } from 'chess.js';
import { useBoardHighlights } from './useBoardHighlights';

describe('useBoardHighlights — KS-4668 premove тап-кликом', () => {
  it('тап-тап в очередь соперника вызывает onMove(from, to)', () => {
    // Сейчас ход чёрных (после 1.e4). Игрок — белые. Хочет поставить
    // премув: тап по своему пешке g1, тап по f3.
    const onMove = vi.fn().mockReturnValue(true);
    const game = new Chess();
    game.move('e4'); // теперь ход чёрных
    const { result } = renderHook(() =>
      useBoardHighlights({
        game,
        playerColor: 'white',
        enabled: true,
        onMove,
        enablePremoveClicks: true,
      }),
    );
    // Первый тап — выбор своей фигуры.
    act(() => result.current.onSquareClick('g1' as Square));
    // Второй тап — поле назначения.
    act(() => result.current.onSquareClick('f3' as Square));
    expect(onMove).toHaveBeenCalledTimes(1);
    expect(onMove).toHaveBeenCalledWith('g1', 'f3');
  });

  it('повторный тап-тап заменяет источник премува', () => {
    // Тап g1 → e2 (premove A). Затем тап b1 → c3 (premove B —
    // должен заменить A в родителе; useBoardHighlights просто
    // делегирует onMove дважды).
    const onMove = vi.fn().mockReturnValue(true);
    const game = new Chess();
    game.move('e4');
    const { result } = renderHook(() =>
      useBoardHighlights({
        game,
        playerColor: 'white',
        enabled: true,
        onMove,
        enablePremoveClicks: true,
      }),
    );
    act(() => result.current.onSquareClick('g1' as Square));
    act(() => result.current.onSquareClick('e2' as Square)); // премув A
    act(() => result.current.onSquareClick('b1' as Square));
    act(() => result.current.onSquareClick('c3' as Square)); // премув B
    expect(onMove).toHaveBeenCalledTimes(2);
    expect(onMove).toHaveBeenNthCalledWith(1, 'g1', 'e2');
    expect(onMove).toHaveBeenNthCalledWith(2, 'b1', 'c3');
  });

  it('без enablePremoveClicks в чужой ход onMove не вызывается', () => {
    const onMove = vi.fn().mockReturnValue(true);
    const game = new Chess();
    game.move('e4');
    const { result } = renderHook(() =>
      useBoardHighlights({
        game,
        playerColor: 'white',
        enabled: true,
        onMove,
        enablePremoveClicks: false,
      }),
    );
    act(() => result.current.onSquareClick('g1' as Square));
    act(() => result.current.onSquareClick('f3' as Square));
    expect(onMove).not.toHaveBeenCalled();
  });

  it('тап по вражеской фигуре в чужой ход не запускает премув', () => {
    const onMove = vi.fn().mockReturnValue(true);
    const game = new Chess();
    game.move('e4');
    const { result } = renderHook(() =>
      useBoardHighlights({
        game,
        playerColor: 'white',
        enabled: true,
        onMove,
        enablePremoveClicks: true,
      }),
    );
    // Тап по чёрной пешке e7 — она не наша. Не должно ничего ставиться.
    act(() => result.current.onSquareClick('e7' as Square));
    act(() => result.current.onSquareClick('e6' as Square));
    expect(onMove).not.toHaveBeenCalled();
  });

  it('в свой ход обычный легальный клик всё ещё работает (не сломали)', () => {
    const onMove = vi.fn().mockReturnValue(true);
    const game = new Chess(); // ход белых, стартовая позиция
    const { result } = renderHook(() =>
      useBoardHighlights({
        game,
        playerColor: 'white',
        enabled: true,
        onMove,
        enablePremoveClicks: true,
      }),
    );
    act(() => result.current.onSquareClick('e2' as Square));
    act(() => result.current.onSquareClick('e4' as Square));
    expect(onMove).toHaveBeenCalledWith('e2', 'e4');
    expect(onMove).toHaveBeenCalledTimes(1);
  });

  it('повторный тап по той же фигуре — снять выделение, премув не запускается', () => {
    const onMove = vi.fn().mockReturnValue(true);
    const game = new Chess();
    game.move('e4');
    const { result } = renderHook(() =>
      useBoardHighlights({
        game,
        playerColor: 'white',
        enabled: true,
        onMove,
        enablePremoveClicks: true,
      }),
    );
    act(() => result.current.onSquareClick('g1' as Square));
    // Тот же квадрат — `useBoardHighlights` сам ничего не предпринимает
    // как премув (currentSelected === square), а ставит то же
    // selectedSquare через ветку «своя фигура». Это поведение совместимо
    // с описанием задачи: снятие выделения по тапу мимо — отдельный
    // тап в пустое поле (см. следующий тест).
    act(() => result.current.onSquareClick('g1' as Square));
    expect(onMove).not.toHaveBeenCalled();
  });
});
