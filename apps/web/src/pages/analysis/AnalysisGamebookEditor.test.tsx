import { describe, it, expect, vi } from 'vitest';
import { fireEvent } from '@testing-library/react';

import { renderWithProviders, screen } from '../../test/test-utils';
import { AnalysisGamebookEditor } from './AnalysisGamebookEditor';

/**
 * KS-2873 (ADR-060 §3.3 R4 FM4) — unit-тесты gamebook-редактора.
 */

describe('<AnalysisGamebookEditor> (KS-2873)', () => {
  it('placeholder когда currentUci=null', () => {
    renderWithProviders(
      <AnalysisGamebookEditor
        currentUci={null}
        gamebook={null}
        editable
        onChange={vi.fn()}
      />,
    );
    expect(
      screen.getByTestId('analysis-gamebook-placeholder'),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('analysis-gamebook-node')).toBeNull();
  });

  it('рендерит 3 textarea при выбранном UCI', () => {
    renderWithProviders(
      <AnalysisGamebookEditor
        currentUci="e2e4"
        gamebook={null}
        editable
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByTestId('analysis-gamebook-node')).toBeInTheDocument();
    expect(screen.getByTestId('analysis-gamebook-hint-input')).toBeInTheDocument();
    expect(screen.getByTestId('analysis-gamebook-success-input')).toBeInTheDocument();
    expect(screen.getByTestId('analysis-gamebook-failure-input')).toBeInTheDocument();
  });

  it('preпопулирует поля из gamebook.byUci[uci]', () => {
    renderWithProviders(
      <AnalysisGamebookEditor
        currentUci="e2e4"
        gamebook={{
          byUci: { e2e4: { hint: 'H', success: 'S', failure: 'F' } },
        }}
        editable
        onChange={vi.fn()}
      />,
    );
    expect(
      (screen.getByTestId('analysis-gamebook-hint-input') as HTMLTextAreaElement)
        .value,
    ).toBe('H');
    expect(
      (screen.getByTestId('analysis-gamebook-success-input') as HTMLTextAreaElement)
        .value,
    ).toBe('S');
    expect(
      (screen.getByTestId('analysis-gamebook-failure-input') as HTMLTextAreaElement)
        .value,
    ).toBe('F');
  });

  it('blur по hint → onChange с обновлённым payload', () => {
    const onChange = vi.fn();
    renderWithProviders(
      <AnalysisGamebookEditor
        currentUci="e2e4"
        gamebook={null}
        editable
        onChange={onChange}
      />,
    );
    const input = screen.getByTestId('analysis-gamebook-hint-input');
    fireEvent.change(input, { target: { value: 'Try e4 first' } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledTimes(1);
    const arg = onChange.mock.calls[0][0];
    expect(arg.byUci.e2e4.hint).toBe('Try e4 first');
  });

  it('пустое значение во всех полях → запись удаляется (не считается нодой)', () => {
    const onChange = vi.fn();
    renderWithProviders(
      <AnalysisGamebookEditor
        currentUci="e2e4"
        gamebook={{
          byUci: { e2e4: { hint: 'old' } },
        }}
        editable
        onChange={onChange}
      />,
    );
    const input = screen.getByTestId('analysis-gamebook-hint-input');
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledTimes(1);
    const arg = onChange.mock.calls[0][0];
    expect(arg.byUci.e2e4).toBeUndefined();
  });

  it('editable=false → все textarea disabled', () => {
    renderWithProviders(
      <AnalysisGamebookEditor
        currentUci="e2e4"
        gamebook={null}
        editable={false}
        onChange={vi.fn()}
      />,
    );
    expect(
      (screen.getByTestId('analysis-gamebook-hint-input') as HTMLTextAreaElement)
        .disabled,
    ).toBe(true);
    expect(
      (screen.getByTestId('analysis-gamebook-success-input') as HTMLTextAreaElement)
        .disabled,
    ).toBe(true);
    expect(
      (screen.getByTestId('analysis-gamebook-failure-input') as HTMLTextAreaElement)
        .disabled,
    ).toBe(true);
  });

  it('intro toggle открывает intro textarea и blur коммитит', () => {
    const onChange = vi.fn();
    renderWithProviders(
      <AnalysisGamebookEditor
        currentUci={null}
        gamebook={null}
        editable
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByTestId('analysis-gamebook-intro-toggle'));
    const introInput = screen.getByTestId('analysis-gamebook-intro-input');
    fireEvent.change(introInput, { target: { value: 'Welcome' } });
    fireEvent.blur(introInput);
    expect(onChange).toHaveBeenCalledWith({ intro: 'Welcome' });
  });

  it('счётчик узлов отображается; atLimit=true при ≥200 узлов', () => {
    const byUci: Record<string, { hint?: string }> = {};
    for (let i = 0; i < 200; i++) {
      byUci[`uci${i}`] = { hint: 'x' };
    }
    renderWithProviders(
      <AnalysisGamebookEditor
        currentUci="newuci"
        gamebook={{ byUci }}
        editable
        onChange={vi.fn()}
      />,
    );
    const counter = screen.getByTestId('analysis-gamebook-count');
    expect(counter.getAttribute('data-at-limit')).toBe('true');
    // newuci нет в payload → блокировка добавления полей.
    expect(
      (screen.getByTestId('analysis-gamebook-hint-input') as HTMLTextAreaElement)
        .disabled,
    ).toBe(true);
    expect(screen.getByTestId('analysis-gamebook-limit-msg')).toBeInTheDocument();
  });

  it('atLimit + существующая нода — поля редактируемы', () => {
    const byUci: Record<string, { hint?: string }> = {};
    for (let i = 0; i < 200; i++) {
      byUci[`uci${i}`] = { hint: 'x' };
    }
    renderWithProviders(
      <AnalysisGamebookEditor
        currentUci="uci0"
        gamebook={{ byUci }}
        editable
        onChange={vi.fn()}
      />,
    );
    // uci0 уже есть в payload → можно редактировать.
    expect(
      (screen.getByTestId('analysis-gamebook-hint-input') as HTMLTextAreaElement)
        .disabled,
    ).toBe(false);
  });
});
