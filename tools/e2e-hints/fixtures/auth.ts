/**
 * KS-4763. Логин тестового user'а через `/auth/dev-bypass`.
 *
 * Auth flow:
 *  - test-стек поднимается с `DEV_BYPASS_SECRET=test-hints-bypass` и
 *    `NODE_ENV=test` (см. scripts/docker-compose.test-hints.yml). На проде
 *    endpoint режется по `NODE_ENV==='production'` (apps/api/src/auth/auth.service.ts).
 *  - `POST /auth/dev-bypass {secret}` (без `user`) → upsert DEV_USER
 *    (id `00000000-0000-4000-a000-000000000002`, см. `@kingside/shared/DEV_USER_ID`)
 *    + JWT (`{accessToken, refreshToken}`).
 *  - Frontend (`apps/web/src/context/AuthContext.tsx`) читает токены из
 *    `localStorage['token']` / `localStorage['refreshToken']`. Кладём их
 *    через `context.addInitScript` — выполняется ДО загрузки приложения
 *    в каждом новом document'е, поэтому AuthProvider при init получает
 *    уже валидный token.
 *
 * Guest flow:
 *  - `GuestIdMiddleware` выпускает signed `guest_id` cookie ТОЛЬКО если
 *    в запросе уже есть валидная подписанная `analytics_consent` cookie.
 *    Без backend-helper'а корректно подложить guest_id в browser context
 *    невозможно (подпись HMAC-SHA256 на JWT_SECRET).
 *  - `loginAsGuest()` поэтому открывает `/` и достаёт UUID из выписанной
 *    middleware'ом cookie. Возвращает динамический ActorRef — тесты должны
 *    использовать его, а не константу.
 */
import { type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';
import type { ActorRef } from './actor';

const API_URL = process.env.E2E_HINTS_API_URL || 'http://localhost:3101';

/**
 * Секрет dev-bypass на test-стеке (см. scripts/docker-compose.test-hints.yml).
 * Хардкод-дефолт безопасен: этот же файл задаёт `NODE_ENV=test`, на проде
 * dev-bypass запрещён руками в `AuthService.devBypass`.
 */
const DEV_BYPASS_SECRET =
  process.env.E2E_HINTS_DEV_BYPASS_SECRET || 'test-hints-bypass';

/**
 * DEV_USER_ID из `@kingside/shared` — фиксированный UUID детерминированного
 * dev-пользователя. Чтобы `seedEvents`/`cleanActor` работали с тем же
 * actor_id, что и реальный JWT-claim после dev-bypass.
 */
export const TEST_USER: ActorRef = {
  type: 'user',
  id: '00000000-0000-4000-a000-000000000002',
};

/**
 * Default guest-ActorRef для negative-сценариев, где UUID не важен.
 * Для позитивных сценариев используй `loginAsGuest()` — он вернёт
 * актуальный UUID, выписанный middleware'ом.
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
 * Кладёт JWT-токены в localStorage браузерного контекста.
 *
 * Использует `addInitScript`, чтобы запись произошла ДО первого `page.goto`
 * и инициализации `AuthProvider`. Иначе AuthProvider стартует с `token=null`,
 * редиректит на /login и тест ловит wrong page.
 *
 * `cleanActor` нужно звать ДО `loginAs` — dev-bypass делает upsert user'а
 * (создаст заново после удаления), но actor_events таблица очистится корректно.
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
        // KS-4722: фронт-fallback cookie для analytics consent (cookie с
        // подписью требует backend-Set-Cookie; для e2e достаточно fallback).
        document.cookie = 'ks_analytics_consent=1; path=/; max-age=31536000';
      } catch {
        /* noop — page может ещё не иметь storage (about:blank) */
      }
    },
    { access: tokens.accessToken, refresh: tokens.refreshToken },
  );
}

/**
 * Bootstrap'ает гостя через реальный middleware: открывает `/`, ждёт когда
 * backend выпишет signed `guest_id`, достаёт UUID из cookie.
 *
 * ВАЖНО: middleware выписывает cookie только при наличии валидной
 * `analytics_consent=1` (signed) cookie. На test-стеке backend
 * `ANALYTICS_CONSENT_BYPASS=1` — но проверка идёт в EventsController,
 * GuestIdMiddleware всё равно требует подписанную consent-cookie.
 * Поэтому helper сначала выдёргивает signed consent через `/guest/consent`
 * (если такой endpoint есть) — иначе падает с информативным сообщением.
 *
 * Возвращает ActorRef с реальным UUID — тест должен использовать его
 * в `seedEvents` / `cleanActor`.
 */
export async function loginAsGuest(
  context: BrowserContext,
  page: Page,
): Promise<ActorRef> {
  // Открываем landing — middleware попытается выписать guest_id.
  await page.goto('/');

  // Ищем выписанную cookie на любом из доменов (API и фронт могут шарить
  // cookies, если backend cookieDomain пустой — кука уйдёт на host API).
  const cookies = await context.cookies();
  const guestCookie = cookies.find((c) => c.name === 'guest_id');
  if (!guestCookie) {
    throw new Error(
      'guest_id cookie not set after GET / — проверь что test-стек поднят с GUEST_COOKIE_SECRET и что analytics-consent cookie выписана. ' +
        'Без backend-helper /test/issue-guest-cookie guest-сценарии не работают.',
    );
  }
  // Формат: `<uuid>.<base64sig>` (см. apps/api/src/common/guest-id.middleware.ts).
  const uuid = guestCookie.value.split('.')[0];
  return { type: 'guest', id: uuid };
}
