import { useTranslation } from 'react-i18next';

import type { ToolCallEvent } from '../hooks/useChatStream';

/**
 * KS-3210 (ADR-074 §10 F1): рендер списка tool-вызовов внутри одного
 * assistant-сообщения.
 *
 * Контракт SSE — см. `ToolCallEvent` в `useChatStream.ts`. Один tool
 * проходит 1..2 события: `running` (всегда) → `ok` или `error`. UI
 * отражает финальный статус:
 *   - `running` — спиннер + «🛠 {name} — выполняется…».
 *   - `ok` — «✓ выполнено: {name}». `output` не показываем (часто
 *     длинный JSON, шумит чат), но кладём в `title`/`data-output`
 *     для debug-инспекции.
 *   - `error` — «❌ ошибка: {message}». `error` всегда есть.
 *
 * Этот блок намеренно отделён от `chat-msg__content` — это служебная
 * лента, а не часть ответа модели. Стилизация (`chat-tool-calls`)
 * приглушена (border-left, opacity 0.85), чтобы внимание оставалось
 * на тексте ответа. Спиннер — CSS-only (см. analysis.css / общий
 * `.spinner`-helper), без external-deps.
 */
export function ChatToolCalls({ items }: { items: ToolCallEvent[] }) {
  const { t } = useTranslation();
  if (items.length === 0) return null;

  return (
    <ul
      className="chat-tool-calls"
      data-testid="chat-tool-calls"
      aria-label={t('chat.toolCalls.label', 'Tool calls')}
    >
      {items.map((tc) => (
        <li
          key={tc.id}
          className={`chat-tool-call chat-tool-call--${tc.status}`}
          data-testid={`chat-tool-call-${tc.id}`}
          data-status={tc.status}
          data-name={tc.name}
          data-output={tc.output ?? ''}
        >
          {tc.status === 'running' && (
            <>
              <span
                className="chat-tool-call__spinner"
                aria-hidden="true"
              />
              <span className="chat-tool-call__icon" aria-hidden="true">
                🛠
              </span>
              <span className="chat-tool-call__text">
                {t('chat.toolCalls.running', {
                  defaultValue: '{{name}} — running…',
                  name: tc.name,
                })}
              </span>
            </>
          )}
          {tc.status === 'ok' && (
            <>
              <span
                className="chat-tool-call__icon chat-tool-call__icon--ok"
                aria-hidden="true"
              >
                ✓
              </span>
              <span className="chat-tool-call__text">
                {t('chat.toolCalls.ok', {
                  defaultValue: 'Completed: {{name}}',
                  name: tc.name,
                })}
              </span>
            </>
          )}
          {tc.status === 'error' && (
            <>
              <span
                className="chat-tool-call__icon chat-tool-call__icon--error"
                aria-hidden="true"
              >
                ❌
              </span>
              <span className="chat-tool-call__text">
                {t('chat.toolCalls.error', {
                  defaultValue: 'Error in {{name}}: {{message}}',
                  name: tc.name,
                  message: tc.error ?? '',
                })}
              </span>
            </>
          )}
        </li>
      ))}
    </ul>
  );
}
