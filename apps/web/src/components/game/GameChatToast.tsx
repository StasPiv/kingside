import { useEffect, useState } from 'react';

/**
 * KS-4293 / ADR-134 §4: уведомление о новом сообщении соперника
 * у верхнего края `.player-info.opponent-info`. Появляется при
 * закрытой панели чата и `status='active'`; на post-game (finished)
 * не показывается — пользователь занят выбором действия.
 *
 * Видимостью управляет родитель (`GameShell`): передаёт текущее
 * сообщение через `message`; на смену `message` компонент сам
 * перезапускает таймер 4 с и в конце вызывает `onTimeout`. Тап по
 * тосту вызывает `onClick` — родитель открывает панель чата.
 */

const TOAST_DURATION_MS = 4000;
const MAX_CHARS = 40;

export interface GameChatToastProps {
  /**
   * Сообщение для показа. При `null` тост не виден. При изменении
   * объекта (новое сообщение) таймер перезапускается.
   */
  message: { username: string; content: string; id: string } | null;
  onTimeout: () => void;
  onClick: () => void;
}

export function GameChatToast({ message, onTimeout, onClick }: GameChatToastProps) {
  // ключ для useEffect — id сообщения, чтобы таймер перезапускался
  // именно на _новое_ сообщение, а не на любой ре-рендер.
  const [shown, setShown] = useState<typeof message>(null);

  useEffect(() => {
    if (!message) {
      setShown(null);
      return;
    }
    setShown(message);
    const timer = setTimeout(() => {
      onTimeout();
    }, TOAST_DURATION_MS);
    return () => clearTimeout(timer);
  }, [message?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!shown) return null;

  const truncated =
    shown.content.length > MAX_CHARS
      ? shown.content.slice(0, MAX_CHARS - 1) + '…'
      : shown.content;

  return (
    <button
      type="button"
      className="game-chat-toast"
      data-testid="game-chat-toast"
      onClick={onClick}
    >
      <strong className="game-chat-toast__author">{shown.username}</strong>
      <span className="game-chat-toast__text">{truncated}</span>
    </button>
  );
}
