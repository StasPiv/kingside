import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * KS-4009 / ADR-121 Phase 1 §3. Капсула «чат» для верхней полосы
 * счётчиков лекции (рядом с `LecturePublisherStatusBadge` /
 * `LectureRecordingBadge`).
 *
 * Поведение:
 *   - Всегда видна на мобильном при активной лекции (тренер и зритель).
 *   - Показывает число непрочитанных. 99+ — обрезаем как «99+».
 *   - При появлении новых непрочитанных — пульс-анимация 1.2 сек,
 *     дальше затухает до статичного состояния.
 *   - По клику зовёт `onOpen()` (родитель открывает bottom-sheet).
 *
 * Источник числа непрочитанных — родитель: компонент намеренно
 * stateless по unread-count'у, потому что считать его правильно
 * можно только зная состояние шторки и текущее положение в ленте.
 */

export interface ChatBadgeIndicatorProps {
  /** Непрочитанные сообщения. 0 → стандартный значок без счётчика. */
  unreadCount: number;
  /** true если открытие лекции (для accessibility-aria). */
  isLive: boolean;
  /** Открыть шторку чата. */
  onOpen: () => void;
  /** Доп. класс. */
  className?: string;
}

export function ChatBadgeIndicator({
  unreadCount,
  isLive,
  onOpen,
  className,
}: ChatBadgeIndicatorProps) {
  const { t } = useTranslation();
  const [pulse, setPulse] = useState(false);
  const prevUnreadRef = useRef(unreadCount);

  useEffect(() => {
    const prev = prevUnreadRef.current;
    prevUnreadRef.current = unreadCount;
    if (unreadCount > prev) {
      setPulse(true);
      const id = setTimeout(() => setPulse(false), 1_200);
      return () => clearTimeout(id);
    }
  }, [unreadCount]);

  const display =
    unreadCount === 0 ? null : unreadCount > 99 ? '99+' : String(unreadCount);

  return (
    <button
      type="button"
      data-testid="chat-badge-indicator"
      data-unread={unreadCount > 0 ? 'true' : 'false'}
      data-pulse={pulse ? 'true' : 'false'}
      onClick={onOpen}
      className={['chat-badge-indicator', className].filter(Boolean).join(' ')}
      aria-label={t('lectureChat.openAria', 'Open lecture chat')}
      aria-live={isLive ? 'polite' : 'off'}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 10px',
        background: unreadCount > 0 ? '#e3f2fd' : '#f1f3f5',
        color: '#1e88e5',
        border: '1px solid ' + (unreadCount > 0 ? '#90caf9' : '#dde1e4'),
        borderRadius: 16,
        fontSize: 12,
        fontWeight: 600,
        cursor: 'pointer',
        animation: pulse
          ? 'chat-badge-pulse 0.6s ease-in-out 2'
          : undefined,
      }}
    >
      <span aria-hidden="true" style={{ fontSize: 14, lineHeight: 1 }}>
        💬
      </span>
      <span>{t('lectureChat.shortLabel', 'Chat')}</span>
      {display !== null && (
        <span
          data-testid="chat-badge-count"
          style={{
            background: '#1e88e5',
            color: '#fff',
            borderRadius: 10,
            minWidth: 18,
            padding: '0 5px',
            textAlign: 'center',
            fontSize: 11,
          }}
        >
          {display}
        </span>
      )}
      <style>{`
        @keyframes chat-badge-pulse {
          0%, 100% { transform: scale(1); }
          50% { transform: scale(1.08); }
        }
      `}</style>
    </button>
  );
}
