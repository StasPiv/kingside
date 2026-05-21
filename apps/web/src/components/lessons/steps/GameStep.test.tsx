import { describe, it, expect, vi } from 'vitest';
import { fireEvent } from '@testing-library/react';
import type { GameStepPayload } from '@kingside/shared';

import { renderWithProviders, screen } from '../../../test/test-utils';
import { GameStep } from './GameStep';

/**
 * KS-3182 (ADR-072 §7 F2): шаг «Партия» в lesson view.
 *
 * AnalysisPage — тяжёлый компонент (Stockfish/board/tree/...); мочим
 * его лёгкой заглушкой, чтобы проверить только контракт `<GameStep>`:
 *  - embedded AnalysisPage получает `embeddedPgn`;
 *  - CTA «Я разобрал партию» вызывает `onStepDone()`;
 *  - повторный клик — no-op (кнопка блокируется);
 *  - `stepState='done'` сразу рендерит «Пройдено ✓».
 */

vi.mock('../../../pages/AnalysisPage', () => ({
  AnalysisPage: ({
    embedded,
    embeddedPgn,
  }: {
    embedded?: boolean;
    embeddedPgn?: string;
  }) => (
    <div
      data-testid="analysis-page-mock"
      data-embedded={embedded ? 'true' : 'false'}
      data-pgn-len={String((embeddedPgn ?? '').length)}
    />
  ),
}));

function mkPayload(over: Partial<GameStepPayload> = {}): GameStepPayload {
  return {
    type: 'game',
    sourceType: 'pgn',
    pgn: '[White "X"]\n[Black "Y"]\n\n1. e4 e5',
    ...over,
  };
}

describe('<GameStep> (KS-3182)', () => {
  it('рендерит embedded AnalysisPage и CTA «Я разобрал партию»', () => {
    const onStepDone = vi.fn();
    renderWithProviders(
      <GameStep payload={mkPayload()} onStepDone={onStepDone} />,
    );

    const viewer = screen.getByTestId('analysis-page-mock');
    expect(viewer.getAttribute('data-embedded')).toBe('true');
    expect(Number(viewer.getAttribute('data-pgn-len'))).toBeGreaterThan(0);

    const done = screen.getByTestId('lesson-game-step-done');
    expect(done.textContent).toMatch(/reviewed|разобрал/i);
    fireEvent.click(done);
    expect(onStepDone).toHaveBeenCalledTimes(1);
  });

  it('повторный клик не дёргает onStepDone (защита от двойного POST progress)', () => {
    const onStepDone = vi.fn();
    renderWithProviders(
      <GameStep payload={mkPayload()} onStepDone={onStepDone} />,
    );
    const done = screen.getByTestId('lesson-game-step-done');
    fireEvent.click(done);
    fireEvent.click(done);
    fireEvent.click(done);
    // После первого клика кнопка disabled (optimistic confirmed=true) —
    // следующие клики ничего не делают.
    expect(onStepDone).toHaveBeenCalledTimes(1);
  });

  it('stepState="done" → CTA сразу в состоянии «Пройдено» и disabled', () => {
    const onStepDone = vi.fn();
    renderWithProviders(
      <GameStep
        payload={mkPayload()}
        onStepDone={onStepDone}
        stepState="done"
      />,
    );
    const done = screen.getByTestId('lesson-game-step-done') as HTMLButtonElement;
    expect(done.disabled).toBe(true);
    expect(done.textContent).toMatch(/✓/);
    fireEvent.click(done);
    expect(onStepDone).not.toHaveBeenCalled();
  });

  it('hideNext=true → CTA не рендерится (preview-режим)', () => {
    renderWithProviders(
      <GameStep payload={mkPayload()} hideNext onStepDone={vi.fn()} />,
    );
    expect(screen.queryByTestId('lesson-game-step-done')).toBeNull();
  });

  it('пустой PGN → плашка «партия не привязана», без AnalysisPage', () => {
    renderWithProviders(
      <GameStep
        payload={mkPayload({ pgn: '   ' })}
        onStepDone={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('analysis-page-mock')).toBeNull();
    expect(screen.getByTestId('lesson-game-step-empty')).toBeTruthy();
  });
});
