#!/usr/bin/env node
/**
 * KS-4904 (ADR-161): захват залогиненной сессии — запускается НА МАШИНЕ
 * ОСНОВАТЕЛЯ (headed-браузер), не в контейнере.
 *
 * Что делает:
 *  1. Открывает видимый Chromium на странице входа платформы.
 *  2. Вы вручную логинитесь (пароль/2FA — всё как обычно; скрипт паролей
 *     не видит и не сохраняет).
 *  3. Скрипт сам замечает успешный вход, сохраняет storageState
 *     (cookie + localStorage) в <platform>.storageState.json (права 0600)
 *     и закрывает браузер.
 *
 * Использование (из корня репозитория):
 *   node tools/marketing/session-capture.mjs x
 *   node tools/marketing/session-capture.mjs reddit
 *   node tools/marketing/session-capture.mjs x /куда/сохранить
 *
 * Требования на машине: Node 20+, npm i playwright && npx playwright install chromium
 * Перенос файла на сервер — tools/marketing/sessions/README.md.
 */

import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { PLATFORMS, isLoggedIn } from './session-lib.mjs';

const [platform, outDir] = process.argv.slice(2);
if (!PLATFORMS[platform]) {
  console.error(`Использование: node tools/marketing/session-capture.mjs <${Object.keys(PLATFORMS).join('|')}> [папка]`);
  process.exit(2);
}

const { chromium } = await import('playwright');
const dir = outDir || process.cwd();
mkdirSync(dir, { recursive: true });
const out = join(dir, `${platform}.storageState.json`);

console.log(`Открываю браузер. Войдите в ${platform} как обычно — я сохраню сессию сам и закрою окно.`);
const browser = await chromium.launch({ headless: false });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
await page.goto(PLATFORMS[platform].home, { waitUntil: 'domcontentloaded' });

// Ждём подтверждённого входа до 10 минут (2FA бывает медленной)
const deadline = Date.now() + 10 * 60 * 1000;
let confirmed = 0;
while (Date.now() < deadline) {
  await page.waitForTimeout(3000);
  let ok = null;
  try {
    ok = await isLoggedIn(page, platform);
  } catch { /* навигация в момент проверки — просто следующая итерация */ }
  // два подтверждения подряд, чтобы не поймать промежуточный редирект
  confirmed = ok === true ? confirmed + 1 : 0;
  if (confirmed >= 2) {
    await context.storageState({ path: out });
    chmodSync(out, 0o600);
    console.log(`\nГотово: ${out} (права 0600).`);
    console.log('Дальше — перенос на сервер: tools/marketing/sessions/README.md');
    await browser.close();
    process.exit(0);
  }
}
console.error('Вход не подтвердился за 10 минут — ничего не сохранено. Запустите ещё раз.');
await browser.close();
process.exit(1);
