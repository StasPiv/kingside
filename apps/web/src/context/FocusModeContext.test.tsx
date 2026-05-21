import { describe, it, expect } from 'vitest';
import { render, fireEvent } from '@testing-library/react';

import { FocusModeProvider, useFocusMode } from './FocusModeContext';

/**
 * KS-3188 (ADR-073 §7 F1): smoke-тесты для `FocusModeContext`.
 */

function Consumer() {
  const { active, enable, disable } = useFocusMode();
  return (
    <div>
      <span data-testid="active">{String(active)}</span>
      <button type="button" data-testid="enable" onClick={enable}>
        enable
      </button>
      <button type="button" data-testid="disable" onClick={disable}>
        disable
      </button>
    </div>
  );
}

describe('FocusModeContext (KS-3188)', () => {
  it('по умолчанию active=false; enable() → true, disable() → false', () => {
    const { getByTestId } = render(
      <FocusModeProvider>
        <Consumer />
      </FocusModeProvider>,
    );
    expect(getByTestId('active').textContent).toBe('false');

    fireEvent.click(getByTestId('enable'));
    expect(getByTestId('active').textContent).toBe('true');

    fireEvent.click(getByTestId('disable'));
    expect(getByTestId('active').textContent).toBe('false');
  });

  it('без Provider — useFocusMode возвращает безопасный noop (active=false, enable/disable не падают)', () => {
    const { getByTestId } = render(<Consumer />);
    // active=false из NOOP_CONTEXT.
    expect(getByTestId('active').textContent).toBe('false');
    // Клики не падают и не меняют state — noop.
    fireEvent.click(getByTestId('enable'));
    fireEvent.click(getByTestId('disable'));
    expect(getByTestId('active').textContent).toBe('false');
  });
});
