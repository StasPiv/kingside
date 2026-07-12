#!/usr/bin/env node
/**
 * KS-4904 (ADR-161): общий модуль браузерных сессий основателя.
 *
 * Отвечает за:
 *  - конфигурацию платформ (адреса, маркеры залогиненного/разлогиненного UI);
 *  - детект разлогина (isLoggedIn / assertLoggedIn);
 *  - открытие контекста из storageState и ОБЯЗАТЕЛЬНУЮ обратную запись
 *    состояния после каждого использования (ротация cookie продлевает сессию);
 *  - file-lock: один браузер на платформу одновременно (ADR-161 §2.2).
 *
 * Паролей здесь нет и быть не может: только перенесённый storageState.
 */

import { existsSync, chmodSync, writeFileSync, unlinkSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SESSIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'sessions');

/**
 * Маркеры подобраны по устойчивым элементам UI:
 *  - loggedIn: элемент, который существует ТОЛЬКО у залогиненного пользователя;
 *  - loggedOut: элемент, который существует ТОЛЬКО у анонима.
 * Решение принимается по обоим спискам; «ничего не найдено» = неопределённость
 * (страница не доросла) — это НЕ разлогин, чтобы не дёргать основателя зря.
 */
export const PLATFORMS = {
  x: {
    home: 'https://x.com/home',
    loggedIn: [
      '[data-testid="SideNav_AccountSwitcher_Button"]',
      'a[data-testid="AppTabBar_Profile_Link"]',
      '[data-testid="tweetTextarea_0"]',
    ],
    loggedOut: [
      'a[data-testid="loginButton"]',
      'a[href="/i/flow/login"]',
      '[data-testid="signupButton"]',
    ],
  },
  reddit: {
    // old.reddit: стабильная разметка, её же используют читалки
    home: 'https://old.reddit.com/',
    loggedIn: [
      '#header-bottom-right .user a[href*="/user/"]',
      'form.logout',
    ],
    loggedOut: [
      '#header-bottom-right .login-required',
      'a[href*="/login"]',
    ],
  },
};

export const statePath = (platform) => join(SESSIONS_DIR, `${platform}.storageState.json`);
const lockPath = (platform) => join(SESSIONS_DIR, `${platform}.lock`);
const LOCK_STALE_MS = 30 * 60 * 1000;

export class LoggedOutError extends Error {
  constructor(platform) {
    super(`Сессия ${platform} разлогинена — нужен повторный захват (session-capture.mjs)`);
    this.platform = platform;
    this.code = 'LOGGED_OUT';
  }
}

/** true | false | null (неопределённость: ни одного маркера не найдено) */
export async function isLoggedIn(page, platform) {
  const cfg = PLATFORMS[platform];
  if (!cfg) throw new Error(`Неизвестная платформа: ${platform}`);
  for (const sel of cfg.loggedIn) {
    if (await page.$(sel)) return true;
  }
  for (const sel of cfg.loggedOut) {
    if (await page.$(sel)) return false;
  }
  return null;
}

/** Бросает LoggedOutError при явном разлогине. Неопределённость разлогином не считается. */
export async function assertLoggedIn(page, platform) {
  const ok = await isLoggedIn(page, platform);
  if (ok === false) throw new LoggedOutError(platform);
  return ok;
}

function acquireLock(platform) {
  const p = lockPath(platform);
  if (existsSync(p)) {
    const age = Date.now() - statSync(p).mtimeMs;
    if (age < LOCK_STALE_MS) {
      throw new Error(`Платформа ${platform} занята (${p}, ${Math.round(age / 60000)} мин). Параллельные сессии из одного state запрещены (ADR-161 §2.2).`);
    }
    unlinkSync(p); // протухший lock от упавшего процесса
  }
  writeFileSync(p, String(process.pid), { flag: 'wx' });
  return () => { try { unlinkSync(p); } catch { /* уже снят */ } };
}

/** Обратная запись состояния + права 0600. Вызывается после КАЖДОГО использования. */
export async function saveState(context, platform) {
  const p = statePath(platform);
  await context.storageState({ path: p });
  chmodSync(p, 0o600);
}

/**
 * Основной вход: withSession('x', async (page, context) => {...})
 *  - берёт lock платформы;
 *  - контекст из storageState (реальный UA без headless-меток, фиксированный viewport);
 *  - открывает домашнюю страницу и проверяет логин;
 *  - выполняет fn;
 *  - ВСЕГДА пишет storageState обратно (даже если fn упал — cookie могли обновиться);
 *  - снимает lock и закрывает браузер.
 */
export async function withSession(platform, fn, { chromium, headless = true } = {}) {
  if (!chromium) ({ chromium } = await import('playwright'));
  const sp = statePath(platform);
  if (!existsSync(sp)) {
    throw new Error(`Нет ${sp} — сессия не перенесена. Порядок: tools/marketing/sessions/README.md`);
  }
  const release = acquireLock(platform);
  const browser = await chromium.launch({ headless });
  try {
    const context = await browser.newContext({
      storageState: sp,
      viewport: { width: 1440, height: 900 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      locale: 'en-US',
      timezoneId: 'Europe/Prague',
    });
    const page = await context.newPage();
    await page.goto(PLATFORMS[platform].home, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(2000 + Math.floor(Math.random() * 2000)); // джиттер живого человека
    await assertLoggedIn(page, platform);
    try {
      return await fn(page, context);
    } finally {
      await saveState(context, platform); // обратная запись всегда
    }
  } finally {
    await browser.close();
    release();
  }
}
