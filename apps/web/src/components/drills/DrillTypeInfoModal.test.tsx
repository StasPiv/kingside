import { describe, it, expect, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { renderWithProviders, screen } from '../../test/test-utils';
import { DrillTypeInfoModal } from './DrillTypeInfoModal';

/**
 * KS-2418 — DrillTypeInfoModal в режимах onboarding и help.
 *
 * Smoke-тесты:
 *  - оба варианта рендерят корректный текст из i18n.
 *  - кнопка-confirm и Escape вызывают onClose с правильным reason.
 *  - help-вариант имеет крестик закрытия, onboarding — нет.
 */
describe('<DrillTypeInfoModal> KS-2418', () => {
  it('variant=onboarding: показывает короткое объяснение и кнопку «Got it»', () => {
    const onClose = vi.fn();
    renderWithProviders(
      <DrillTypeInfoModal
        drillType="find-fork"
        variant="onboarding"
        onClose={onClose}
      />,
    );
    const modal = screen.getByTestId('drill-info-modal');
    expect(modal.getAttribute('data-drill-type')).toBe('find-fork');
    expect(screen.getByTestId('drill-info-overlay').getAttribute('data-variant')).toBe(
      'onboarding',
    );
    // Body содержит i18n-текст onboarding для find-fork.
    expect(screen.getByTestId('drill-info-modal').textContent).toContain(
      'Time to set up forks',
    );
    expect(
      screen.getByTestId('drill-info-modal-confirm').textContent,
    ).toContain('Got it');
    // В onboarding-mode крестика нет.
    expect(
      screen.queryByTestId('drill-info-modal-close'),
    ).not.toBeInTheDocument();
  });

  it('variant=help: показывает расширенное описание с секциями', () => {
    const onClose = vi.fn();
    renderWithProviders(
      <DrillTypeInfoModal
        drillType="find-pin"
        variant="help"
        onClose={onClose}
      />,
    );
    const body = screen.getByTestId('drill-info-modal');
    // Заголовок = название drill-типа из drills.types.findPin.
    expect(body.textContent).toContain('Pin');
    // One-liner.
    expect(body.textContent).toContain('Find the pinned piece');
    // Секции: что тренируем + как отвечать.
    expect(body.textContent).toContain('What it trains');
    expect(body.textContent).toContain('How to answer');
    // Закрытие через крестик.
    expect(screen.getByTestId('drill-info-modal-close')).toBeInTheDocument();
  });

  it('confirm-кнопка → onClose("confirm")', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <DrillTypeInfoModal
        drillType="find-fork"
        variant="onboarding"
        onClose={onClose}
      />,
    );
    await user.click(screen.getByTestId('drill-info-modal-confirm'));
    expect(onClose).toHaveBeenCalledWith('confirm');
  });

  it('Escape → onClose("dismiss")', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <DrillTypeInfoModal
        drillType="find-pin"
        variant="help"
        onClose={onClose}
      />,
    );
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledWith('dismiss');
  });

  it('клик по overlay → onClose("dismiss")', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <DrillTypeInfoModal
        drillType="find-pin"
        variant="help"
        onClose={onClose}
      />,
    );
    await user.click(screen.getByTestId('drill-info-overlay'));
    expect(onClose).toHaveBeenCalledWith('dismiss');
  });
});
