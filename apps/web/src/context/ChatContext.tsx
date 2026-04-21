import { createContext, useContext, useState, useCallback, useRef, useEffect, type ReactNode } from 'react';
import type { ChatMessage } from '../hooks/useChatStream';

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3001';

type ChatUsage = { used: number; limit: number } | null;

type ChatContextType = {
  open: boolean;
  setOpen: (v: boolean) => void;
  messages: ChatMessage[];
  streaming: boolean;
  conversationId: string | null;
  usage: ChatUsage;
  rateLimitEnd: number | null; // timestamp ms
  sendMessage: (text: string) => Promise<void>;
  stopStreaming: () => void;
  loadConversation: (id: string) => Promise<void>;
  newConversation: () => void;
  fetchUsage: () => Promise<void>;
};

const ChatContext = createContext<ChatContextType | null>(null);

export function ChatProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [usage, setUsage] = useState<ChatUsage>(null);
  const [rateLimitEnd, setRateLimitEnd] = useState<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const fetchUsage = useCallback(async () => {
    const token = localStorage.getItem('token');
    if (!token) return;
    try {
      const res = await fetch(`${API_URL}/chat/limits`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        setUsage({ used: data.used ?? 0, limit: data.limit ?? 100 });
      }
    } catch { /* ignore */ }
  }, []);

  // Fetch usage when chat opens
  useEffect(() => {
    if (open) fetchUsage();
  }, [open, fetchUsage]);

  // Clear rate limit when timer expires
  useEffect(() => {
    if (!rateLimitEnd) return;
    const remaining = rateLimitEnd - Date.now();
    if (remaining <= 0) { setRateLimitEnd(null); return; }
    const timer = setTimeout(() => setRateLimitEnd(null), remaining);
    return () => clearTimeout(timer);
  }, [rateLimitEnd]);

  const sendMessage = useCallback(async (text: string) => {
    if (!text.trim() || streaming || rateLimitEnd) return;
    const userMsg: ChatMessage = { role: 'user', content: text };
    setMessages((prev) => [...prev, userMsg, { role: 'assistant', content: '' }]);
    setStreaming(true);

    const token = localStorage.getItem('token');
    const controller = new AbortController();
    abortRef.current = controller;
    let fullText = '';

    try {
      const res = await fetch(`${API_URL}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ message: text, conversationId, currentPage: window.location.pathname }),
        signal: controller.signal,
      });

      if (res.status === 429) {
        const retryAfter = parseInt(res.headers.get('Retry-After') || '60', 10);
        setRateLimitEnd(Date.now() + retryAfter * 1000);
        setMessages((prev) => { const u = [...prev]; u[u.length - 1] = { role: 'assistant', content: '' }; return u.slice(0, -1); }); // remove empty assistant msg
        throw new Error('rate_limit');
      }

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const convId = res.headers.get('X-Conversation-Id');
      if (convId) setConversationId(convId);

      const contentType = res.headers.get('Content-Type') || '';

      if (contentType.includes('application/json')) {
        const data = await res.json();
        if (data.conversationId) setConversationId(data.conversationId);
        fullText = data.response || data.text || '';
        setMessages((prev) => { const u = [...prev]; u[u.length - 1] = { role: 'assistant', content: fullText }; return u; });
      } else {
        const reader = res.body?.getReader();
        if (!reader) throw new Error('No reader');
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            try {
              const data = JSON.parse(line.slice(6));
              if (data.text) {
                fullText += data.text;
                setMessages((prev) => { const u = [...prev]; u[u.length - 1] = { role: 'assistant', content: fullText }; return u; });
              }
              if (data.conversationId) setConversationId(data.conversationId);
              if (data.error) {
                fullText += `\n\n⚠️ ${data.error}`;
                setMessages((prev) => { const u = [...prev]; u[u.length - 1] = { role: 'assistant', content: fullText }; return u; });
              }
            } catch { /* ignore */ }
          }
        }
      }

      // Update usage after successful message
      setUsage((u) => u ? { ...u, used: u.used + 1 } : u);
    } catch (err) {
      if (err instanceof Error && err.name !== 'AbortError' && err.message !== 'rate_limit') {
        setMessages((prev) => { const u = [...prev]; u[u.length - 1] = { role: 'assistant', content: `⚠️ ${err.message}` }; return u; });
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }, [streaming, conversationId, rateLimitEnd]);

  const stopStreaming = useCallback(() => { abortRef.current?.abort(); }, []);

  const loadConversation = useCallback(async (convId: string) => {
    const token = localStorage.getItem('token');
    try {
      const res = await fetch(`${API_URL}/chat/conversations/${convId}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) return;
      const data = await res.json();
      setConversationId(convId);
      setMessages((data.messages ?? []).map((m: { role: string; content: string }) => ({ role: m.role as 'user' | 'assistant', content: m.content })));
    } catch { /* ignore */ }
  }, []);

  const newConversation = useCallback(() => { setConversationId(null); setMessages([]); }, []);

  return (
    <ChatContext.Provider value={{ open, setOpen, messages, streaming, conversationId, usage, rateLimitEnd, sendMessage, stopStreaming, loadConversation, newConversation, fetchUsage }}>
      {children}
    </ChatContext.Provider>
  );
}

export function useChat() {
  const ctx = useContext(ChatContext);
  if (!ctx) throw new Error('useChat must be used within ChatProvider');
  return ctx;
}
