/**
 * KS-4970 — сохранение исходного источника регистрации через OAuth-редирект.
 *
 * Вход в Kingside — только через OAuth (Google/Facebook/Telegram). Переход
 * на домен провайдера и обратно затирает `document.referrer` и utm-метки:
 * сессия регистрации в аналитике приписывается oauth.telegram.org /
 * accounts.google.com, а не странице/каналу, откуда пришёл пользователь.
 *
 * Модуль фиксирует источник ДО перехода на провайдера и отдаёт его в
 * момент реального создания нового аккаунта (успех username-setup), чтобы
 * событие регистрации несло исходную страницу/referrer/utm.
 *
 * Хранилище — `sessionStorage`:
 *   • переживает OAuth-редирект в той же вкладке (проверено на
 *     `authReturnUrl`, тот же механизм);
 *   • не утекает между вкладками/устройствами;
 *   • живёт ровно до конца визита — гранулярность визита совпадает с
 *     атрибуцией регистрации, случившейся в этом визите.
 */

import { trackEvent } from './analytics';

const FIRST_TOUCH_KEY = 'ks_reg_attribution:first_touch:v1';
const LOGIN_START_KEY = 'ks_reg_attribution:login_start:v1';

const UTM_KEYS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
] as const;

export interface RegistrationSource {
  /** Первая страница визита (pathname + search). */
  landingPage?: string;
  /** Внешний referrer первого захода (пусто при прямом заходе). */
  referrer?: string;
  /** utm-метки первого захода. */
  utm?: Partial<Record<(typeof UTM_KEYS)[number], string>>;
  /** Страница, с которой пользователь инициировал вход. */
  loginPage?: string;
  /** Провайдер входа: google | facebook | telegram. */
  provider?: string;
}

function readJson<T>(store: Storage, key: string): T | null {
  try {
    const raw = store.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeJson(store: Storage, key: string, value: unknown): void {
  try {
    store.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode / переполнение — тихо игнорируем, UI не валим */
  }
}

function parseUtm(search: string): RegistrationSource['utm'] {
  const params = new URLSearchParams(search);
  const utm: Record<string, string> = {};
  for (const k of UTM_KEYS) {
    const v = params.get(k);
    if (v) utm[k] = v;
  }
  return Object.keys(utm).length ? utm : undefined;
}

/**
 * Фиксирует источник первого захода визита (landing, referrer, utm).
 * Вызывать один раз при старте приложения. Идемпотентно: первый вызов
 * в визите закрепляет значение, последующие — no-op (исходный источник
 * не перетирается внутренней навигацией).
 */
export function captureFirstTouchAttribution(): void {
  if (typeof window === 'undefined') return;
  if (sessionStorage.getItem(FIRST_TOUCH_KEY)) return;
  const source: RegistrationSource = {
    landingPage: window.location.pathname + window.location.search,
    referrer: document.referrer || undefined,
    utm: parseUtm(window.location.search),
  };
  writeJson(sessionStorage, FIRST_TOUCH_KEY, source);
}

/**
 * Отмечает начало входа: провайдер и страница, с которой пользователь
 * нажал вход. Вызывать ДО перехода на OAuth-провайдера. Переживает
 * редирект (sessionStorage).
 */
export function markLoginStart(provider: string): void {
  if (typeof window === 'undefined') return;
  writeJson(sessionStorage, LOGIN_START_KEY, {
    provider,
    loginPage: window.location.pathname + window.location.search,
  });
}

/**
 * Собирает исходный источник (first-touch + login-start). Не очищает
 * хранилище — очистка отдельным `clearRegistrationSource()` после
 * успешной отправки события.
 */
export function getRegistrationSource(): RegistrationSource {
  const first = readJson<RegistrationSource>(sessionStorage, FIRST_TOUCH_KEY) ?? {};
  const login = readJson<{ provider?: string; loginPage?: string }>(
    sessionStorage,
    LOGIN_START_KEY,
  ) ?? {};
  return {
    landingPage: first.landingPage,
    referrer: first.referrer,
    utm: first.utm,
    loginPage: login.loginPage,
    provider: login.provider,
  };
}

/**
 * Отправляет GA4-событие регистрации нового аккаунта с исходным
 * источником и очищает сохранённые данные. Вызывать ТОЛЬКО при реальном
 * создании нового аккаунта (успех username-setup для нового пользователя).
 * Повторный вход существующего пользователя это событие не генерирует —
 * вызов гейтится на стороне потребителя по признаку нового аккаунта.
 *
 * `method` (провайдер) можно передать явно; иначе берётся из login-start.
 */
export function emitRegistrationEvent(method?: string): void {
  const source = getRegistrationSource();
  const utm = source.utm ?? {};
  trackEvent('sign_up', {
    method: method ?? source.provider,
    source_page: source.landingPage,
    login_page: source.loginPage,
    referrer: source.referrer,
    utm_source: utm.utm_source,
    utm_medium: utm.utm_medium,
    utm_campaign: utm.utm_campaign,
    utm_term: utm.utm_term,
    utm_content: utm.utm_content,
  });
  clearRegistrationSource();
}

/** Удаляет сохранённый источник (после отправки события регистрации). */
export function clearRegistrationSource(): void {
  if (typeof window === 'undefined') return;
  try {
    sessionStorage.removeItem(FIRST_TOUCH_KEY);
    sessionStorage.removeItem(LOGIN_START_KEY);
  } catch {
    /* ignore */
  }
}
