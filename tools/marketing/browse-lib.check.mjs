#!/usr/bin/env node
/**
 * KS-4905: быстрая проверка browse-lib без живых сессий.
 * Экстракторы — на HTML-фикстурах в headless Chromium, ограничители — на
 * инъецированных времени/состоянии.
 *
 * Запуск: node tools/marketing/browse-lib.check.mjs
 */

import { extractTweets, extractRedditListing, extractRedditInbox, readDenied, READ_INTERVAL_MIN } from './browse-lib.mjs';

const { chromium } = await import('playwright');
let failed = 0;
const check = (name, cond) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}`); if (!cond) failed++; };

// --- Ограничители ---
const at = (iso) => new Date(iso); // Prague летом = UTC+2
const fresh = { x: { lastRead: at('2026-07-12T10:00:00Z').getTime() } };

check('часы: 06:59 Prague → отказ', /часов активности/.test(readDenied('x', { now: at('2026-07-12T04:59:00Z'), state: {} }) || ''));
check('часы: 07:00 Prague → можно', readDenied('x', { now: at('2026-07-12T05:00:00Z'), state: {} }) === null);
check('часы: 22:30 Prague → отказ', /часов активности/.test(readDenied('x', { now: at('2026-07-12T20:30:00Z'), state: {} }) || ''));
check('часы: 12:00 Prague, состояния нет → можно', readDenied('x', { now: at('2026-07-12T10:00:00Z'), state: {} }) === null);
// Лимит чтения снят пользователем 13.07 (READ_INTERVAL_MIN=0): интервал-тесты только при ненулевом лимите
if (READ_INTERVAL_MIN > 0) {
  check(`интервал: прошло 10 мин → отказ (лимит ${READ_INTERVAL_MIN})`, /лимит чтения/.test(readDenied('x', { now: at('2026-07-12T10:10:00Z'), state: fresh }) || ''));
  check('интервал: прошло 31 мин → можно', readDenied('x', { now: at('2026-07-12T10:31:00Z'), state: fresh }) === null);
}
check('лимит 0: чтение сразу после чтения → можно', readDenied('x', { now: at('2026-07-12T10:01:00Z'), state: fresh }) === null || READ_INTERVAL_MIN > 0);
check('интервал: платформы независимы (reddit можно при занятом x)', readDenied('reddit', { now: at('2026-07-12T10:10:00Z'), state: fresh }) === null);

// --- Экстракторы ---
const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext()).newPage();

await page.setContent(`
  <article data-testid="tweet">
    <div data-testid="User-Name"><a href="/chesscom"><span>Chess.com</span></a></div>
    <a href="/chesscom/status/123"><time datetime="2026-07-12T08:00:00.000Z">2h</time></a>
    <div data-testid="tweetText">WSCC quarterfinals today!</div>
  </article>
  <article data-testid="tweet">
    <div data-testid="User-Name"><a href="/GothamChess"><span>Levy</span></a></div>
    <a href="/GothamChess/status/456"><time datetime="2026-07-12T09:30:00.000Z">1h</time></a>
  </article>`);
const tweets = await extractTweets(page);
check('x: извлечены 2 твита', tweets.length === 2);
check('x: автор/дата/url', tweets[0].author === 'chesscom' && tweets[0].date === '2026-07-12 08:00' && tweets[0].url === 'https://x.com/chesscom/status/123');
check('x: текст твита', tweets[0].text === 'WSCC quarterfinals today!');
check('x: твит без текста → заглушка', /без текста/.test(tweets[1].text));

await page.setContent(`
  <div id="siteTable">
    <div class="thing link" data-permalink="/r/chess/comments/abc/test_thread/">
      <a class="title">Test thread</a>
      <div class="score unvoted" title="512">512</div>
      <a class="comments">48 comments</a>
    </div>
  </div>`);
const listing = await extractRedditListing(page);
check('reddit: листинг извлечён', listing.length === 1 && listing[0].title === 'Test thread');
check('reddit: score/comments/url', listing[0].score === '512' && listing[0].comments === '48' && listing[0].url === 'https://old.reddit.com/r/chess/comments/abc/test_thread/');

await page.setContent(`
  <div id="siteTable">
    <div class="thing new" data-type="comment">
      <p class="subject"><a class="title">comment reply</a></p>
      <a class="author">someuser</a>
      <div class="md">Thanks, this actually helped me beat the Advance Caro!</div>
      <ul><li class="first"><a href="https://old.reddit.com/r/chess/comments/abc/-/xyz?context=3">context</a></li></ul>
    </div>
  </div>`);
const inbox = await extractRedditInbox(page);
check('reddit inbox: ответ извлечён', inbox.length === 1 && inbox[0].from === 'someuser' && inbox[0].isNew === true);
check('reddit inbox: тело и ссылка', /Advance Caro/.test(inbox[0].body) && /context=3/.test(inbox[0].link));

await browser.close();
console.log(failed ? `\n${failed} проверок провалено` : '\nВсе проверки пройдены');
process.exit(failed ? 1 : 0);
