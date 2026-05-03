import { describe, it, expect } from 'vitest';
import { renderWithProviders, screen } from '../../test/test-utils';
import { DrillInstructions } from './DrillInstructions';

describe('<DrillInstructions>', () => {
  it('рендерит children', () => {
    renderWithProviders(
      <DrillInstructions>Найди все атакующие фигуры</DrillInstructions>,
    );
    const el = screen.getByTestId('drill-instructions');
    expect(el).toBeInTheDocument();
    expect(el.textContent).toBe('Найди все атакующие фигуры');
  });

  it('по умолчанию tone="info"', () => {
    renderWithProviders(<DrillInstructions>x</DrillInstructions>);
    const el = screen.getByTestId('drill-instructions');
    expect(el.getAttribute('data-tone')).toBe('info');
    expect(el.className).toContain('drill-instructions--info');
  });

  it.each(['info', 'success', 'error'] as const)(
    'tone="%s" → data-tone и BEM-модификатор',
    (tone) => {
      renderWithProviders(<DrillInstructions tone={tone}>x</DrillInstructions>);
      const el = screen.getByTestId('drill-instructions');
      expect(el.getAttribute('data-tone')).toBe(tone);
      expect(el.className).toContain(`drill-instructions--${tone}`);
    },
  );

  it('role="status" — для live-region скринридера', () => {
    renderWithProviders(<DrillInstructions>x</DrillInstructions>);
    expect(screen.getByTestId('drill-instructions').getAttribute('role')).toBe(
      'status',
    );
  });

  it('children может быть ReactNode', () => {
    renderWithProviders(
      <DrillInstructions>
        <strong data-testid="bold">Bold</strong> text
      </DrillInstructions>,
    );
    expect(screen.getByTestId('bold')).toBeInTheDocument();
  });
});
