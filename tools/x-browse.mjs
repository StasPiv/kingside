#!/usr/bin/env node
/**
 * KS-4905 (ADR-161): чтение живых лент X под сессией основателя.
 * Замена анонимного x-read (syndication, отставание в недели) в циклах.
 *
 * Использование:
 *   node tools/x-browse.mjs home                — домашняя лента (following)
 *   node tools/x-browse.mjs user chesscom       — лента аккаунта
 *   node tools/x-browse.mjs search "запрос"     — свежие по поиску (Latest)
 *
 * Ограничители (ADR-161 §3.2): 08:00–23:00 Prague, ≤1 цикла/30 мин,
 * без пагинации вглубь (максимум 2 прокрутки), джиттер 2–8 с.
 * Коды выхода: 0 — ок; 3 — разлогин (нужен повторный захват); 4 — ограничитель.
 */

import { withSession, LoggedOutError } from './marketing/session-lib.mjs';
import { extractTweets, guardOrExit, recordRead, jitter } from './marketing/browse-lib.mjs';

const [mode = 'home', arg] = process.argv.slice(2);
const targets = {
  home: () => 'https://x.com/home',
  user: (name) => `https://x.com/${name.replace(/^@/, '')}`,
  search: (q) => `https://x.com/search?q=${encodeURIComponent(q)}&f=live`,
};
if (!targets[mode] || (mode !== 'home' && !arg)) {
  console.error('Использование: node tools/x-browse.mjs <home | user <name> | search "<запрос>">');
  process.exit(2);
}

guardOrExit('x');

try {
  await withSession('x', async (page) => {
    if (mode !== 'home') {
      await page.goto(targets[mode](arg), { waitUntil: 'domcontentloaded', timeout: 45000 });
    }
    await page.waitForSelector('article[data-testid="tweet"]', { timeout: 30000 }).catch(() => {});
    const seen = new Map();
    for (let scroll = 0; scroll <= 2; scroll++) { // без пагинации вглубь (§3.2)
      for (const t of await extractTweets(page)) if (t.url) seen.set(t.url, t);
      if (scroll < 2) {
        await jitter();
        await page.mouse.wheel(0, 2500);
      }
    }
    recordRead('x');
    const list = [...seen.values()];
    console.log(`# x-browse ${mode}${arg ? ` ${arg}` : ''} — ${list.length} твитов (живая лента)\n`);
    for (const t of list) {
      console.log(`• ${t.date} @${t.author}`);
      console.log(`  ${t.text.replace(/\n/g, '\n  ')}`);
      console.log(`  ${t.url}\n`);
    }
  });
} catch (e) {
  console.error(`[error] ${e.message}`);
  process.exit(e instanceof LoggedOutError ? 3 : 1);
}
