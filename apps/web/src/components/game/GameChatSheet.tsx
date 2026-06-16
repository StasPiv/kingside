import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { GameChatProps } from './GameShell';

/**
 * KS-4293 / ADR-134 §4: нижняя выдвижная панель игрового чата для
 * мобильной вёрстки страницы игры (≤899px). Заменяет настольную
 * `.chat`-панель в `.game-sidebar`, которая на mobile уезжала ниже
 * фолда.
 *
 * - Управляемое состояние открытия (`open`/`onClose`).
 * - Drag-handle сверху, движение вниз > порога — закрытие.
 * - Подложка с затемнением и `backdrop-blur`; клик по подложке
 *   закрывает панель.
 * - Сообщения, автопрокрутка к последнему при открытии и при
 *   появлении новых сообщений.
 * - Поле ввода + кнопка «Отправить» внутри панели (sticky внизу,
 *   учитывает safe-area). На время открытия panel перекрывает
 *   action-bar, отдельной интеграции не требуется — сам sheet
 *   рендерится через `position: fixed` поверх всего.
 *
 * На desktop ≥900px компонент CSS-правилом скрыт (`.game-chat-sheet`
 * по умолчанию `display: none`, включается в @media `max-width: 899px`).
 */

const SWIPE_DOWN_THRESHOLD_PX = 70;

export interface GameChatSheetProps {
  open: boolean;
  onClose: () => void;
  chat: GameChatProps;
}

export function GameChatSheet({ open, onClose, chat }: GameChatSheetProps) {
  const { t } = useTranslation();
  const [input, setInput] = useState('');
  const [dragOffset, setDragOffset] = useState(0);
  const dragStartYRef = useRef<number | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  // Автопрокрутка к последнему сообщению при открытии и при
  // появлении новых сообщений (когда панель открыта).
  useEffect(() => {
    if (!open) return;
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [open, chat.messages.length]);

  if (!open) return null;

  const handleTouchStart = (e: React.TouchEvent) => {
    dragStartYRef.current = e.touches[0]?.clientY ?? null;
    setDragOffset(0);
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (dragStartYRef.current == null) return;
    const currentY = e.touches[0]?.clientY ?? dragStartYRef.current;
    const delta = currentY - dragStartYRef.current;
    setDragOffset(Math.max(0, delta));
  };

  const handleTouchEnd = () => {
    if (dragStartYRef.current == null) return;
    if (dragOffset > SWIPE_DOWN_THRESHOLD_PX) onClose();
    dragStartYRef.current = null;
    setDragOffset(0);
  };

  const handleSend = () => {
    const text = input.trim();
    if (!text) return;
    chat.onSend(text);
    setInput('');
  };

  return (
    <div
      className="game-chat-sheet-overlay"
      data-testid="game-chat-sheet-overlay"
      onClick={onClose}
    >
      <div
        className="game-chat-sheet"
        data-testid="game-chat-sheet"
        style={dragOffset > 0 ? { transform: `translateY(${dragOffset}px)` } : undefined}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="game-chat-sheet__handle-area"
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
          aria-label={t('gameChat.dragToClose', 'Drag down to close')}
        >
          <span className="game-chat-sheet__handle" />
        </div>
        <div className="game-chat-sheet__header">
          <h3 className="game-chat-sheet__title">
            {t('game.chat', 'Chat')}
          </h3>
          <button
            type="button"
            className="game-chat-sheet__close"
            data-testid="game-chat-sheet-close"
            onClick={onClose}
            aria-label={t('common.close', 'Close')}
          >
            ✕
          </button>
        </div>
        <div className="game-chat-sheet__messages" data-testid="game-chat-sheet-messages">
          {chat.messages.map((msg, i) => (
            <div
              key={i}
              className={`game-chat-sheet__msg${msg.userId === chat.currentUserId ? ' game-chat-sheet__msg--own' : ''}`}
            >
              <strong className="game-chat-sheet__msg-author">
                {msg.username}
              </strong>
              <span className="game-chat-sheet__msg-text">{msg.content}</span>
            </div>
          ))}
          <div ref={endRef} />
        </div>
        <div className="game-chat-sheet__input">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && input.trim()) {
                e.preventDefault();
                handleSend();
              }
            }}
            placeholder={t('game.chatPlaceholder', 'Type a message…')}
            data-testid="game-chat-sheet-input"
            aria-label={t('game.chatPlaceholder', 'Type a message…')}
          />
          <button
            type="button"
            className="game-chat-sheet__send"
            data-testid="game-chat-sheet-send"
            onClick={handleSend}
            disabled={!input.trim()}
          >
            {t('game.chatSend', 'Send')}
          </button>
        </div>
      </div>
    </div>
  );
}
