/**
 * KS-4308: внутренний событийный буфер для отладки `useBotEngine` на
 * устройстве пользователя. Видим только в UI пользователя `Stanislav`
 * (`BotEngineDebugPanel.tsx`) — данные нужны, чтобы понять, почему у
 * него на Android Chrome (PWA standalone) бот за белых не делает
 * первый ход. Воспроизвести симптом в playwright / эмуляции UA не
 * удалось (см. KS-4307).
 *
 * Реализация — простой ring-buffer на 50 записей + подписка. Запись
 * параллельно с `sendClientLog` (не заменяет его): `sendClientLog`
 * уходит в server-side лог, а этот буфер рисуется в UI и копируется
 * пользователем кнопкой «Скопировать всё».
 */

const MAX_EVENTS = 50;

export type BotEngineDebugLevel = 'info' | 'warn' | 'error';

export interface BotEngineDebugEvent {
  /** Миллисекунд от mount страницы (см. `MOUNT_T0`). */
  tMs: number;
  level: BotEngineDebugLevel;
  message: string;
}

const MOUNT_T0 =
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : 0;

const events: BotEngineDebugEvent[] = [];
const listeners = new Set<() => void>();

function notify() {
  for (const l of listeners) {
    try {
      l();
    } catch {
      /* подписчик упал — не роняем эмиттер */
    }
  }
}

export function logBotEngineDebug(
  level: BotEngineDebugLevel,
  message: string,
): void {
  const now =
    typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : 0;
  events.push({ tMs: Math.round(now - MOUNT_T0), level, message });
  if (events.length > MAX_EVENTS) events.shift();
  notify();
}

export function getBotEngineDebugEvents(): readonly BotEngineDebugEvent[] {
  return events;
}

export function subscribeBotEngineDebug(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function clearBotEngineDebug(): void {
  events.length = 0;
  notify();
}

export function formatBotEngineDebugEvents(
  list: readonly BotEngineDebugEvent[] = events,
): string {
  return list
    .map((e) => `[${String(e.tMs).padStart(6, ' ')}ms] [${e.level}] ${e.message}`)
    .join('\n');
}
