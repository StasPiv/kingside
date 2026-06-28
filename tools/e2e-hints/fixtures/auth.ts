/**
 * KS-4763. Логин user'а через `/auth/dev-bypass` и bootstrap гостя
 * через `/test/issue-guest-cookies` (KS-4765 / T6).
 *
 * Auth flow (user):
 *  - `POST /auth/dev-bypass {secret}` (без `user`) → upsert DEV_USER
 *    (id `00000000-0000-4000-a000-000000000002`, см.
 *    `@kingside/shared/DEV_USER_ID`) + `{accessToken, refreshToken}`.
 *  - Токены кладутся в `localStorage['token'] / ['refreshToken']`
 *    через `context.addInitScript` — выполняется ДО загрузки
 *    приложения, AuthProvider читает уже валидный token.
 *
 * Guest flow:
 *  - `POST /test/issue-guest-cookies` ставит подписанные
 *    `analytics_consent` + `analytics_consent_sig` + `guest_id` cookies
 *    (тем же `GuestCookieSigner`, что `GuestPublicController.consent`).
 *  - Playwright `APIRequestContext` шарит cookie store с
 *    `BrowserContext` — после запроса cookies автоматически становятся
 *    доступны для запросов из браузера на тот же host (localhost:3101).
 *  - Дополнительно ставим `ks_analytics_consent=1` на frontend-origin
 *    через `addInitScript` — `useHintPull` (frontend pull-loop)
 *    проверяет consent через `document.cookie` на своём origin.
 */
import { type APIRequestContext, type BrowserContext } from '@playwright/test';
import type { ActorRef } from './actor';

const API_URL = process.env.E2E_HINTS_API_URL || 'http://localhost:3101';

/**
 * Секрет dev-bypass на test-стеке (см. scripts/docker-compose.test-hints.yml).
 * Хардкод-дефолт безопасен: тот же compose задаёт `NODE_ENV=test`, на
 * проде dev-bypass запрещён в `AuthService.devBypass`.
 */
const DEV_BYPASS_SECRET =
  process.env.E2E_HINTS_DEV_BYPASS_SECRET || 'test-hints-bypass';

/**
 * DEV_USER_ID из `@kingside/shared` — фиксированный UUID детерминированного
 * dev-пользователя. `seedEvents`/`cleanActor` работают с тем же actor_id,
 * что и реальный JWT-claim после dev-bypass.
 */
export const TEST_USER: ActorRef = {
  type: 'user',
  id: '00000000-0000-4000-a000-000000000002',
};

/**
 * Default guest-ActorRef (используется для импорта в спецах до вызова
 * loginAsGuest). Реальный id выдаётся backend'ом через
 * /test/issue-guest-cookies — используй возвращаемое значение.
 */
export const TEST_GUEST: ActorRef = {
  type: 'guest',
  id: '00000000-0000-4000-8000-000000000aaa',
};

interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

async function devBypass(request: APIRequestContext): Promise<AuthTokens> {
  const res = await request.post(`${API_URL}/auth/dev-bypass`, {
    data: { secret: DEV_BYPASS_SECRET },
  });
  if (!res.ok()) {
    throw new Error(
      `dev-bypass failed: ${res.status()} ${await res.text()}`,
    );
  }
  return (await res.json()) as AuthTokens;
}

/**
 * Кладёт JWT-токены в localStorage браузерного контекста + consent-cookie
 * на frontend-origin. Использует `addInitScript`, чтобы запись произошла
 * ДО первого `page.goto` и инициализации `AuthProvider`.
 *
 * `cleanActor` зови ДО `loginAs` — dev-bypass делает upsert user'а
 * заново после удаления, actor_events таблица очищается корректно.
 */
export async function loginAs(
  context: BrowserContext,
  request: APIRequestContext,
  _actor: ActorRef = TEST_USER,
): Promise<void> {
  const tokens = await devBypass(request);
  await context.addInitScript(
    ({ access, refresh }: { access: string; refresh: string }) => {
      try {
        window.localStorage.setItem('token', access);
        window.localStorage.setItem('refreshToken', refresh);
        // Frontend-fallback cookie на frontend-origin: useHintPull
        // (для гостя) и HintHost проверяют consent через document.cookie.
        // Для user-actor это не нужно (consent проверяется через user.analytics_consent),
        // но ставим единообразно — не мешает.
        document.cookie = 'ks_analytics_consent=1; path=/; max-age=31536000';
      } catch {
        /* noop — page может ещё не иметь storage (about:blank) */
      }
    },
    { access: tokens.accessToken, refresh: tokens.refreshToken },
  );
}

const FRONT_URL = process.env.E2E_HINTS_FRONT_URL || 'http://localhost:5174';

/**
 * KS-4765 T6 + KS-4767 T8. Bootstrap'ает гостя через
 * `/test/issue-guest-cookies` — backend подписывает
 * `analytics_consent`/`analytics_consent_sig`/`guest_id` тем же
 * `GuestCookieSigner`, что использует `GuestIdMiddleware`.
 *
 * Origin-проблема: API (3101) и фронт (5174) — разные origin'ы. Cookies
 * из `Set-Cookie` без `Domain=` ассоциируются только с api-origin →
 * фронт `<HintHost>` через `document.cookie` не видит `analytics_consent`,
 * `consentGiven=false`, `useHintPull` отключён. T8 решение: endpoint
 * возвращает в body сами значения cookies, фикстура зашивает их через
 * `BrowserContext.addCookies()` на обоих origin'ах. Подпись HMAC origin-
 * агностична — middleware при `POST /events` на API увидит валидную sig.
 *
 * Возвращает ActorRef с реальным UUID — используй его в `seedEvents` /
 * `cleanActor` / `emitHint`.
 */
export async function loginAsGuest(
  context: BrowserContext,
  request: APIRequestContext,
  guestId?: string,
): Promise<ActorRef> {
  const res = await request.post(`${API_URL}/test/issue-guest-cookies`, {
    data: guestId ? { guest_id: guestId } : {},
  });
  if (!res.ok()) {
    throw new Error(
      `issue-guest-cookies failed: ${res.status()} ${await res.text()}`,
    );
  }
  const body = (await res.json()) as {
    guest_id: string;
    cookies: {
      analytics_consent: { name: string; value: string };
      analytics_consent_sig: { name: string; value: string };
      guest_id: { name: string; value: string };
    };
  };

  // KS-4767 / T8. Зашиваем cookies явно на оба origin'а через addCookies —
  // браузер тогда увидит analytics_consent/guest_id и на frontend (где их
  // читает HintHost.consentGiven), и на api (где их читает GuestIdMiddleware).
  const origins = [API_URL, FRONT_URL];
  const toAdd: Parameters<BrowserContext['addCookies']>[0] = [];
  for (const url of origins) {
    toAdd.push(
      { name: body.cookies.analytics_consent.name, value: body.cookies.analytics_consent.value, url, sameSite: 'Lax' },
      { name: body.cookies.analytics_consent_sig.name, value: body.cookies.analytics_consent_sig.value, url, sameSite: 'Lax', httpOnly: true },
      { name: body.cookies.guest_id.name, value: body.cookies.guest_id.value, url, sameSite: 'Lax' },
    );
  }
  await context.addCookies(toAdd);

  // Дополнительно ставим frontend-fallback ks_analytics_consent=1 в
  // localStorage-friendly cookie на frontend-origin: readAnalyticsConsentCookie
  // умеет читать оба имени (analytics_consent || ks_analytics_consent).
  // Подстраховка, если addCookies на FRONT_URL отвалится из-за порт-mismatch.
  await context.addInitScript(() => {
    try {
      document.cookie = 'ks_analytics_consent=1; path=/; max-age=31536000; SameSite=Lax';
    } catch {
      /* noop — about:blank нет storage */
    }
  });

  return { type: 'guest', id: body.guest_id };
}
