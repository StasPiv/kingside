import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api } from '../api';
import { useAuth } from '../context/AuthContext';
import { messagesSocket } from '../socket';
import type {
  ConversationsResponse,
  ConversationItem,
  MessageHistoryResponse,
  DirectMessageItem,
  WsNewMessagePayload,
} from '@kingside/shared';
import { MessageEvents } from '@kingside/shared';

function formatTime(dateStr: string): string {
  const d = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays === 0) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  if (diffDays < 7) {
    return d.toLocaleDateString([], { weekday: 'short' });
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export function MessagesPage() {
  const { t } = useTranslation();
  const { userId: paramUserId } = useParams<{ userId?: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();

  const [conversations, setConversations] = useState<ConversationItem[]>([]);
  const [convLoading, setConvLoading] = useState(true);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(paramUserId ?? null);
  const [selectedUsername, setSelectedUsername] = useState<string>('');

  const [messages, setMessages] = useState<DirectMessageItem[]>([]);
  const [msgLoading, setMsgLoading] = useState(false);

  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Load conversations
  useEffect(() => {
    api.get<ConversationsResponse>('/api/messages/conversations')
      .then((data) => setConversations(data.data))
      .catch(() => {})
      .finally(() => setConvLoading(false));
  }, []);

  // Select conversation from URL param
  useEffect(() => {
    if (paramUserId) {
      setSelectedUserId(paramUserId);
    }
  }, [paramUserId]);

  // Load message history when conversation selected
  useEffect(() => {
    if (!selectedUserId) return;
    setMsgLoading(true);
    api.get<MessageHistoryResponse>(`/api/messages/${selectedUserId}?limit=100`)
      .then((data) => {
        setMessages(data.data.reverse());
        // Find username from conversations or messages
        const conv = conversations.find((c) => c.user.id === selectedUserId);
        if (conv) setSelectedUsername(conv.user.username);
      })
      .catch(() => setMessages([]))
      .finally(() => setMsgLoading(false));

    // Mark as read
    api.patch<void>(`/api/messages/${selectedUserId}/read`, {}).catch(() => {});

    // Update unread count in conversations list
    setConversations((prev) =>
      prev.map((c) => c.user.id === selectedUserId ? { ...c, unreadCount: 0 } : c),
    );
  }, [selectedUserId]);

  // Scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Focus input when conversation changes
  useEffect(() => {
    if (selectedUserId) {
      inputRef.current?.focus();
    }
  }, [selectedUserId]);

  // WebSocket: listen for new messages
  useEffect(() => {
    const token = localStorage.getItem('token');
    if (!token || !user) return;

    if (!messagesSocket.connected) {
      messagesSocket.auth = { token };
      messagesSocket.connect();
    }

    const onNewMessage = (payload: WsNewMessagePayload) => {
      const otherUserId = payload.senderId === user.id ? payload.receiverId : payload.senderId;

      // If this conversation is open, add message and mark read
      if (otherUserId === selectedUserId) {
        setMessages((prev) => [...prev, payload]);
        api.patch<void>(`/api/messages/${otherUserId}/read`, {}).catch(() => {});
      }

      // Update conversations list
      setConversations((prev) => {
        const idx = prev.findIndex((c) => c.user.id === otherUserId);
        const conv: ConversationItem = {
          user: { id: otherUserId, username: payload.senderUsername },
          lastMessage: payload,
          unreadCount: otherUserId === selectedUserId ? 0 : (idx >= 0 ? prev[idx].unreadCount + 1 : 1),
        };
        if (idx >= 0) {
          const updated = [...prev];
          updated.splice(idx, 1);
          return [conv, ...updated];
        }
        return [conv, ...prev];
      });
    };

    messagesSocket.on(MessageEvents.NEW_MESSAGE, onNewMessage);

    return () => {
      messagesSocket.off(MessageEvents.NEW_MESSAGE, onNewMessage);
    };
  }, [user, selectedUserId]);

  const handleSelectConversation = useCallback((conv: ConversationItem) => {
    setSelectedUserId(conv.user.id);
    setSelectedUsername(conv.user.username);
    navigate(`/messages/${conv.user.id}`, { replace: true });
  }, [navigate]);

  const handleSend = useCallback(async () => {
    if (!text.trim() || !selectedUserId || sending) return;
    setSending(true);
    try {
      const msg = await api.post<DirectMessageItem>('/api/messages', {
        receiverId: selectedUserId,
        text: text.trim(),
      });
      setMessages((prev) => [...prev, msg]);
      setText('');

      // Update conversation list
      setConversations((prev) => {
        const idx = prev.findIndex((c) => c.user.id === selectedUserId);
        const conv: ConversationItem = {
          user: { id: selectedUserId, username: selectedUsername },
          lastMessage: msg,
          unreadCount: 0,
        };
        if (idx >= 0) {
          const updated = [...prev];
          updated.splice(idx, 1);
          return [conv, ...updated];
        }
        return [conv, ...prev];
      });
    } catch {
      // ignore
    } finally {
      setSending(false);
    }
  }, [text, selectedUserId, selectedUsername, sending]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="messages-page">
      <div className="messages-sidebar">
        <h2>{t('messages.title')}</h2>
        {convLoading ? (
          <div className="messages-loading">{t('common.loading')}</div>
        ) : conversations.length === 0 ? (
          <div className="messages-empty">{t('messages.noConversations')}</div>
        ) : (
          <div className="messages-conv-list">
            {conversations.map((conv) => (
              <button
                key={conv.user.id}
                className={`messages-conv-item${selectedUserId === conv.user.id ? ' active' : ''}${conv.unreadCount > 0 ? ' unread' : ''}`}
                onClick={() => handleSelectConversation(conv)}
              >
                <div className="messages-conv-avatar">
                  {conv.user.username[0].toUpperCase()}
                </div>
                <div className="messages-conv-info">
                  <div className="messages-conv-name">
                    {conv.user.username}
                    {conv.unreadCount > 0 && (
                      <span className="messages-conv-badge">{conv.unreadCount}</span>
                    )}
                  </div>
                  <div className="messages-conv-preview">
                    {conv.lastMessage.text.slice(0, 50)}
                  </div>
                </div>
                <div className="messages-conv-time">
                  {formatTime(conv.lastMessage.createdAt)}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="messages-chat">
        {!selectedUserId ? (
          <div className="messages-chat-placeholder">
            {t('messages.selectConversation')}
          </div>
        ) : (
          <>
            <div className="messages-chat-header">
              <Link to={`/player/${selectedUsername}`} className="messages-chat-username">
                {selectedUsername}
              </Link>
            </div>

            <div className="messages-chat-body">
              {msgLoading ? (
                <div className="messages-loading">{t('common.loading')}</div>
              ) : messages.length === 0 ? (
                <div className="messages-empty">{t('messages.noMessages')}</div>
              ) : (
                messages.map((msg) => (
                  <div
                    key={msg.id}
                    className={`messages-bubble${msg.senderId === user?.id ? ' own' : ''}`}
                  >
                    <div className="messages-bubble-text">{msg.text}</div>
                    <div className="messages-bubble-time">
                      {new Date(msg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </div>
                  </div>
                ))
              )}
              <div ref={messagesEndRef} />
            </div>

            <div className="messages-chat-input">
              <input
                ref={inputRef}
                type="text"
                placeholder={t('messages.placeholder')}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={handleKeyDown}
                disabled={sending}
              />
              <button onClick={handleSend} disabled={!text.trim() || sending}>
                {t('messages.send')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
