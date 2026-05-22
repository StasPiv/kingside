import { describe, it, expect } from 'vitest';

import { renderWithProviders, screen } from '../test/test-utils';
import { ForfeitPlaceholder } from './ForfeitPlaceholder';

/**
 * KS-3258: проверка рендера плашки forfeit.
 */
describe('<ForfeitPlaceholder>', () => {
  it('рендерит title + hint, data-termination/result атрибуты', () => {
    const pgn =
      '[Termination "Unplayed"]\n[Result "0-1"]\n\n*';
    renderWithProviders(<ForfeitPlaceholder pgn={pgn} />);
    const el = screen.getByTestId('forfeit-placeholder');
    expect(el.getAttribute('data-termination')).toBe('Unplayed');
    expect(el.getAttribute('data-result')).toBe('0-1');
    expect(el.textContent).toMatch(/Game not played/i);
    expect(screen.getByTestId('forfeit-placeholder-result').textContent).toMatch(
      /Result: 0-1/i,
    );
  });

  it('Result="*" → блок с результатом не рендерится', () => {
    const pgn = '[Termination "Unplayed"]\n[Result "*"]\n\n*';
    renderWithProviders(<ForfeitPlaceholder pgn={pgn} />);
    expect(screen.queryByTestId('forfeit-placeholder-result')).toBeNull();
  });

  it('null/empty pgn → плашка рендерится, без data-result', () => {
    renderWithProviders(<ForfeitPlaceholder pgn={null} />);
    const el = screen.getByTestId('forfeit-placeholder');
    expect(el.getAttribute('data-result')).toBe('');
    expect(el.getAttribute('data-termination')).toBe('');
  });

  it('кастомный testId переопределяет default', () => {
    const pgn = '[Result "1-0"]\n\n*';
    renderWithProviders(
      <ForfeitPlaceholder pgn={pgn} testId="custom-forfeit" />,
    );
    expect(screen.getByTestId('custom-forfeit')).toBeInTheDocument();
    expect(screen.queryByTestId('forfeit-placeholder')).toBeNull();
  });
});
