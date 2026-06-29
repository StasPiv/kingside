/**
 * KS-4684 / ADR-147 §2.2, §6.2 — Frontend events-клиент (user + guest).
 *
 * Модуль предоставляет:
 *  - `configureEvents({ isConsented, getAuthToken })` — инициализация
 *    клиента: гейт по consent и источник JWT.
 *  - `track(type, payload)` — складывает событие в буфер. При достижении
 *    50 событий или таймера 5 сек батч отправляется на `POST /events`.
 *  - `beforeunload`/`pagehide` — `navigator.sendBeacon` (для гостей) или
 *    `fetch(..., { keepalive: true })` (для авторизованных, чтобы
 *    Authorization header дошёл, чего sendBeacon не умеет).
 *
 * Гейт consent: если `isConsented()` возвращает `false` — полный no-op,
 * включая отбрасывание уже накопленного буфера при следующем flush.
 * До вызова `configureEvents()` `track` также безопасно молчит.
 *
 * Backend различает actor по входящему JWT / cookie `guest_id`
 * (ADR-147 §2.2). Клиент одинаков для обеих категорий — он только
 * прикладывает `Authorization: Bearer …` если есть токен и шлёт cookies.
 */

const MAX_BATCH = 50;
const FLUSH_INTERVAL_MS = 5_000;
const RETRY_BUFFER_CAP = MAX_BATCH * 4;

type EventPayload = Record<string, unknown> | undefined;

interface BufferedEvent {
  type: string;
  payload: EventPayload;
  ts: string;
}

export interface EventsClientConfig {
  /** Возвращает `true`, если согласие на аналитику дано. */
  isConsented: () => boolean;
  /** JWT access-token авторизованного пользователя или `null` для гостя. */
  getAuthToken: () => string | null;
  /** Базовый URL API; для тестов. По умолчанию — `import.meta.env.VITE_API_URL`. */
  apiBase?: string;
}

let config: EventsClientConfig | null = null;
let buffer: BufferedEvent[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;
let listenersAttached = false;

function defaultApiBase(): string {
  try {
    return (import.meta.env?.VITE_API_URL as string | undefined) ?? 'http://localhost:3001';
  } catch {
    return 'http://localhost:3001';
  }
}

function endpoint(): string {
  const base = config?.apiBase ?? defaultApiBase();
  return `${base.replace(/\/$/, '')}/events`;
}

function attachUnloadListeners() {
  if (listenersAttached || typeof window === 'undefined') return;
  window.addEventListener('beforeunload', handleUnload);
  // `pagehide` важнее на iOS Safari — beforeunload там может не сработать.
  window.addEventListener('pagehide', handleUnload);
  listenersAttached = true;
}

function detachUnloadListeners() {
  if (!listenersAttached || typeof window === 'undefined') return;
  window.removeEventListener('beforeunload', handleUnload);
  window.removeEventListener('pagehide', handleUnload);
  listenersAttached = false;
}

function startFlushTimer() {
  if (flushTimer || typeof window === 'undefined') return;
  flushTimer = setInterval(() => {
    void flush();
  }, FLUSH_INTERVAL_MS);
}

function stopFlushTimer() {
  if (!flushTimer) return;
  clearInterval(flushTimer);
  flushTimer = null;
}

/**
 * Настраивает клиент. Можно вызывать многократно — обновляет источники
 * consent/token. Первый вызов запускает таймер flush и подвешивает
 * unload-листенеры.
 */
export function configureEvents(next: EventsClientConfig): void {
  // KS-4787 diag: фиксируем переход — был ли модуль до этого настроен,
  // что было в буфере на момент пересборки клиента.
  // eslint-disable-next-line no-console
  console.log(
    `[ks-diag configure] prevConfigured=${config !== null} bufBefore=${buffer.length}`,
  );
  config = next;
  attachUnloadListeners();
  startFlushTimer();
}

/**
 * Снимает листенеры и останавливает таймер. Буфер сбрасывается.
 * Нужно для тестов и для повторной инициализации.
 */
export function teardownEvents(): void {
  // KS-4787 diag: ключевой лог — сюда упирается потеря событий между
  // BUFFERED и flush'ем. Печатаем размер буфера и его содержимое ДО
  // обнуления, плюс stack — увидим инициатора вызова (cleanup useEffect /
  // тест / явный reset).
  // eslint-disable-next-line no-console
  console.log(
    `[ks-diag teardown] bufBefore=${buffer.length} ` +
      `types=[${buffer.map((e) => e.type).join(',')}] ` +
      `configured=${config !== null} timerActive=${flushTimer !== null}`,
  );
  // eslint-disable-next-line no-console
  console.log(`[ks-diag teardown] stack=\n${new Error().stack ?? ''}`);
  stopFlushTimer();
  detachUnloadListeners();
  buffer = [];
  config = null;
}

/**
 * Помещает событие в буфер. Если consent не дан или клиент не
 * настроен — полный no-op.
 */
export function track(type: string, payload?: EventPayload): void {
  // KS-4787 diag: временный лог для e2e — убрать после зелёного прогона.
  if (!config) {
    // eslint-disable-next-line no-console
    console.log(`[ks-diag track] DROP ${type}: no config`);
    return;
  }
  if (!safeIsConsented()) {
    // eslint-disable-next-line no-console
    console.log(`[ks-diag track] DROP ${type}: not consented`);
    return;
  }
  buffer.push({ type, payload, ts: new Date().toISOString() });
  // eslint-disable-next-line no-console
  console.log(`[ks-diag track] BUFFERED ${type}: bufSize=${buffer.length}`);
  if (buffer.length >= MAX_BATCH) {
    void flush();
  }
}

/**
 * Отправляет накопленный буфер. Если в момент вызова consent отозван —
 * выкидывает буфер без отправки (требование §6.2: полный no-op).
 * На сетевой ошибке возвращает события в начало буфера (с лимитом
 * RETRY_BUFFER_CAP, чтобы не утекало в OOM при длительном простое API).
 */
export async function flush(): Promise<void> {
  if (!config) return;
  if (!safeIsConsented()) {
    // KS-4787 diag: временный лог для e2e — убрать после зелёного прогона.
    if (buffer.length > 0) {
      // eslint-disable-next-line no-console
      console.log(
        `[ks-diag flush] DROP ${buffer.length} buffered events: not consented`,
      );
    }
    buffer = [];
    return;
  }
  if (buffer.length === 0) return;
  // KS-4787 diag: временный лог.
  // eslint-disable-next-line no-console
  console.log(
    `[ks-diag flush] sending batch types=[${buffer.map((e) => e.type).join(',')}]`,
  );

  const batch = buffer.splice(0, MAX_BATCH);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = safeGetToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;

  try {
    const res = await fetch(endpoint(), {
      method: 'POST',
      credentials: 'include',
      headers,
      body: JSON.stringify({ events: batch }),
    });
    if (!res.ok && res.status >= 500) {
      // 5xx — серверная ошибка, имеет смысл повторить попозже.
      requeue(batch);
    }
    // 4xx (401/403/422) — событие невалидно/нет авторизации; дроп.
  } catch {
    requeue(batch);
  }
}

function requeue(batch: BufferedEvent[]) {
  const merged = batch.concat(buffer);
  buffer = merged.slice(0, RETRY_BUFFER_CAP);
}

function handleUnload(): void {
  if (!config) return;
  if (!safeIsConsented()) return;
  if (buffer.length === 0) return;

  const batch = buffer.splice(0);
  const url = endpoint();
  const body = JSON.stringify({ events: batch });
  const token = safeGetToken();

  // Для авторизованного пользователя sendBeacon не подходит — он не
  // умеет ставить заголовок Authorization. fetch с keepalive переживает
  // unload (спецификация Fetch §3.6) и принимает любые заголовки.
  if (token && typeof fetch !== 'undefined') {
    try {
      void fetch(url, {
        method: 'POST',
        credentials: 'include',
        keepalive: true,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body,
      });
      return;
    } catch {
      // упадём в sendBeacon-ветку
    }
  }

  if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
    try {
      const blob = new Blob([body], { type: 'application/json' });
      navigator.sendBeacon(url, blob);
      return;
    } catch {
      // последний шанс — fetch keepalive без авторизации (cookie может уйти).
    }
  }

  if (typeof fetch !== 'undefined') {
    try {
      void fetch(url, {
        method: 'POST',
        credentials: 'include',
        keepalive: true,
        headers: { 'Content-Type': 'application/json' },
        body,
      });
    } catch {
      // тихо проглатываем — больше сделать нечего
    }
  }
}

function safeIsConsented(): boolean {
  try {
    return Boolean(config?.isConsented());
  } catch {
    return false;
  }
}

function safeGetToken(): string | null {
  try {
    return config?.getAuthToken() ?? null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Утилиты для consent-гейта                                          */
/* ------------------------------------------------------------------ */

/**
 * KS-4722. Имена cookie для consent гостя:
 *  - `analytics_consent` — backend Set-Cookie (KS-4716, Domain=.kingside.site).
 *  - `ks_analytics_consent` — frontend-fallback (ставим сами после 200 OK,
 *    чтобы UI больше не зависел от того, дошёл ли backend Set-Cookie
 *    до браузера: HttpOnly-флаг, ITP, in-app WebView quirks).
 */
export const ANALYTICS_CONSENT_COOKIE = 'analytics_consent';
export const ANALYTICS_CONSENT_FRONT_COOKIE = 'ks_analytics_consent';

/**
 * Читает cookie consent из `document.cookie`. Возвращает `true`, если
 * хоть один из источников (`analytics_consent` или
 * `ks_analytics_consent`) даёт truthy-значение (`'1'`, `'true'`, в т.ч.
 * закавыченное по RFC-6265). ADR-147 §6.2: HttpOnly на основной cookie
 * не ставится — банер должен уметь читать состояние с клиента.
 */
export function readAnalyticsConsentCookie(): boolean {
  if (typeof document === 'undefined' || typeof document.cookie !== 'string') {
    return false;
  }
  return (
    cookieIsAccepted(ANALYTICS_CONSENT_COOKIE) ||
    cookieIsAccepted(ANALYTICS_CONSENT_FRONT_COOKIE)
  );
}

function cookieIsAccepted(name: string): boolean {
  const re = new RegExp(
    `(?:^|;\\s*)${name.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}=([^;]+)`,
  );
  const m = document.cookie.match(re);
  if (!m) return false;
  // RFC-6265 допускает значения в двойных кавычках; некоторые серверы
  // URL-кодируют; нормализуем перед сравнением.
  let raw = m[1].trim();
  if (raw.startsWith('"') && raw.endsWith('"')) raw = raw.slice(1, -1);
  try {
    raw = decodeURIComponent(raw);
  } catch {
    /* ignore */
  }
  return raw === '1' || raw.toLowerCase() === 'true';
}

/**
 * Frontend-write fallback cookie (`ks_analytics_consent=1` или `=0`).
 * Domain=.kingside.site — чтобы был виден и на api-субдомене (для
 * консистентности с backend cookie; backend его не валидирует, но
 * frontend читает на следующем mount).
 *
 * На localhost Domain не указываем — браузер откажет в Set-Cookie с
 * Domain=.kingside.site на чужом origin.
 */
export function writeFrontAnalyticsConsentCookie(value: boolean): void {
  if (typeof document === 'undefined') return;
  try {
    const host = typeof window !== 'undefined' ? window.location.hostname : '';
    const isProdDomain =
      host === 'kingside.site' || host.endsWith('.kingside.site');
    const secure = isProdDomain ? '; Secure' : '';
    const domain = isProdDomain ? '; Domain=.kingside.site' : '';
    if (value) {
      document.cookie =
        `${ANALYTICS_CONSENT_FRONT_COOKIE}=1; Path=/; Max-Age=31536000; SameSite=Lax${domain}${secure}`;
    } else {
      // Удаляем оба варианта (Domain= и без), браузер выберет совпадающий.
      document.cookie =
        `${ANALYTICS_CONSENT_FRONT_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax${domain}${secure}`;
      document.cookie =
        `${ANALYTICS_CONSENT_FRONT_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`;
    }
  } catch {
    /* sandboxed iframe etc. */
  }
}

/**
 * KS-4715. Локальный fallback-флаг согласия гостя в localStorage.
 *
 * Backend ставит cookies на `api.kingside.site` без `Domain=.kingside.site` —
 * фронт на основном домене их не видит, и `readAnalyticsConsentCookie()`
 * возвращает false даже после успешного `POST /guest/consent`. До фикса
 * backend используем локальный флаг как fallback, чтобы:
 *   - cookie-banner скрывался после accept (и не показывался после reload);
 *   - `events`-клиент гостя начал отправлять события.
 *
 * Когда backend починит `Domain=.kingside.site`, флаг останется страховкой
 * и поведение не изменится (cookie==true || localStorage==true).
 */
export const GUEST_CONSENT_LOCAL_KEY = 'analytics_consent.guestAcceptedAt';
const GUEST_CONSENT_TTL_MS = 365 * 24 * 60 * 60 * 1000;

export function readGuestConsentLocal(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const raw = window.localStorage.getItem(GUEST_CONSENT_LOCAL_KEY);
    if (!raw) return false;
    const n = Number(raw);
    if (!Number.isFinite(n)) return false;
    return Date.now() - n < GUEST_CONSENT_TTL_MS;
  } catch {
    return false;
  }
}

export function setGuestConsentLocal(value: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    if (value) {
      window.localStorage.setItem(
        GUEST_CONSENT_LOCAL_KEY,
        String(Date.now()),
      );
    } else {
      window.localStorage.removeItem(GUEST_CONSENT_LOCAL_KEY);
    }
  } catch {
    /* private mode и т.п. */
  }
}

/**
 * Универсальный геттер consent: для авторизованного — `user.analyticsConsent`
 * (как реально отдаёт backend KS-4697), для гостя — cookie
 * `analytics_consent=1`. Используется и в `EventsBootstrap`, и в
 * `<HintHost>` (T9), чтобы гейт был единый. Принимает оба имени поля
 * (camelCase/snake_case) для совместимости с тестами KS-4684.
 */
export function isAnalyticsConsentGiven(
  user:
    | { analyticsConsent?: boolean | null; analytics_consent?: boolean | null }
    | null
    | undefined,
): boolean {
  if (user) {
    if (user.analyticsConsent === true) return true;
    if (user.analytics_consent === true) return true;
    return false;
  }
  // KS-4715: cookie может быть установлена на api.kingside.site и
  // недоступна основному фронту до фикса Domain=.kingside.site на бэке.
  // localStorage — fallback, выставляется в CookieBanner при accept.
  return readAnalyticsConsentCookie() || readGuestConsentLocal();
}

/* ------------------------------------------------------------------ */
/* Test helpers                                                       */
/* ------------------------------------------------------------------ */

/** Только для тестов: размер буфера. */
export function __getBufferSizeForTests(): number {
  return buffer.length;
}

/** Только для тестов: содержимое буфера (копия). */
export function __peekBufferForTests(): BufferedEvent[] {
  return buffer.slice();
}

/** Только для тестов: полный сброс модульного состояния. */
export function __resetEventsForTests(): void {
  teardownEvents();
}
