/**
 * KS-3592. Тесты `MaterialBalance` — корректный рендер фигурок по
 * `pieceSet` из `BoardSettingsContext`.
 *
 * Корень бага: для `standard` старый код шёл в `/pieces/cburnett/`, но
 * этой папки в `public/pieces/` нет (`celtic/chessnut/fantasy/firi/...`)
 * — 404 → битые `<img>`. После KS-3592 для `standard` рендерится
 * встроенный SVG `defaultPieces` react-chessboard (как в PromotionPicker
 * после KS-3395), для кастомных наборов — `/pieces/<set>/<code>.svg`.
 */
import { describe, it, expect, vi } from 'vitest';

import { MaterialBalance } from './MaterialBalance';
import { renderWithProviders, screen } from '../test/test-utils';

const { mockUseBoardSettings } = vi.hoisted(() => ({
  mockUseBoardSettings: vi.fn(),
}));
vi.mock('../hooks/useBoardSettings', () => ({
  useBoardSettings: () => mockUseBoardSettings(),
}));

const STARTPOS = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
// Белые без коня b1, ладьи a1 — у чёрных перевес: +R, +N.
const ADVANTAGE_BLACK = '1nbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/2BQKBNR w KQkq - 0 1';
// У белых лишний ферзь.
const ADVANTAGE_WHITE = 'rn2kbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

describe('<MaterialBalance> KS-3592', () => {
  it('равный материал → ничего не рендерится', () => {
    mockUseBoardSettings.mockReturnValue({ pieceSet: 'standard' });
    const { container } = renderWithProviders(
      <MaterialBalance fen={STARTPOS} />,
    );
    expect(container.querySelector('.material-balance')).toBeNull();
  });

  it('pieceSet=standard → встроенные defaultPieces (не битые <img>)', () => {
    mockUseBoardSettings.mockReturnValue({ pieceSet: 'standard' });
    const { container } = renderWithProviders(
      <MaterialBalance fen={ADVANTAGE_BLACK} />,
    );
    const root = container.querySelector('.material-balance');
    expect(root).toBeTruthy();
    // standard → нет <img>, только <span class="material-balance__piece--builtin">.
    expect(root!.querySelectorAll('img')).toHaveLength(0);
    expect(
      root!.querySelectorAll('.material-balance__piece--builtin').length,
    ).toBeGreaterThanOrEqual(1);
  });

  it('кастомный pieceSet → <img src="/pieces/<set>/<code>.svg">', () => {
    mockUseBoardSettings.mockReturnValue({ pieceSet: 'chessnut' });
    const { container } = renderWithProviders(
      <MaterialBalance fen={ADVANTAGE_WHITE} />,
    );
    const imgs = container.querySelectorAll('img.material-balance__piece');
    expect(imgs.length).toBeGreaterThanOrEqual(1);
    for (const img of imgs) {
      const src = img.getAttribute('src');
      expect(src).toMatch(/^\/pieces\/chessnut\//);
      expect(src).toMatch(/\.svg$/);
      // Нет битого `/pieces/cburnett/` (старый bug).
      expect(src).not.toMatch(/cburnett/);
    }
  });

  it('кастомный pieceSet=firi → правильный путь', () => {
    mockUseBoardSettings.mockReturnValue({ pieceSet: 'firi' });
    renderWithProviders(<MaterialBalance fen={ADVANTAGE_BLACK} />);
    const imgs = document.querySelectorAll('img.material-balance__piece');
    expect(imgs.length).toBeGreaterThan(0);
    for (const img of imgs) {
      expect(img.getAttribute('src')).toMatch(/^\/pieces\/firi\//);
    }
  });
});
