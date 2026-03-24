import { useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { NotificationItem } from '@kingside/shared';

interface NotificationDropdownProps {
  notifications: NotificationItem[];
  loading: boolean;
  onClose: () => void;
  onMarkAsRead: (id: string) => void;
  onMarkAllAsRead: () => void;
}

function formatTimeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

const TYPE_ICONS: Record<string, string> = {
  challenge_received: '⚔️',
  friend_request: '👥',
  game_started: '♟️',
  message: '✉️',
};

function formatTimeControl(initial: number, increment: number): string {
  const mins = Math.floor(initial / 60);
  return increment > 0 ? `${mins}+${increment}` : `${mins} min`;
}

export function NotificationDropdown({
  notifications,
  loading,
  onClose,
  onMarkAsRead,
  onMarkAllAsRead,
}: NotificationDropdownProps) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  // Close on click outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  const handleClick = useCallback((n: NotificationItem) => {
    if (!n.read) onMarkAsRead(n.id);
    const p = n.payload as Record<string, string>;
    switch (n.type) {
      case 'message':
        navigate(p.senderId ? `/messages/${p.senderId}` : '/messages');
        break;
      case 'friend_request':
        navigate('/friends');
        break;
      case 'game_started':
        if (p.gameId) navigate(`/game/${p.gameId}`);
        break;
      default:
        break;
    }
    onClose();
  }, [onMarkAsRead, navigate, onClose]);

  const hasUnread = notifications.some((n) => !n.read);

  return (
    <div className="notification-dropdown" ref={ref}>
      <div className="notification-dropdown__header">
        <span className="notification-dropdown__title">
          {t('notifications.title', 'Notifications')}
        </span>
        {hasUnread && (
          <button className="notification-dropdown__mark-all" onClick={onMarkAllAsRead}>
            {t('notifications.markAllRead', 'Mark all read')}
          </button>
        )}
      </div>
      <div className="notification-dropdown__list">
        {loading ? (
          <div className="notification-dropdown__empty">
            {t('common.loading', 'Loading...')}
          </div>
        ) : notifications.length === 0 ? (
          <div className="notification-dropdown__empty">
            {t('notifications.empty', 'No notifications')}
          </div>
        ) : (
          notifications.map((n) => (
            <div
              key={n.id}
              className={`notification-item${n.read ? '' : ' notification-item--unread'}`}
              onClick={() => handleClick(n)}
            >
              <span className="notification-item__icon">{TYPE_ICONS[n.type] || '🔔'}</span>
              <div className="notification-item__body">
                <span className="notification-item__text">
                  {renderNotificationText(n)}
                </span>
                <span className="notification-item__time">{formatTimeAgo(n.createdAt)}</span>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function renderNotificationText(n: NotificationItem): string {
  const p = n.payload as Record<string, string>;
  switch (n.type) {
    case 'message': {
      const sender = p.senderUsername || p.from || 'Someone';
      const preview = p.preview ? `: ${p.preview.slice(0, 50)}` : '';
      return `${sender}${preview}`;
    }
    case 'friend_request': {
      const from = p.fromUsername || p.from || 'Someone';
      return `${from} wants to be your friend`;
    }
    case 'challenge_received': {
      const from = p.fromUsername || p.from || 'Someone';
      const tc = p.timeInitial ? ` (${formatTimeControl(Number(p.timeInitial), Number(p.increment || 0))})` : '';
      return `${from} challenges you${tc}`;
    }
    case 'game_started': {
      const opponent = p.opponent || p.opponentUsername || 'opponent';
      return `Game started vs ${opponent}`;
    }
    default:
      return n.type;
  }
}
