import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../context/AuthContext';
import { useChat } from '../context/ChatContext';
import { useFeatureFlag } from '../context/FeatureFlagsContext';
import { api } from '../api';
import { renderMarkdown } from '../utils/simpleMarkdown';

type Conversation = { id: string; title: string | null; updatedAt: string };

export function ChatWidget() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { user } = useAuth();
  // KS-2228: runtime feature-flag (backend `GET /config`).
  // Default `assistantEnabled=false` — иконка чата скрыта у всех,
  // включается админом через PATCH /admin/feature-flags/assistantEnabled.
  const assistantEnabled = useFeatureFlag('assistantEnabled');
  const { open, setOpen, messages, streaming, usage, rateLimitEnd, sendMessage, stopStreaming, loadConversation, newConversation } = useChat();
  const [countdown, setCountdown] = useState(0);
  useEffect(() => {
    if (!rateLimitEnd) { setCountdown(0); return; }
    const tick = () => setCountdown(Math.max(0, Math.ceil((rateLimitEnd - Date.now()) / 1000)));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [rateLimitEnd]);
  const [showHistory, setShowHistory] = useState(false);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [input, setInput] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Intercept internal link clicks for SPA navigation
  const handlePanelClick = useCallback((e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest('a[data-internal]');
    if (a) {
      e.preventDefault();
      const href = a.getAttribute('href');
      if (href) navigate(href);
    }
  }, [navigate]);

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Focus input when panel opens
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const fetchConversations = useCallback(async () => {
    try {
      const data = await api.get<Conversation[]>('/chat/conversations');
      setConversations(Array.isArray(data) ? data : []);
    } catch { setConversations([]); }
  }, []);

  const handleToggleHistory = () => {
    if (!showHistory) fetchConversations();
    setShowHistory(!showHistory);
  };

  const handleSend = () => {
    if (!input.trim() || streaming) return;
    sendMessage(input.trim());
    setInput('');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // KS-2228: при `assistantEnabled=false` (runtime, default) — null,
  // никаких placeholder'ов или оборачивающих контейнеров (см. MainLayout —
  // ChatWidget рендерится напрямую без wrapper'а с padding'ом).
  if (!assistantEnabled) return null;
  if (!user || import.meta.env.VITE_AI_CHAT_ENABLED === 'false') return null;

  return (
    <>
      {!open && (
        <button className="chat-widget-btn" onClick={() => setOpen(true)} title={t('chat.title', 'AI Assistant')}>
          💬
        </button>
      )}

      {open && (
        <div className="chat-panel" onClick={handlePanelClick}>
          <div className="chat-panel__header">
            <span className="chat-panel__title">{t('chat.title', 'AI Assistant')}</span>
            <div className="chat-panel__actions">
              <button onClick={() => { newConversation(); setShowHistory(false); }} title={t('chat.new', 'New chat')}>+</button>
              <button onClick={handleToggleHistory} title={t('chat.history', 'History')}>☰</button>
              <button onClick={() => setOpen(false)} title={t('common.close', 'Close')}>×</button>
            </div>
          </div>

          {showHistory ? (
            <div className="chat-panel__history">
              {conversations.length === 0 ? (
                <p className="chat-panel__empty">{t('chat.noConversations', 'No conversations yet')}</p>
              ) : (
                conversations.map((c) => (
                  <button
                    key={c.id}
                    className="chat-history-item"
                    onClick={() => { loadConversation(c.id); setShowHistory(false); }}
                  >
                    <span>{c.title || t('chat.untitled', 'Chat')}</span>
                    <span className="chat-history-item__date">{new Date(c.updatedAt).toLocaleDateString()}</span>
                  </button>
                ))
              )}
            </div>
          ) : (
            <>
              <div className="chat-panel__messages">
                {messages.length === 0 && (
                  <div className="chat-panel__welcome">
                    <p>{t('chat.welcome', 'Ask me anything about chess!')}</p>
                  </div>
                )}
                {messages.map((msg, i) => (
                  <div key={i} className={`chat-msg chat-msg--${msg.role}`}>
                    {msg.role === 'assistant' ? (
                      <div className="chat-msg__content chat-msg__md" dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.content || (streaming && i === messages.length - 1 ? '...' : '')) }} />
                    ) : (
                      <div className="chat-msg__content">{msg.content}</div>
                    )}
                  </div>
                ))}
                <div ref={messagesEndRef} />
              </div>

              {countdown > 0 && (
                <div className="chat-rate-limit">
                  {t('chat.rateLimited', 'Limit reached. Try again in {{seconds}}s', { seconds: countdown })}
                </div>
              )}
              <div className="chat-panel__input">
                {usage && <span className="chat-usage-badge">{usage.used}/{usage.limit}</span>}
                <textarea
                  ref={inputRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder={countdown > 0 ? t('chat.rateLimitedShort', 'Limit reached') : t('chat.placeholder', 'Type a message...')}
                  rows={1}
                  disabled={streaming || countdown > 0}
                />
                {streaming ? (
                  <button className="chat-send-btn" onClick={stopStreaming}>⏹</button>
                ) : (
                  <button className="chat-send-btn" onClick={handleSend} disabled={!input.trim() || countdown > 0}>➤</button>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
}
