#!/usr/bin/env node
/**
 * KS-4905 (ADR-161): чтение Reddit под сессией основателя (old.reddit).
 * Дополняет анонимный reddit-read: под сессией видны входящие (ответы на
 * наши комментарии) — прямая замена ручного обхода тредов из published.md.
 *
 * Использование:
 *   node tools/reddit-browse.mjs r/chess [hot|new|rising]
 *   node tools/reddit-browse.mjs inbox            — входящие (ответы/упоминания)
 *   node tools/reddit-browse.mjs inbox --unread   — только непрочитанные
 *
 * Ограничители (ADR-161 §3.2): 08:00–23:00 Prague, ≤1 цикла/30 мин,
 * без пагинации вглубь, джиттер. Коды выхода: 0 ок; 3 разлогин; 4 ограничитель.
 */

import { withSession, LoggedOutError } from './marketing/session-lib.mjs';
import { extractRedditListing, extractRedditInbox, guardOrExit, recordRead, jitter } from './marketing/browse-lib.mjs';

const [target, opt] = process.argv.slice(2);
if (!target) {
  console.error('Использование: node tools/reddit-browse.mjs <r/сабреддит [hot|new|rising] | inbox [--unread]>');
  process.exit(2);
}

guardOrExit('reddit');

try {
  await withSession('reddit', async (page) => {
    await jitter(1000, 3000);
    if (target === 'inbox') {
      const url = opt === '--unread' ? 'https://old.reddit.com/message/unread/' : 'https://old.reddit.com/message/inbox/';
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      const items = await extractRedditInbox(page);
      recordRead('reddit');
      console.log(`# reddit inbox${opt === '--unread' ? ' (непрочитанные)' : ''} — ${items.length}\n`);
      for (const m of items) {
        console.log(`• ${m.isNew ? '🆕 ' : ''}${m.from} — ${m.subject}`);
        if (m.body) console.log(`  ${m.body.replace(/\n/g, ' ⏎ ')}`);
        if (m.link) console.log(`  ${m.link}`);
        console.log();
      }
    } else {
      const sub = target.replace(/^\/?(r\/)?/, '');
      const sort = ['hot', 'new', 'rising'].includes(opt) ? opt : 'hot';
      await page.goto(`https://old.reddit.com/r/${sub}/${sort === 'hot' ? '' : sort}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
      const list = await extractRedditListing(page);
      recordRead('reddit');
      console.log(`# r/${sub} (${sort}, под сессией) — ${list.length} тредов\n`);
      for (const t of list) {
        console.log(`• ${t.title}`);
        console.log(`  score=${t.score} comments=${t.comments} ${t.url}\n`);
      }
    }
  });
} catch (e) {
  console.error(`[error] ${e.message}`);
  process.exit(e instanceof LoggedOutError ? 3 : 1);
}
