#!/usr/bin/env node
/**
 * scripts/screenshot.mjs — CLI для агентских скринов Kingside.
 *
 * ADR-039 §6 E2 (KS-2307, follow-up KS-2308). Заменяет ADR-036 password-flow
 * (KS-2259):
 *   до KS-2307 — POST /auth/login с паролем из env SCRN_AGENT_PASSWORD;
 *   после   — POST /internal/screenshot-token (KS-2304), без env.
 *
 * Зависит от KS-2257 (seed test-аккаунта `__screenshot_agent`) и KS-2303/
 * KS-2304 (controller `ScreenshotTokenController` подключён к AuthModule).
 *
 * Назначение:
 *   Снимает скриншот заданной страницы Kingside в headless Chromium через
 *   Playwright. При --auth=test получает короткоживущий JWT с правами
 *   test-аккаунта `__screenshot_agent` (`isTestAccount=true, isHidden=true`)
 *   через внутренний endpoint `/internal/screenshot-token` — никаких
 *   паролей в env, никаких ротаций, токен валиден ~15 минут.
 *
 * Окружение:
 *   - SCRN_API_BASE_URL — переопределение API base. По умолчанию выводится
 *     из --url:
 *       https://kingside.site/...      → https://api.kingside.site
 *       https://api.kingside.site/...  → https://api.kingside.site
 *       http://localhost:5173/...      → http://localhost:3001
 *   - SCRN_DEBUG=1 — эквивалент --debug.
 *
 * Args:
 *   --url=<URL>                   обязательный, страница для скрина
 *   --out=<path>                  обязательный, путь к выходному PNG
 *   --auth=test|none              none (default) — без логина; test —
 *                                 получает screenshot-token и логинится
 *                                 под __screenshot_agent
 *   --viewport=desktop|mobile|mobile-small|tablet
 *                                 desktop (default 1280×800), mobile
 *                                 (iPhone 13), mobile-small (iPhone SE),
 *                                 tablet (iPad Pro 11)
 *   --wait-for=load|domcontentloaded|networkidle|commit
 *                                 page.goto waitUntil (default networkidle)
 *   --selector=<css>              после goto ждать появления селектора;
 *                                 не найден за 10s → exit 3
 *   --full-page                   снимать всю страницу (не только viewport)
 *   --theme=light|dark            data-theme атрибут html + localStorage
 *   --locale=en|ru                localStorage locale + Accept-Language
 *   --debug                       подробные логи в stderr
 *
 * Stdout:
 *   Только абсолютный путь к созданному PNG (для парсинга агентом).
 *
 * Stderr:
 *   Прогресс/ошибки. При --debug — расширенные логи.
 *
 * Exit codes:
 *   0 — OK, файл создан.
 *   1 — auth fail. Сюда мапим всё, что мешает получить screenshot-token:
 *       - HTTP 503 от endpoint'а (test-аккаунт не provisioned: см. KS-2257);
 *       - HTTP 429 (rate limit RedisRateLimitGuard);
 *       - любой 4xx/5xx с endpoint'а;
 *       - валидационные ошибки args (отсутствие --url/--out, плохой enum).
 *   2 — page load fail (page.goto / page.screenshot бросили без сетевой причины).
 *   3 — селектор не найден за 10s после goto.
 *   4 — сетевая ошибка (DNS / connection refused / TLS / playwright runtime
 *       недоступен) до или во время любого HTTP-запроса.
 *
 * Примеры:
 *
 *   # 1. Анонимный скрин лобби на десктопе (без логина).
 *   node scripts/screenshot.mjs \
 *     --url=https://kingside.site/lobby \
 *     --out=/tmp/lobby-desktop.png
 *
 *   # 2. Залогиненный скрин страницы профиля, мобильный viewport, full-page.
 *   node scripts/screenshot.mjs \
 *     --url=https://kingside.site/profile \
 *     --out=/tmp/profile-mobile.png \
 *     --auth=test --viewport=mobile --full-page
 *
 *   # 3. Скрин конкретного элемента после ожидания селектора, тёмная тема.
 *   node scripts/screenshot.mjs \
 *     --url=https://kingside.site/analysis \
 *     --out=/tmp/analysis-dark.png \
 *     --auth=test --selector='[data-testid="analysis-board"]' --theme=dark
 *
 *   # 4. Локализация — русская версия страницы puzzles на планшете.
 *   node scripts/screenshot.mjs \
 *     --url=https://kingside.site/puzzles \
 *     --out=/tmp/puzzles-ru.png \
 *     --auth=test --locale=ru --viewport=tablet
 *
 *   # 5. Debug-режим: увидеть все шаги (token-fetch, init-script, goto, screenshot).
 *   node scripts/screenshot.mjs \
 *     --url=https://kingside.site/lobby \
 *     --out=/tmp/lobby-debug.png \
 *     --auth=test --debug
 *
 * См. scripts/README.md.
 */

import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { argv, env, exit, stderr, stdout } from 'node:process';

// --- Exit codes ---
const EXIT_OK = 0;
const EXIT_AUTH = 1;
const EXIT_PAGE = 2;
const EXIT_SELECTOR = 3;
const EXIT_NETWORK = 4;

// Playwright лежит в node_modules проекта (workspace deps). Импортируется
// лениво, чтобы валидация args / ошибки конфигурации могли отчитаться
// корректным exit code до любых затрат на загрузку драйвера.
let _chromium = null;
let _devices = null;
async function loadPlaywright() {
  if (_chromium) return { chromium: _chromium, devices: _devices };
  try {
    const mod = await import('playwright');
    _chromium = mod.chromium;
    _devices = mod.devices;
    return { chromium: _chromium, devices: _devices };
  } catch (e) {
    stderr.write(`[scrn] ERROR: cannot load 'playwright' (${e.message}). Run from repo root with deps installed.\n`);
    exit(EXIT_NETWORK);
  }
}

// --- Args parsing ---

function parseArgs(argv) {
  const out = {
    url: null,
    out: null,
    auth: 'none',
    viewport: 'desktop',
    waitFor: 'networkidle',
    selector: null,
    fullPage: false,
    theme: null,
    locale: null,
    debug: false,
  };
  for (const raw of argv.slice(2)) {
    if (raw === '--full-page') { out.fullPage = true; continue; }
    if (raw === '--debug') { out.debug = true; continue; }
    if (raw === '--help' || raw === '-h') { out._help = true; continue; }
    const eq = raw.indexOf('=');
    if (!raw.startsWith('--') || eq < 0) {
      throw new Error(`unknown arg: ${raw}`);
    }
    const key = raw.slice(2, eq);
    const val = raw.slice(eq + 1);
    switch (key) {
      case 'url': out.url = val; break;
      case 'out': out.out = val; break;
      case 'auth': out.auth = val; break;
      case 'viewport': out.viewport = val; break;
      case 'wait-for': out.waitFor = val; break;
      case 'selector': out.selector = val; break;
      case 'theme': out.theme = val; break;
      case 'locale': out.locale = val; break;
      default: throw new Error(`unknown arg: --${key}`);
    }
  }
  return out;
}

function validate(args) {
  const errs = [];
  if (!args.url) errs.push('--url is required');
  if (!args.out) errs.push('--out is required');
  const authChoices = ['test', 'none'];
  if (!authChoices.includes(args.auth)) errs.push(`--auth must be one of ${authChoices.join('|')}`);
  const viewChoices = ['desktop', 'mobile', 'mobile-small', 'tablet'];
  if (!viewChoices.includes(args.viewport)) errs.push(`--viewport must be one of ${viewChoices.join('|')}`);
  const waitChoices = ['load', 'domcontentloaded', 'networkidle', 'commit'];
  if (!waitChoices.includes(args.waitFor)) errs.push(`--wait-for must be one of ${waitChoices.join('|')}`);
  if (args.theme !== null && !['light', 'dark'].includes(args.theme)) errs.push('--theme must be light|dark');
  if (args.locale !== null && !['en', 'ru'].includes(args.locale)) errs.push('--locale must be en|ru');
  // ВАЖНО: --auth=test больше НЕ требует env-переменных. Токен берётся
  // из /api/internal/screenshot-token (KS-2304/KS-2307).
  return errs;
}

// --- Helpers ---

function log(args, ...parts) {
  if (args.debug || env.SCRN_DEBUG === '1') stderr.write(`[scrn] ${parts.join(' ')}\n`);
}

function err(...parts) {
  stderr.write(`[scrn] ERROR: ${parts.join(' ')}\n`);
}

function deriveApiBase(pageUrl) {
  if (env.SCRN_API_BASE_URL) return env.SCRN_API_BASE_URL.replace(/\/$/, '');
  let u;
  try { u = new URL(pageUrl); } catch { return ''; }
  // localhost:5173 → http://localhost:3001 (frontend dev → API dev).
  if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') {
    return `${u.protocol}//${u.hostname}:3001`;
  }
  // api.<root> остаётся как есть; иначе — добавляем "api." к корню.
  if (u.hostname.startsWith('api.')) return `${u.protocol}//${u.hostname}`;
  return `${u.protocol}//api.${u.hostname}`;
}

function classifyFetchError(e) {
  // node fetch / undici net errors → exit 4. CertificateError / DNS / connect refused.
  if (!e || !e.cause) return null;
  const code = e.cause.code || e.code;
  const netCodes = new Set([
    'ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT',
    'EAI_AGAIN', 'EPROTO', 'CERT_HAS_EXPIRED',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'DEPTH_ZERO_SELF_SIGNED_CERT',
  ]);
  if (netCodes.has(code)) return EXIT_NETWORK;
  return null;
}

// --- Auth (POST /internal/screenshot-token, KS-2304/KS-2308) ---
//
// Контроллер `ScreenshotTokenController` подключён к `AuthModule`. На проде
// Nest развёрнут БЕЗ global prefix `/api` (ALB ничего не добавляет), endpoint
// доступен по `/internal/screenshot-token`. То же на dev (localhost). Это
// поведение симметрично `/auth/login` и проверено вручную после KS-SCR2-E1
// deploy (build tag `0a046e2b`, kingside-api:54): `/internal/screenshot-token`
// → 201 + JWT, `/api/internal/screenshot-token` → 404 от ALB.
//
// Ответ (201): { accessToken: "<JWT>", expiresIn: <seconds> }. JWT payload
// содержит { sub: <userId>, username: '__screenshot_agent', iat, exp }.
// Refresh-токен НЕ выдаётся: токен короткоживущий (15m на проде), refresh
// для скриншот-сессии не нужен.
//
// Известные не-2xx коды:
//   503 — test-аккаунт не provisioned (`isTestAccount=true, isHidden=true`,
//         username `__screenshot_agent` — KS-2257). На проде должен быть
//         засеян; локально нужно один раз `npm run seed:screenshot` в apps/api.
//   429 — rate limit (RedisRateLimitGuard). Стандартное поведение Nest auth.
//
// Все не-2xx → exit 1 со специфичным stderr-сообщением.

async function fetchScreenshotToken(args, apiBase) {
  // KS-2308 follow-up: на проде Nest БЕЗ global prefix `/api` (ALB ничего
  // не добавляет; реально endpoint `/internal/screenshot-token` отдаёт 201,
  // а `/api/internal/screenshot-token` уходит в ALB-404). Поведение
  // симметрично `/auth/login` (тоже без /api). Единый path для всех env.
  const path = '/internal/screenshot-token';
  const endpoint = `${apiBase}${path}`;
  log(args, `screenshot-token: POST ${endpoint}`);

  let res;
  try {
    res = await fetch(endpoint, { method: 'POST' });
  } catch (e) {
    const netExit = classifyFetchError(e);
    if (netExit !== null) {
      err(`network error on screenshot-token: ${e.message}`);
      exit(EXIT_NETWORK);
    }
    err(`screenshot-token fetch failed: ${e.message}`);
    exit(EXIT_AUTH);
  }

  // Известные коды с осмысленными сообщениями.
  if (res.status === 503) {
    err(`screenshot-token: HTTP 503 — test account is not provisioned on this env`);
    err('hint: run apps/api seed:screenshot (KS-2257) — see scripts/screenshot-agent-rotation.md');
    exit(EXIT_AUTH);
  }
  if (res.status === 429) {
    let retry = '';
    try { retry = res.headers.get('retry-after') || ''; } catch { /* ignore */ }
    err(`screenshot-token: HTTP 429 — rate-limit by RedisRateLimitGuard${retry ? ` (Retry-After=${retry})` : ''}`);
    err('hint: retry later, or check rate-limit window in apps/api');
    exit(EXIT_AUTH);
  }
  // NestJS @Post() default — 201 на success; 200 принимаем тоже.
  if (res.status !== 200 && res.status !== 201) {
    let body = '';
    try { body = await res.text(); } catch { /* ignore */ }
    err(`screenshot-token: HTTP ${res.status}: ${body.slice(0, 300)}`);
    exit(EXIT_AUTH);
  }

  const data = await res.json().catch(() => ({}));
  if (!data.accessToken) {
    err('screenshot-token: response missing accessToken');
    exit(EXIT_AUTH);
  }
  log(args, `screenshot-token: OK (accessToken len=${data.accessToken.length}, expiresIn=${data.expiresIn ?? '?'}s)`);
  return data;
}

// --- Viewport mapping ---

function viewportConfig(name, devices) {
  switch (name) {
    case 'desktop':
      return { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false };
    case 'mobile':
      // iPhone 13 — современный baseline для mobile-screenshot'ов.
      return devices['iPhone 13'];
    case 'mobile-small':
      // iPhone SE — самый узкий поддерживаемый mobile (375×667).
      return devices['iPhone SE'];
    case 'tablet':
      return devices['iPad Pro 11'];
    default:
      return { viewport: { width: 1280, height: 800 } };
  }
}

// --- Main ---

async function main() {
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    err(e.message);
    err('Use --help for usage.');
    exit(EXIT_AUTH);
  }
  if (args._help) {
    stdout.write('See header comment of scripts/screenshot.mjs and scripts/README.md.\n');
    exit(EXIT_OK);
  }
  const errs = validate(args);
  if (errs.length) {
    for (const e of errs) err(e);
    exit(EXIT_AUTH);
  }
  log(args, `args: ${JSON.stringify({ ...args, _help: undefined })}`);

  // 1. Token (если auth=test) — до запуска браузера: дёшево валидируем
  // достижимость API + готовность endpoint'а. fetch ошибки → exit 1/4.
  let token = null;
  if (args.auth === 'test') {
    const apiBase = deriveApiBase(args.url);
    if (!apiBase) {
      err(`cannot derive API base from --url=${args.url}; set SCRN_API_BASE_URL`);
      exit(EXIT_AUTH);
    }
    const tokenRes = await fetchScreenshotToken(args, apiBase);
    token = tokenRes.accessToken;
  }

  // 2. Browser context. Берём конфигурацию из playwright/devices для
  // mobile/tablet, чтобы UA + DPR + isMobile + hasTouch были как на реальном.
  const { chromium, devices } = await loadPlaywright();
  const vpCfg = viewportConfig(args.viewport, devices);
  log(args, `viewport: ${args.viewport} (${vpCfg.viewport.width}×${vpCfg.viewport.height}, mobile=${!!vpCfg.isMobile})`);

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (e) {
    err(`browser launch failed: ${e.message}`);
    exit(EXIT_NETWORK);
  }

  let exitCode = EXIT_OK;
  try {
    const contextOpts = {
      ...vpCfg,
      // Accept-Language подсказка для контента и SSR/SEO ветвлений.
      locale: args.locale === 'ru' ? 'ru-RU' : args.locale === 'en' ? 'en-US' : undefined,
    };
    const context = await browser.newContext(contextOpts);

    // 3. Init-script — выполняется до любых скриптов страницы. Записываем
    // access-токен в localStorage по тому же ключу, что использует фронт
    // (см. apps/web/src/contexts/AuthContext.tsx — `token`). Refresh-токен
    // не выдаётся endpoint'ом /api/internal/screenshot-token (15m TTL,
    // фронт перерефрешит при истечении 401 — для скриншот-сессии не успеет
    // понадобиться).
    const initParts = [];
    if (token) {
      initParts.push(
        `localStorage.setItem('token', ${JSON.stringify(token)});`,
      );
    }
    if (args.locale) {
      initParts.push(`localStorage.setItem('locale', ${JSON.stringify(args.locale)});`);
    }
    if (args.theme) {
      // Фронт использует data-theme на html + читает 'theme' из storage.
      initParts.push(
        `try { document.documentElement.setAttribute('data-theme', ${JSON.stringify(args.theme)}); } catch {}`,
        `localStorage.setItem('theme', ${JSON.stringify(args.theme)});`,
      );
    }
    if (initParts.length) {
      const initScript = initParts.join('\n');
      log(args, `addInitScript: ${initParts.length} statement(s)`);
      await context.addInitScript({ content: initScript });
    }

    const page = await context.newPage();

    // 4. Goto. waitUntil зависит от --wait-for.
    log(args, `goto: ${args.url} (waitUntil=${args.waitFor})`);
    try {
      await page.goto(args.url, { waitUntil: args.waitFor, timeout: 30000 });
    } catch (e) {
      const netExit = classifyFetchError(e);
      if (netExit !== null) {
        err(`network error on goto: ${e.message}`);
        exitCode = EXIT_NETWORK;
        return;
      }
      // Playwright ERR_NAME_NOT_RESOLVED / ERR_CONNECTION_REFUSED → exit 4.
      const m = String(e.message || '');
      if (/ERR_(NAME_NOT_RESOLVED|CONNECTION_REFUSED|INTERNET_DISCONNECTED|CONNECTION_TIMED_OUT|TIMED_OUT|TUNNEL_CONNECTION_FAILED|CERT|SSL)/i.test(m)) {
        err(`network error on goto: ${e.message}`);
        exitCode = EXIT_NETWORK;
        return;
      }
      err(`page load failed: ${e.message}`);
      exitCode = EXIT_PAGE;
      return;
    }

    // 5. Wait for selector, если задан.
    if (args.selector) {
      log(args, `waitForSelector: ${args.selector} (10s)`);
      try {
        await page.waitForSelector(args.selector, { timeout: 10000, state: 'visible' });
      } catch (e) {
        err(`selector not found within 10s: ${args.selector}`);
        exitCode = EXIT_SELECTOR;
        return;
      }
    }

    // 6. Screenshot. Папка под --out создаётся при необходимости.
    const outAbs = resolve(args.out);
    try { mkdirSync(dirname(outAbs), { recursive: true }); } catch { /* ignore EEXIST */ }
    log(args, `screenshot: ${outAbs} (fullPage=${args.fullPage})`);
    try {
      await page.screenshot({ path: outAbs, fullPage: args.fullPage });
    } catch (e) {
      err(`screenshot failed: ${e.message}`);
      exitCode = EXIT_PAGE;
      return;
    }

    // 7. ONLY the path goes to stdout.
    stdout.write(`${outAbs}\n`);
  } finally {
    try { await browser.close(); } catch { /* ignore */ }
  }
  exit(exitCode);
}

main().catch((e) => {
  err(`uncaught: ${e && e.stack ? e.stack : e}`);
  exit(EXIT_PAGE);
});
