const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3001';
const BATCH_SIZE = 10;
const FLUSH_INTERVAL_MS = 5000;

interface LogEntry {
  type: string;
  message: string;
  stack?: string;
  timestamp: string;
  url: string;
  userAgent: string;
}

let buffer: LogEntry[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;

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
    fetch(`${API_URL}/api/logs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(entries),
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
      type: 'onerror',
      message: String(message),
      stack: error?.stack,
      timestamp: new Date().toISOString(),
      url: window.location.href,
      userAgent: navigator.userAgent,
    });
    return false;
  };

  window.onunhandledrejection = (event: PromiseRejectionEvent) => {
    const reason = event.reason;
    addEntry({
      type: 'unhandledrejection',
      message: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
      timestamp: new Date().toISOString(),
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
