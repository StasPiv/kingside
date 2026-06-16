import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderWithProviders, screen, userEvent } from '../../test/test-utils';
import { GameChatToast } from './GameChatToast';

describe('KS-4293 / ADR-134 §4: GameChatToast', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('null message — ничего не рендерит', () => {
    renderWithProviders(
      <GameChatToast message={null} onTimeout={vi.fn()} onClick={vi.fn()} />,
    );
    expect(screen.queryByTestId('game-chat-toast')).not.toBeInTheDocument();
  });

  it('показывает имя и текст; обрезает длинный текст до 40 символов', () => {
    const long = 'a'.repeat(60);
    renderWithProviders(
      <GameChatToast
        message={{ id: 'm1', username: 'Opp', content: long }}
        onTimeout={vi.fn()}
        onClick={vi.fn()}
      />,
    );
    expect(screen.getByTestId('game-chat-toast')).toBeInTheDocument();
    expect(screen.getByText('Opp')).toBeInTheDocument();
    // 39 'a' + '…' = 40 символов.
    expect(screen.getByText('a'.repeat(39) + '…')).toBeInTheDocument();
  });

  it('через 4 с автоматически вызывает onTimeout', async () => {
    const onTimeout = vi.fn();
    renderWithProviders(
      <GameChatToast
        message={{ id: 'm1', username: 'Opp', content: 'gg' }}
        onTimeout={onTimeout}
        onClick={vi.fn()}
      />,
    );
    expect(onTimeout).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(4000);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it('клик вызывает onClick', async () => {
    vi.useRealTimers(); // userEvent несовместим с fake timers
    const onClick = vi.fn();
    renderWithProviders(
      <GameChatToast
        message={{ id: 'm1', username: 'Opp', content: 'gg' }}
        onTimeout={vi.fn()}
        onClick={onClick}
      />,
    );
    await userEvent.click(screen.getByTestId('game-chat-toast'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
