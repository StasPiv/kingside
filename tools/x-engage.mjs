#!/usr/bin/env node
/**
 * KS-4908 (расширение по запросу основателя): лёгкие реакции в X под сессией.
 *
 *  - лайк — агент ставит АВТОНОМНО, когда уверен (без подтверждения);
 *    лимит 10/день, пауза ≥2 мин;
 *  - репост — только через черновик с подтверждением в боте (draft.kind =
 *    'repost' → publish.mjs), лимит 3/день; этот CLI репостит уже одобренное.
 *
 * Использование:
 *   node tools/x-engage.mjs like <tweet-url>
 *   node tools/x-engage.mjs repost <tweet-url>
 *
 * Коды выхода: 0 ок (или уже стояло); 3 разлогин; 4 лимит; 5 стоп-кран; 1 прочее.
 */

import { withSession, LoggedOutError } from './marketing/session-lib.mjs';
import { jitter } from './marketing/browse-lib.mjs';
import { actionDenied, recordAction, haltPlatform, detectChallenge, likeTweet, repostTweet, appendPublished } from './marketing/publish-lib.mjs';

const [action, url] = process.argv.slice(2);
if (!['like', 'repost'].includes(action) || !/^https:\/\/x\.com\//.test(url || '')) {
  console.error('Использование: node tools/x-engage.mjs <like|repost> <https://x.com/...>');
  process.exit(2);
}

const key = `x-${action}`;
const denied = actionDenied(key);
if (denied) { console.error(`[limit] ${denied}`); process.exit(4); }

try {
  await withSession('x', async (page) => {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await jitter();
    const challenge = await detectChallenge(page);
    if (challenge) {
      haltPlatform('x', challenge);
      throw Object.assign(new Error(`СТОП-КРАН: ${challenge}`), { code: 5 });
    }
    const result = action === 'like' ? await likeTweet(page) : await repostTweet(page);
    if (result === 'already') { console.log(`уже стояло: ${url}`); return; }
    await jitter(1500, 3000);
    recordAction(key);
    if (action === 'repost') appendPublished({ platform: 'x', url, note: 'репост' });
    console.log(`${action === 'like' ? 'Лайк поставлен' : 'Репост сделан'}: ${url}`);
  });
} catch (e) {
  console.error(`[error] ${e.message}`);
  if (e instanceof LoggedOutError) { haltPlatform('x', 'разлогин'); process.exit(3); }
  process.exit(e.code === 5 ? 5 : 1);
}
