#!/usr/bin/env node
/**
 * scripts/screenshot.mjs — CLI для агентских скринов Kingside.
 *
 * ADR-036 §5, KS-2259. Зависит от KS-2257 (seed-скрипт), KS-2258 (пароль в SSM
 * + env агентского контейнера).
 *
 * Назначение:
 *   Снимает скриншот заданной страницы Kingside в headless Chromium через
 *   Playwright. Поддерживает логин под test-аккаунтом `__screenshot_agent`
 *   (`isTestAccount=true, isHidden=true`) — для скринов защищённых страниц
 *   без прав администратора.
 *
 * Окружение:
 *   - SCRN_AGENT_PASSWORD — пароль test-аккаунта (берётся из AWS SSM
 *     `/kingside/prod/SCRN_AGENT_PASSWORD` через webhook-server при
 *     запуске агентского контейнера). Обязателен при --auth=test.
 *   - SCRN_AGENT_USERNAME — переопределение username (default `__screenshot_agent`).
 *   - SCRN_API_BASE_URL — переопределение API base URL для логина. По
 *     умолчанию выводится из --url:
 *       https://kingside.site/...      → https://api.kingside.site
 *       https://api.kingside.site/...  → https://api.kingside.site
 *       http://localhost:5173/...      → http://localhost:3001
 *   - SCRN_DEBUG=1 — эквивалент --debug.
 *
 * Args:
 *   --url=<URL>                   обязательный, страница для скрина
 *   --out=<path>                  обязательный, путь к выходному PNG
 *   --auth=test|none              none (default) — без логина; test — login
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
 *   1 — auth fail (HTTP != 200 на /auth/login, нет токенов в ответе,
 *       неверные creds).
 *   2 — page load fail (page.goto бросил, не таймаут селектора).
 *   3 — селектор не найден за 10s после goto.
 *   4 — сетевая ошибка (DNS / connection refused / TLS) до или во время
 *       любого HTTP-запроса.
 *
 * Примеры:
 *
 *   # 1. Анонимный скрин лобби на десктопе (без логина), networkidle.
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
 *   # 4. Локализация — русская версия страницы puzzles.
 *   node scripts/screenshot.mjs \
 *     --url=https://kingside.site/puzzles \
 *     --out=/tmp/puzzles-ru.png \
 *     --auth=test --locale=ru --viewport=tablet
 *
 *   # 5. Debug-режим: увидеть все шаги (login, init-script, goto, screenshot).
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

// --- Exit codes ---
const EXIT_OK = 0;
const EXIT_AUTH = 1;
const EXIT_PAGE = 2;
const EXIT_SELECTOR = 3;
const EXIT_NETWORK = 4;

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
  if (args.auth === 'test' && !env.SCRN_AGENT_PASSWORD) {
    errs.push('--auth=test requires env SCRN_AGENT_PASSWORD (see KS-2258, scripts/screenshot-agent-rotation.md)');
  }
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

// --- Auth (POST /auth/login) ---

async function login(args, apiBase) {
  const username = env.SCRN_AGENT_USERNAME || '__screenshot_agent';
  const password = env.SCRN_AGENT_PASSWORD;
  const endpoint = `${apiBase}/auth/login`;
  log(args, `login: POST ${endpoint} (username=${username})`);
  let res;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
  } catch (e) {
    const netExit = classifyFetchError(e);
    if (netExit !== null) {
      err(`network error during login: ${e.message}`);
      exit(EXIT_NETWORK);
    }
    err(`login fetch failed: ${e.message}`);
    exit(EXIT_AUTH);
  }
  // NestJS @Post() по умолчанию возвращает 201 на успех; принимаем оба
  // 200 и 201 как успех. Остальные коды — auth fail.
  if (res.status !== 200 && res.status !== 201) {
    let body = '';
    try { body = await res.text(); } catch { /* ignore */ }
    err(`login HTTP ${res.status}: ${body.slice(0, 300)}`);
    exit(EXIT_AUTH);
  }
  const data = await res.json().catch(() => ({}));
  if (!data.accessToken || !data.refreshToken) {
    err('login response missing accessToken/refreshToken');
    exit(EXIT_AUTH);
  }
  log(args, `login: OK (accessToken len=${data.accessToken.length}, refreshToken len=${data.refreshToken.length})`);
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

  // 1. Login (если auth=test) — до запуска браузера: дёшево валидируем
  // creds и сетевую достижимость API. fetch ошибки → exit 1/4.
  let tokens = null;
  if (args.auth === 'test') {
    const apiBase = deriveApiBase(args.url);
    if (!apiBase) {
      err(`cannot derive API base from --url=${args.url}; set SCRN_API_BASE_URL`);
      exit(EXIT_AUTH);
    }
    tokens = await login(args, apiBase);
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
    // токены в localStorage по тем же ключам, что использует фронт
    // (см. apps/web/src/contexts/AuthContext.tsx — `token`/`refreshToken`).
    const initParts = [];
    if (tokens) {
      initParts.push(
        `localStorage.setItem('token', ${JSON.stringify(tokens.accessToken)});`,
        `localStorage.setItem('refreshToken', ${JSON.stringify(tokens.refreshToken)});`,
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
