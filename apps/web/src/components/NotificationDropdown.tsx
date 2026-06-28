import { useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
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
  // KS-4741: новый тип уведомления — публикация статьи блога.
  blog_post_published: '📝',
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
    // KS-4741: новые типы (`blog_post_published`) добавляются на бэке
    // и shared может ещё не успеть. Расширяем тип до string, чтобы
    // switch принимал любые ключи и default-ветка ловила незнакомые.
    const ntype = n.type as string;
    switch (ntype) {
      case 'message':
        navigate(p.senderId ? `/messages/${p.senderId}` : '/messages');
        break;
      case 'friend_request':
        navigate('/friends');
        break;
      case 'game_started':
        if (p.gameId) navigate(`/game/${p.gameId}`);
        break;
      // KS-4741: переход на статью блога. Префикс локали обязателен —
      // /<locale>/blog/<slug>; fallback 'en' если поле не пришло.
      case 'blog_post_published': {
        if (p.slug) {
          const locale = p.locale || 'en';
          navigate(`/${locale}/blog/${p.slug}`);
        }
        break;
      }
      default:
        // Для неизвестного типа — лучше отправить на главную, чем
        // молча закрыть колокольчик без реакции.
        navigate('/');
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
                  {renderNotificationText(n, t)}
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

function renderNotificationText(n: NotificationItem, t: TFunction): string {
  const p = n.payload as Record<string, string>;
  const ntype = n.type as string;
  switch (ntype) {
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
    // KS-4741: «Новая статья в блоге — <Title>». Title из payload,
    // i18n локализован.
    case 'blog_post_published': {
      const title = p.title || t('notifications.blog_post_published.body', 'New blog post');
      const subtitle = t('notifications.blog_post_published.body', 'New blog post');
      return `${subtitle} — ${title}`;
    }
    default:
      // Для незнакомого type — fallback на сырой type-ключ, чтобы
      // колокольчик хотя бы не падал и QA увидел что нужен новый case.
      return n.type;
  }
}
