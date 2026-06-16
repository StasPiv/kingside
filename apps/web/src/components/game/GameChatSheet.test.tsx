import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithProviders, screen, userEvent } from '../../test/test-utils';
import { GameChatSheet } from './GameChatSheet';

describe('KS-4293 / ADR-134 §4: GameChatSheet', () => {
  const baseChat = {
    messages: [
      { userId: 'me', username: 'Me', content: 'Hi' },
      { userId: 'opp', username: 'Opp', content: 'Hello' },
    ],
    currentUserId: 'me',
    onSend: vi.fn(),
  };

  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
    baseChat.onSend.mockReset();
  });

  it('при open=false возвращает null', () => {
    renderWithProviders(
      <GameChatSheet open={false} onClose={vi.fn()} chat={baseChat} />,
    );
    expect(screen.queryByTestId('game-chat-sheet')).not.toBeInTheDocument();
  });

  it('при open=true рендерит сообщения с маркировкой своих/чужих', () => {
    renderWithProviders(
      <GameChatSheet open={true} onClose={vi.fn()} chat={baseChat} />,
    );
    expect(screen.getByTestId('game-chat-sheet')).toBeInTheDocument();
    expect(screen.getByText('Hi')).toBeInTheDocument();
    expect(screen.getByText('Hello')).toBeInTheDocument();
    const own = screen.getByText('Hi').closest('.game-chat-sheet__msg');
    expect(own).toHaveClass('game-chat-sheet__msg--own');
  });

  it('клик по подложке вызывает onClose', async () => {
    const onClose = vi.fn();
    renderWithProviders(
      <GameChatSheet open={true} onClose={onClose} chat={baseChat} />,
    );
    await userEvent.click(screen.getByTestId('game-chat-sheet-overlay'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('клик по ✕ вызывает onClose', async () => {
    const onClose = vi.fn();
    renderWithProviders(
      <GameChatSheet open={true} onClose={onClose} chat={baseChat} />,
    );
    await userEvent.click(screen.getByTestId('game-chat-sheet-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('клик внутри панели не закрывает', async () => {
    const onClose = vi.fn();
    renderWithProviders(
      <GameChatSheet open={true} onClose={onClose} chat={baseChat} />,
    );
    await userEvent.click(screen.getByTestId('game-chat-sheet'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('кнопка «Отправить» отключена при пустом вводе', () => {
    renderWithProviders(
      <GameChatSheet open={true} onClose={vi.fn()} chat={baseChat} />,
    );
    expect(screen.getByTestId('game-chat-sheet-send')).toBeDisabled();
  });

  it('после ввода и клика «Отправить» вызывает chat.onSend и чистит поле', async () => {
    renderWithProviders(
      <GameChatSheet open={true} onClose={vi.fn()} chat={baseChat} />,
    );
    const input = screen.getByTestId('game-chat-sheet-input') as HTMLInputElement;
    await userEvent.type(input, 'gg');
    await userEvent.click(screen.getByTestId('game-chat-sheet-send'));
    expect(baseChat.onSend).toHaveBeenCalledWith('gg');
    expect(input.value).toBe('');
  });

  it('Enter в поле ввода также отправляет', async () => {
    renderWithProviders(
      <GameChatSheet open={true} onClose={vi.fn()} chat={baseChat} />,
    );
    const input = screen.getByTestId('game-chat-sheet-input');
    await userEvent.type(input, 'wp{Enter}');
    expect(baseChat.onSend).toHaveBeenCalledWith('wp');
  });
});
