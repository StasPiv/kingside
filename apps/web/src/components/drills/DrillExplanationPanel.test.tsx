/**
 * KS-2457. Тесты `DrillExplanationPanel` — рендер заголовка, notes,
 * клик «Дальше».
 */
import { describe, it, expect, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { renderWithProviders, screen } from '../../test/test-utils';
import { DrillExplanationPanel } from './DrillExplanationPanel';
import type { DrillExplanation } from './explanation/types';

const SAMPLE: DrillExplanation = {
  arrows: [],
  highlights: [],
  notes: [
    {
      key: 'drills.explanation.findPin.correctAbsolute',
      params: { pinnedSquare: 'e7' },
      tone: 'success',
    },
    {
      key: 'drills.explanation.findPin.wrong',
      params: { square: 'e8' },
      tone: 'wrong',
    },
  ],
};

describe('<DrillExplanationPanel> KS-2457', () => {
  it('solved=true → data-result="correct" + заголовок Correct!', () => {
    renderWithProviders(
      <DrillExplanationPanel
        explanation={SAMPLE}
        solved={true}
        onNext={() => {}}
      />,
    );
    const root = screen.getByTestId('drill-explanation-panel');
    expect(root.getAttribute('data-result')).toBe('correct');
    expect(screen.getByTestId('drill-explanation-panel-title').textContent).toMatch(
      /correct/i,
    );
  });

  it('solved=false → data-result="incorrect" + заголовок Not quite', () => {
    renderWithProviders(
      <DrillExplanationPanel
        explanation={SAMPLE}
        solved={false}
        onNext={() => {}}
      />,
    );
    expect(
      screen.getByTestId('drill-explanation-panel').getAttribute('data-result'),
    ).toBe('incorrect');
    expect(screen.getByTestId('drill-explanation-panel-title').textContent).toMatch(
      /not quite|incorrect/i,
    );
  });

  it('рендерит каждый note с корректным data-tone', () => {
    renderWithProviders(
      <DrillExplanationPanel
        explanation={SAMPLE}
        solved={false}
        onNext={() => {}}
      />,
    );
    const notes = screen.getAllByTestId('drill-explanation-note');
    expect(notes).toHaveLength(2);
    expect(notes[0].getAttribute('data-tone')).toBe('success');
    expect(notes[1].getAttribute('data-tone')).toBe('wrong');
  });

  it('пустой explanation.notes → ul не рендерится, кнопка остаётся', () => {
    renderWithProviders(
      <DrillExplanationPanel
        explanation={{ arrows: [], highlights: [], notes: [] }}
        solved={true}
        onNext={() => {}}
      />,
    );
    expect(screen.queryAllByTestId('drill-explanation-note')).toHaveLength(0);
    expect(screen.getByTestId('drill-explanation-next')).toBeInTheDocument();
  });

  it('клик «Дальше» вызывает onNext', async () => {
    const onNext = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <DrillExplanationPanel
        explanation={SAMPLE}
        solved={true}
        onNext={onNext}
      />,
    );
    await user.click(screen.getByTestId('drill-explanation-next'));
    expect(onNext).toHaveBeenCalledTimes(1);
  });
});
