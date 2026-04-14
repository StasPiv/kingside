import { createContext, useContext, useState, useCallback, useRef, type ReactNode } from 'react';
import type { ChatMessage } from '../hooks/useChatStream';

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3001';

type ChatContextType = {
  open: boolean;
  setOpen: (v: boolean) => void;
  messages: ChatMessage[];
  streaming: boolean;
  conversationId: string | null;
  sendMessage: (text: string) => Promise<void>;
  stopStreaming: () => void;
  loadConversation: (id: string) => Promise<void>;
  newConversation: () => void;
};

const ChatContext = createContext<ChatContextType | null>(null);

export function ChatProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const sendMessage = useCallback(async (text: string) => {
    if (!text.trim() || streaming) return;
    const userMsg: ChatMessage = { role: 'user', content: text };
    setMessages((prev) => [...prev, userMsg, { role: 'assistant', content: '' }]);
    setStreaming(true);

    const token = localStorage.getItem('token');
    const controller = new AbortController();
    abortRef.current = controller;
    let fullText = '';

    try {
      const res = await fetch(`${API_URL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ message: text, conversationId }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const convId = res.headers.get('X-Conversation-Id');
      if (convId) setConversationId(convId);

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
    } catch (err) {
      if (err instanceof Error && err.name !== 'AbortError') {
        setMessages((prev) => { const u = [...prev]; u[u.length - 1] = { role: 'assistant', content: `⚠️ ${err.message}` }; return u; });
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }, [streaming, conversationId]);

  const stopStreaming = useCallback(() => { abortRef.current?.abort(); }, []);

  const loadConversation = useCallback(async (convId: string) => {
    const token = localStorage.getItem('token');
    try {
      const res = await fetch(`${API_URL}/api/chat/conversations/${convId}`, {
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
    <ChatContext.Provider value={{ open, setOpen, messages, streaming, conversationId, sendMessage, stopStreaming, loadConversation, newConversation }}>
      {children}
    </ChatContext.Provider>
  );
}

export function useChat() {
  const ctx = useContext(ChatContext);
  if (!ctx) throw new Error('useChat must be used within ChatProvider');
  return ctx;
}
