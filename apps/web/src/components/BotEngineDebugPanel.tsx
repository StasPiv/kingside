/**
 * KS-4308: отладочная панель над доской на `/play/local-bot` — видна
 * ТОЛЬКО когда залогинен пользователь `Stanislav`. Никаких query-
 * параметров, никаких dev-флагов — строго по `useAuth().user.username`.
 *
 * Пользователь играет в Android Chrome (PWA standalone), у него нет
 * консоли разработчика. У фронта симптом «бот за белых не делает первый
 * ход» не воспроизводится ни в безголовом Chromium, ни в эмуляции UA
 * (KS-4307). Точечная диагностика без живых данных невозможна. Панель
 * рисует события `useBotEngine` (mount, prefetch wasm, new Worker,
 * uciok/readyok/bestmove, ошибки), которые пользователь сможет снять
 * и переслать.
 *
 * Конкретные точки эмита — в `hooks/useBotEngine.ts` и
 * `hooks/useLocalBotGame.ts` через `dualLog` (`sendClientLog` +
 * `logBotEngineDebug`).
 */
import { useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import {
  getBotEngineDebugEvents,
  subscribeBotEngineDebug,
  formatBotEngineDebugEvents,
  type BotEngineDebugEvent,
} from '../lib/botEngineDebug';

const ALLOWED_USERNAME = 'Stanislav';

export function BotEngineDebugPanel() {
  const { user } = useAuth();
  const [events, setEvents] = useState<readonly BotEngineDebugEvent[]>(() =>
    getBotEngineDebugEvents(),
  );
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const unsub = subscribeBotEngineDebug(() => {
      // Снимаем shallow-копию, чтобы React заметил изменение.
      setEvents(getBotEngineDebugEvents().slice());
    });
    return unsub;
  }, []);

  if (!user || user.username !== ALLOWED_USERNAME) return null;

  const onCopy = async () => {
    const text = formatBotEngineDebugEvents(events);
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        // Fallback для старых браузеров — textarea + execCommand.
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.top = '-1000px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Тихо — пользователь может вручную выделить текст и скопировать.
    }
  };

  return (
    <div
      className="bot-engine-debug-panel"
      data-testid="bot-engine-debug-panel"
      role="region"
      aria-label="Bot engine debug log"
    >
      <div className="bot-engine-debug-panel__header">
        <span className="bot-engine-debug-panel__title">
          bot-engine debug ({events.length})
        </span>
        <button
          type="button"
          className="bot-engine-debug-panel__copy"
          onClick={onCopy}
          data-testid="bot-engine-debug-copy"
        >
          {copied ? 'Скопировано' : 'Скопировать всё'}
        </button>
      </div>
      <ol className="bot-engine-debug-panel__list">
        {events.length === 0 ? (
          <li className="bot-engine-debug-panel__empty">(пусто)</li>
        ) : (
          events.map((e, i) => (
            <li
              key={i}
              className={`bot-engine-debug-panel__row bot-engine-debug-panel__row--${e.level}`}
            >
              <span className="bot-engine-debug-panel__t">
                {String(e.tMs).padStart(6, ' ')}ms
              </span>
              <span className="bot-engine-debug-panel__msg">{e.message}</span>
            </li>
          ))
        )}
      </ol>
    </div>
  );
}
