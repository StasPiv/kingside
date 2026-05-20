import { describe, it, expect } from 'vitest';
import { renderWithProviders, screen } from '../../test/test-utils';
import { PuzzleObjectiveBadge } from './PuzzleObjectiveBadge';

/**
 * KS-3146 (ADR-069 §3.2): badge с иконкой и подписью жанра пазла.
 */
describe('<PuzzleObjectiveBadge>', () => {
  it('convertAdvantage → 👑 + подпись из puzzle.objective.convertAdvantage', () => {
    renderWithProviders(<PuzzleObjectiveBadge objective="convertAdvantage" />);
    const badge = screen.getByTestId('puzzle-objective-badge');
    expect(badge).toBeInTheDocument();
    expect(badge.getAttribute('data-objective')).toBe('convertAdvantage');
    expect(badge.textContent).toContain('👑');
    // Подпись приходит из i18n; проверяем наличие непустого текста после
    // иконки (не fallback-ключ).
    expect(badge.textContent).not.toContain('puzzle.objective.convertAdvantage');
  });

  it('saveEquality → ⚖️ + подпись из puzzle.objective.saveEquality', () => {
    renderWithProviders(<PuzzleObjectiveBadge objective="saveEquality" />);
    const badge = screen.getByTestId('puzzle-objective-badge');
    expect(badge.getAttribute('data-objective')).toBe('saveEquality');
    expect(badge.textContent).toContain('⚖️');
    expect(badge.textContent).not.toContain('puzzle.objective.saveEquality');
  });

  it('objective=null → возвращает null (legacy-пазлы без поля)', () => {
    const { container } = renderWithProviders(
      <PuzzleObjectiveBadge objective={null} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('objective=undefined → null', () => {
    const { container } = renderWithProviders(
      <PuzzleObjectiveBadge objective={undefined} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('size="sm" → класс puzzle-objective-badge--sm', () => {
    renderWithProviders(
      <PuzzleObjectiveBadge objective="convertAdvantage" size="sm" />,
    );
    const badge = screen.getByTestId('puzzle-objective-badge');
    expect(badge.className).toContain('puzzle-objective-badge--sm');
  });

  it('testId override', () => {
    renderWithProviders(
      <PuzzleObjectiveBadge objective="saveEquality" testId="custom-id" />,
    );
    expect(screen.getByTestId('custom-id')).toBeInTheDocument();
  });
});
