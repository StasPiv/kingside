const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3001';
const BATCH_SIZE = 10;
const FLUSH_INTERVAL_MS = 5000;

/**
 * KS-2741. Backend `/logs` валидатор требует:
 *   type ∈ {'error','warn','info','event'}
 *   timestamp: number (millisecond epoch)
 * До фикса фронт слал `type: 'onerror'/'unhandledrejection'` и
 * `timestamp: ISO-string` — backend отвечал 400 на каждый flush, в
 * логах api это создавало шум при попытке зарепортить любую js-ошибку.
 *
 * Тип `LogType` ограничен бэкенд-enum'ом. Подкатегория window-handler'а
 * (onerror / unhandledrejection) идёт в текст message — info не теряем.
 */
type LogType = 'error' | 'warn' | 'info' | 'event';

interface LogEntry {
  type: LogType;
  message: string;
  stack?: string;
  /** Epoch millis (number), не ISO-string. */
  timestamp: number;
  url: string;
  userAgent: string;
}

let buffer: LogEntry[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Публичный API: разрешаем только enum-типы. Старые вызовы с
 * произвольным `string`-типом теперь не компилируются — найди и
 * приведи к одному из четырёх.
 */
export function sendClientLog(type: LogType, message: string): void {
  addEntry({
    type,
    message,
    timestamp: Date.now(),
    url: window.location.href,
    userAgent: navigator.userAgent,
  });
}

function addEntry(entry: LogEntry): void {
  buffer.push(entry);
  if (buffer.length >= BATCH_SIZE) {
    flush();
  }
}

function flush(): void {
  if (buffer.length === 0) return;
  const entries = buffer.slice();
  buffer = [];
  sendEntries(entries);
}

function sendEntries(entries: LogEntry[]): void {
  try {
    fetch(`${API_URL}/logs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ logs: entries }),
      keepalive: true,
    }).catch(() => {
      // silent fail
    });
  } catch {
    // silent fail
  }
}

export function initClientLogger(): void {
  if (!import.meta.env.PROD) return;

  window.onerror = (message, _source, _lineno, _colno, error) => {
    addEntry({
      // KS-2741: enum-валидный тип. Раньше было `'onerror'` — backend
      // отбрасывал. Теперь хвостовая инфа о handler'е идёт префиксом.
      type: 'error',
      message: `[onerror] ${String(message)}`,
      stack: error?.stack,
      timestamp: Date.now(),
      url: window.location.href,
      userAgent: navigator.userAgent,
    });
    return false;
  };

  window.onunhandledrejection = (event: PromiseRejectionEvent) => {
    const reason = event.reason;
    addEntry({
      type: 'error',
      message: `[unhandledrejection] ${reason instanceof Error ? reason.message : String(reason)}`,
      stack: reason instanceof Error ? reason.stack : undefined,
      timestamp: Date.now(),
      url: window.location.href,
      userAgent: navigator.userAgent,
    });
  };

  flushTimer = setInterval(flush, FLUSH_INTERVAL_MS);
}

export function destroyClientLogger(): void {
  if (flushTimer !== null) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  window.onerror = null;
  window.onunhandledrejection = null;
  buffer = [];
}
