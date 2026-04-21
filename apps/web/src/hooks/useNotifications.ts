import { useState, useEffect, useCallback } from 'react';
import { api } from '../api';
import { messagesSocket } from '../socket';
import {
  NotificationEvents,
  type NotificationItem,
  type NotificationsResponse,
  type NotificationUnreadCountResponse,
} from '@kingside/shared';

export function useNotifications(enabled: boolean) {
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(false);

  // Fetch unread count
  const fetchUnreadCount = useCallback(async () => {
    if (!enabled) return;
    try {
      const data = await api.get<NotificationUnreadCountResponse>('/notifications/unread-count');
      setUnreadCount(data.count);
    } catch { /* ignore */ }
  }, [enabled]);

  // Fetch full list
  const fetchNotifications = useCallback(async () => {
    if (!enabled) return;
    setLoading(true);
    try {
      const data = await api.get<NotificationsResponse>('/notifications');
      setNotifications(data.data);
    } catch { /* ignore */ }
    setLoading(false);
  }, [enabled]);

  // Mark one as read
  const markAsRead = useCallback(async (id: string) => {
    try {
      await api.put(`/notifications/${id}/read`, {});
      setNotifications((prev) =>
        prev.map((n) => (n.id === id ? { ...n, read: true } : n)),
      );
      setUnreadCount((prev) => Math.max(0, prev - 1));
    } catch { /* ignore */ }
  }, []);

  // Mark all as read
  const markAllAsRead = useCallback(async () => {
    try {
      await api.put('/notifications/read-all', {});
      setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
      setUnreadCount(0);
    } catch { /* ignore */ }
  }, []);

  // Fetch count on mount
  useEffect(() => {
    fetchUnreadCount();
  }, [fetchUnreadCount]);

  // WebSocket: listen for new notifications
  useEffect(() => {
    if (!enabled) return;
    const onNew = (notification: NotificationItem) => {
      setNotifications((prev) => [notification, ...prev]);
      setUnreadCount((prev) => prev + 1);
    };
    messagesSocket.on(NotificationEvents.NEW, onNew);

    // Re-fetch count on reconnect (catches missed events)
    const onConnect = () => { fetchUnreadCount(); };
    messagesSocket.on('connect', onConnect);

    // Listen for external refresh requests (e.g. MessagesPage marked messages as read)
    const onRefresh = () => { fetchUnreadCount(); };
    window.addEventListener('notifications:refresh', onRefresh);

    return () => {
      messagesSocket.off(NotificationEvents.NEW, onNew);
      messagesSocket.off('connect', onConnect);
      window.removeEventListener('notifications:refresh', onRefresh);
    };
  }, [enabled, fetchUnreadCount]);

  return {
    notifications,
    unreadCount,
    loading,
    fetchNotifications,
    markAsRead,
    markAllAsRead,
  };
}
