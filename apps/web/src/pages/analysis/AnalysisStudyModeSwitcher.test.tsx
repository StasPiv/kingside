import { describe, it, expect, vi } from 'vitest';
import { fireEvent } from '@testing-library/react';

import { renderWithProviders, screen } from '../../test/test-utils';
import { AnalysisStudyModeSwitcher } from './AnalysisStudyModeSwitcher';

/**
 * KS-2870 (ADR-060 §3.3 FM1) — unit-тесты mode-switcher'а.
 */

describe('<AnalysisStudyModeSwitcher> (KS-2870)', () => {
  it('рендерит dropdown с 4 режимами', () => {
    renderWithProviders(
      <AnalysisStudyModeSwitcher
        chapterMode="analysis"
        concealPly={null}
        onChapterModeChange={vi.fn()}
        onConcealPlyChange={vi.fn()}
      />,
    );
    const select = screen.getByTestId('analysis-study-mode-select');
    expect(select).toBeInTheDocument();
    const options = select.querySelectorAll('option');
    expect(options.length).toBe(4);
    expect(Array.from(options).map((o) => o.value)).toEqual([
      'analysis',
      'practice',
      'conceal',
      'gamebook',
    ]);
  });

  it('текущий режим выставлен в select', () => {
    renderWithProviders(
      <AnalysisStudyModeSwitcher
        chapterMode="practice"
        concealPly={null}
        onChapterModeChange={vi.fn()}
        onConcealPlyChange={vi.fn()}
      />,
    );
    const select = screen.getByTestId(
      'analysis-study-mode-select',
    ) as HTMLSelectElement;
    expect(select.value).toBe('practice');
  });

  it('change → onChapterModeChange с новым значением', () => {
    const onChange = vi.fn();
    renderWithProviders(
      <AnalysisStudyModeSwitcher
        chapterMode="analysis"
        concealPly={null}
        onChapterModeChange={onChange}
        onConcealPlyChange={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByTestId('analysis-study-mode-select'), {
      target: { value: 'practice' },
    });
    expect(onChange).toHaveBeenCalledWith('practice');
  });

  it('change на тот же режим — НЕ вызывает callback', () => {
    const onChange = vi.fn();
    renderWithProviders(
      <AnalysisStudyModeSwitcher
        chapterMode="practice"
        concealPly={null}
        onChapterModeChange={onChange}
        onConcealPlyChange={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByTestId('analysis-study-mode-select'), {
      target: { value: 'practice' },
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('conceal-input показывается ТОЛЬКО при mode=conceal', () => {
    const { rerender } = renderWithProviders(
      <AnalysisStudyModeSwitcher
        chapterMode="analysis"
        concealPly={null}
        onChapterModeChange={vi.fn()}
        onConcealPlyChange={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('analysis-study-mode-conceal')).toBeNull();
    rerender(
      <AnalysisStudyModeSwitcher
        chapterMode="conceal"
        concealPly={5}
        onChapterModeChange={vi.fn()}
        onConcealPlyChange={vi.fn()}
      />,
    );
    expect(screen.getByTestId('analysis-study-mode-conceal')).toBeInTheDocument();
  });

  it('conceal-input commit по blur → onConcealPlyChange', () => {
    const onPlyChange = vi.fn();
    renderWithProviders(
      <AnalysisStudyModeSwitcher
        chapterMode="conceal"
        concealPly={3}
        onChapterModeChange={vi.fn()}
        onConcealPlyChange={onPlyChange}
      />,
    );
    const input = screen.getByTestId(
      'analysis-study-mode-conceal-input',
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '7' } });
    fireEvent.blur(input);
    expect(onPlyChange).toHaveBeenCalledWith(7);
  });

  it('conceal-input commit по Enter → onConcealPlyChange', () => {
    const onPlyChange = vi.fn();
    renderWithProviders(
      <AnalysisStudyModeSwitcher
        chapterMode="conceal"
        concealPly={3}
        onChapterModeChange={vi.fn()}
        onConcealPlyChange={onPlyChange}
      />,
    );
    const input = screen.getByTestId('analysis-study-mode-conceal-input');
    fireEvent.change(input, { target: { value: '10' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onPlyChange).toHaveBeenCalledWith(10);
  });

  it('conceal-input: пустое/невалидное значение — callback НЕ вызывается', () => {
    const onPlyChange = vi.fn();
    renderWithProviders(
      <AnalysisStudyModeSwitcher
        chapterMode="conceal"
        concealPly={3}
        onChapterModeChange={vi.fn()}
        onConcealPlyChange={onPlyChange}
      />,
    );
    const input = screen.getByTestId('analysis-study-mode-conceal-input');
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    expect(onPlyChange).not.toHaveBeenCalled();
  });

  it('gamebook button показывается ТОЛЬКО при mode=gamebook', () => {
    const { rerender } = renderWithProviders(
      <AnalysisStudyModeSwitcher
        chapterMode="analysis"
        concealPly={null}
        onChapterModeChange={vi.fn()}
        onConcealPlyChange={vi.fn()}
        onEditGamebook={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('analysis-study-mode-edit-gamebook')).toBeNull();
    rerender(
      <AnalysisStudyModeSwitcher
        chapterMode="gamebook"
        concealPly={null}
        onChapterModeChange={vi.fn()}
        onConcealPlyChange={vi.fn()}
        onEditGamebook={vi.fn()}
      />,
    );
    expect(
      screen.getByTestId('analysis-study-mode-edit-gamebook'),
    ).toBeInTheDocument();
  });

  it('gamebook button click → onEditGamebook', () => {
    const onEdit = vi.fn();
    renderWithProviders(
      <AnalysisStudyModeSwitcher
        chapterMode="gamebook"
        concealPly={null}
        onChapterModeChange={vi.fn()}
        onConcealPlyChange={vi.fn()}
        onEditGamebook={onEdit}
      />,
    );
    fireEvent.click(screen.getByTestId('analysis-study-mode-edit-gamebook'));
    expect(onEdit).toHaveBeenCalled();
  });

  it('readOnly=true → select disabled, callback не вызывается', () => {
    const onChange = vi.fn();
    renderWithProviders(
      <AnalysisStudyModeSwitcher
        chapterMode="analysis"
        concealPly={null}
        onChapterModeChange={onChange}
        onConcealPlyChange={vi.fn()}
        readOnly
      />,
    );
    const select = screen.getByTestId(
      'analysis-study-mode-select',
    ) as HTMLSelectElement;
    expect(select.disabled).toBe(true);
  });

  it('readOnly=true + conceal — input disabled', () => {
    renderWithProviders(
      <AnalysisStudyModeSwitcher
        chapterMode="conceal"
        concealPly={5}
        onChapterModeChange={vi.fn()}
        onConcealPlyChange={vi.fn()}
        readOnly
      />,
    );
    const input = screen.getByTestId(
      'analysis-study-mode-conceal-input',
    ) as HTMLInputElement;
    expect(input.disabled).toBe(true);
  });
});
