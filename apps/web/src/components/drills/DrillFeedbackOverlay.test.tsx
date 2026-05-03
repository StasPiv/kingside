import { describe, it, expect } from 'vitest';
import { renderWithProviders, screen } from '../../test/test-utils';
import { DrillFeedbackOverlay } from './DrillFeedbackOverlay';

describe('<DrillFeedbackOverlay>', () => {
  it('result=null → ничего не рендерится', () => {
    const { container } = renderWithProviders(
      <DrillFeedbackOverlay result={null} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('result=undefined → ничего не рендерится', () => {
    const { container } = renderWithProviders(
      <DrillFeedbackOverlay result={undefined} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('result="correct" → div с data-result="correct" + класс', () => {
    renderWithProviders(<DrillFeedbackOverlay result="correct" />);
    const el = screen.getByTestId('drill-feedback');
    expect(el.getAttribute('data-result')).toBe('correct');
    expect(el.className).toContain('drill-feedback--correct');
  });

  it('result="incorrect" → div с data-result="incorrect" + класс', () => {
    renderWithProviders(<DrillFeedbackOverlay result="incorrect" />);
    const el = screen.getByTestId('drill-feedback');
    expect(el.getAttribute('data-result')).toBe('incorrect');
    expect(el.className).toContain('drill-feedback--incorrect');
  });

  it('aria-live="polite" + дефолтный aria-label', () => {
    renderWithProviders(<DrillFeedbackOverlay result="correct" />);
    const el = screen.getByTestId('drill-feedback');
    expect(el.getAttribute('aria-live')).toBe('polite');
    expect(el.getAttribute('aria-label')).toBe('Correct');
  });

  it('кастомный label переопределяет default', () => {
    renderWithProviders(
      <DrillFeedbackOverlay result="incorrect" label="Неверно, попробуй ещё" />,
    );
    expect(screen.getByTestId('drill-feedback').getAttribute('aria-label')).toBe(
      'Неверно, попробуй ещё',
    );
  });
});
