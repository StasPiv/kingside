import { useEffect, useRef } from 'react';
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

export function NotificationDropdown({
  notifications,
  loading,
  onClose,
  onMarkAsRead,
  onMarkAllAsRead,
}: NotificationDropdownProps) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);

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
              onClick={() => { if (!n.read) onMarkAsRead(n.id); }}
            >
              <span className="notification-item__icon">{TYPE_ICONS[n.type] || '🔔'}</span>
              <div className="notification-item__body">
                <span className="notification-item__text">
                  {formatNotificationText(n, t)}
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function formatNotificationText(
  n: NotificationItem,
  t: any,
): string {
  const p = n.payload as Record<string, string>;
  switch (n.type) {
    case 'challenge_received':
      return t('notifications.challengeReceived', 'Challenge from {{from}}', { from: p.from || 'someone' });
    case 'friend_request':
      return t('notifications.friendRequest', 'Friend request from {{from}}', { from: p.from || 'someone' });
    case 'game_started':
      return t('notifications.gameStarted', 'Game started vs {{opponent}}', { opponent: p.opponent || 'opponent' });
    case 'message':
      return t('notifications.newMessage', 'Message from {{from}}', { from: p.from || 'someone' });
    default:
      return n.type;
  }
}
