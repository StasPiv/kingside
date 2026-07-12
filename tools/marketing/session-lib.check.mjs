#!/usr/bin/env node
/**
 * KS-4904: быстрая проверка модуля session-lib (детект разлогина + lock).
 * Живых сессий не требует: маркеры проверяются на локальном HTML в headless
 * Chromium, lock — на файловой системе.
 *
 * Запуск: node tools/marketing/session-lib.check.mjs
 */

import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { PLATFORMS, isLoggedIn, assertLoggedIn, LoggedOutError, SESSIONS_DIR } from './session-lib.mjs';

const { chromium } = await import('playwright');

const FIXTURES = {
  x: {
    loggedIn: '<div data-testid="SideNav_AccountSwitcher_Button"></div><main>timeline</main>',
    loggedOut: '<a data-testid="loginButton" href="/i/flow/login">Log in</a>',
    unknown: '<div id="splash">loading…</div>',
  },
  reddit: {
    loggedIn: '<div id="header-bottom-right"><span class="user"><a href="/user/Stas-Pivovartsev/">Stas</a></span></div>',
    loggedOut: '<div id="header-bottom-right"><span class="user login-required"><a href="https://old.reddit.com/login">login</a></span></div>',
    unknown: '<div id="splash">loading…</div>',
  },
};

let failed = 0;
const check = (name, cond) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}`);
  if (!cond) failed++;
};

const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext()).newPage();

for (const platform of Object.keys(PLATFORMS)) {
  const f = FIXTURES[platform];

  await page.setContent(f.loggedIn);
  check(`${platform}: залогинен → true`, (await isLoggedIn(page, platform)) === true);
  check(`${platform}: залогинен → assertLoggedIn не бросает`,
    await assertLoggedIn(page, platform).then(() => true, () => false));

  await page.setContent(f.loggedOut);
  check(`${platform}: разлогинен → false`, (await isLoggedIn(page, platform)) === false);
  const err = await assertLoggedIn(page, platform).then(() => null, (e) => e);
  check(`${platform}: разлогинен → LoggedOutError(platform=${platform})`,
    err instanceof LoggedOutError && err.platform === platform && err.code === 'LOGGED_OUT');

  await page.setContent(f.unknown);
  check(`${platform}: страница не доросла → null (НЕ разлогин)`, (await isLoggedIn(page, platform)) === null);
  check(`${platform}: неопределённость → assertLoggedIn не бросает`,
    await assertLoggedIn(page, platform).then(() => true, () => false));
}

await browser.close();

// Lock: занятая платформа не даёт второй сессии стартовать.
// Подложный storageState нужен, чтобы дойти до проверки lock (браузер при
// этом не запускается: отказ происходит до launch).
const { withSession, statePath } = await import('./session-lib.mjs');
const lockFile = join(SESSIONS_DIR, 'x.lock');
const fakeState = statePath('x');
const hadRealState = (await import('node:fs')).existsSync(fakeState);
if (!hadRealState) writeFileSync(fakeState, '{"cookies":[],"origins":[]}');
writeFileSync(lockFile, '12345');
const lockErr = await withSession('x', async () => {}, { chromium }).then(() => null, (e) => e);
check('lock: свежий x.lock → withSession отказывает с «занята»', /занята/.test(lockErr?.message || ''));
unlinkSync(lockFile);
if (!hadRealState) unlinkSync(fakeState);

// Без storageState — понятный отказ с отсылкой к README
const noStateErr = await withSession('reddit', async () => {}, { chromium }).then(() => null, (e) => e);
check('нет storageState → отказ с отсылкой к README', /README/.test(noStateErr?.message || ''));

console.log(failed ? `\n${failed} проверок провалено` : '\nВсе проверки пройдены');
process.exit(failed ? 1 : 0);
