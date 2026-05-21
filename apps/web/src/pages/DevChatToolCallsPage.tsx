import { ChatToolCalls } from '../components/ChatToolCalls';
import type { ToolCallEvent } from '../hooks/useChatStream';

/**
 * KS-3210 (ADR-074 §10 F1): dev-страница для acceptance-скриншотов
 * tool_call в чате. Реальные SSE-event'ы прилетают через
 * `/chat` от backend (KS-3205), но снять их в Playwright требует
 * авторизованного пользователя с включённым feature-flag `assistantEnabled`
 * и реальной ANTHROPIC_API_KEY конфигурацией — на dev-bypass пользователе
 * это не работает. Здесь — статический рендер всех 3 состояний (running /
 * ok / error), эквивалентный тому, что увидит реальный пользователь.
 */
const RUNNING: ToolCallEvent[] = [
  { id: 'r1', name: 'create_user_course', status: 'running' },
];
const OK: ToolCallEvent[] = [
  {
    id: 'o1',
    name: 'list_lesson_steps',
    status: 'ok',
    output: '{"steps":5}',
  },
];
const ERROR: ToolCallEvent[] = [
  {
    id: 'e1',
    name: 'create_user_course',
    status: 'error',
    error: 'Lesson title already taken',
  },
];
const MIXED: ToolCallEvent[] = [
  { id: 'm1', name: 'fetch_lesson_context', status: 'ok', output: '{"id":"l-1"}' },
  { id: 'm2', name: 'create_user_course', status: 'running' },
];

export function DevChatToolCallsPage() {
  return (
    <div style={{ padding: 24, maxWidth: 600, margin: '0 auto' }}>
      <h2 style={{ marginTop: 0 }}>Dev · ChatToolCalls (KS-3210)</h2>

      <section style={{ marginBottom: 24 }}>
        <h3>1. running (спиннер)</h3>
        <div className="chat-msg chat-msg--assistant" style={{ padding: 8 }}>
          <ChatToolCalls items={RUNNING} />
          <div className="chat-msg__content">…ассистент ещё не ответил…</div>
        </div>
      </section>

      <section style={{ marginBottom: 24 }}>
        <h3>2. ok (✓ выполнено)</h3>
        <div className="chat-msg chat-msg--assistant" style={{ padding: 8 }}>
          <ChatToolCalls items={OK} />
          <div className="chat-msg__content">
            В уроке 5 шагов. Хочешь, я перечислю их?
          </div>
        </div>
      </section>

      <section style={{ marginBottom: 24 }}>
        <h3>3. error (❌ ошибка)</h3>
        <div className="chat-msg chat-msg--assistant" style={{ padding: 8 }}>
          <ChatToolCalls items={ERROR} />
          <div className="chat-msg__content">
            Не получилось создать курс. Попробуй другое название.
          </div>
        </div>
      </section>

      <section>
        <h3>4. несколько tool-calls (mixed)</h3>
        <div className="chat-msg chat-msg--assistant" style={{ padding: 8 }}>
          <ChatToolCalls items={MIXED} />
          <div className="chat-msg__content">Создаю курс…</div>
        </div>
      </section>
    </div>
  );
}
