import { describe, it, expect, vi } from 'vitest';
import { renderWithProviders, screen, userEvent } from '../test/test-utils';
import { NoOpponentsBlock } from './NoOpponentsBlock';

/**
 * KS-2185 — рендер блока «No opponents online».
 *
 * Проверяем сценарий 3 i18n (en) и поведение кнопок: при клике на «Try
 * again» и «Choose another time control» вызываются соответствующие
 * колбэки. Локализация ru проверяется на скриншотах + json-ключи
 * присутствуют в обоих словарях.
 */
describe('NoOpponentsBlock — KS-2185', () => {
  it('рендерит i18n тексты EN: title/subtitle/retry/changeTc', () => {
    renderWithProviders(
      <NoOpponentsBlock onRetry={() => {}} onChangeTc={() => {}} />,
    );
    expect(screen.getByTestId('no-opponents-block')).toBeInTheDocument();
    expect(screen.getByText('No opponents online')).toBeInTheDocument();
    expect(screen.getByText('Try again later or invite a friend')).toBeInTheDocument();
    expect(screen.getByTestId('no-opponents-retry')).toHaveTextContent('Try again');
    expect(screen.getByTestId('no-opponents-change-tc')).toHaveTextContent(
      'Choose another time control',
    );
  });

  it('клик по «Try again» вызывает onRetry, по «Choose another» — onChangeTc', async () => {
    const onRetry = vi.fn();
    const onChangeTc = vi.fn();
    renderWithProviders(<NoOpponentsBlock onRetry={onRetry} onChangeTc={onChangeTc} />);

    const user = userEvent.setup();
    await user.click(screen.getByTestId('no-opponents-retry'));
    await user.click(screen.getByTestId('no-opponents-change-tc'));

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onChangeTc).toHaveBeenCalledTimes(1);
  });
});
