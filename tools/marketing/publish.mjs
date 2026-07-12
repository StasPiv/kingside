#!/usr/bin/env node
/**
 * KS-4906 (ADR-161): публикация ОДОБРЕННОГО черновика браузером под сессией.
 *
 * Запускается агентом ТОЛЬКО после ответа основателя в Telegram
 * (черновик со статусом approved в drafts-state.json). Порядок контура —
 * tools/marketing/publish-flow.md.
 *
 * Использование:
 *   node tools/marketing/publish.mjs <draft-id>          — опубликовать одобренный черновик
 *   node tools/marketing/publish.mjs --resume <x|reddit> — снять стоп-кран (вручную, после разбора)
 *
 * Коды выхода: 0 ок; 3 разлогин; 4 лимит/отказ; 5 стоп-кран сработал; 1 прочее.
 */

import { withSession, LoggedOutError } from './session-lib.mjs';
import { jitter } from './browse-lib.mjs';
import {
  loadDrafts, saveDrafts, actionDenied, recordAction, haltPlatform, resumePlatform,
  detectChallenge, fillRedditComment, fillXReply, appendPublished,
} from './publish-lib.mjs';

const [arg1, arg2] = process.argv.slice(2);

if (arg1 === '--resume' && arg2) {
  resumePlatform(arg2);
  console.log(`Стоп-кран ${arg2} снят.`);
  process.exit(0);
}

const drafts = loadDrafts();
const draft = drafts[arg1];
if (!draft) {
  console.error(`Черновик «${arg1}» не найден. Есть: ${Object.keys(drafts).join(', ') || 'ничего'}`);
  process.exit(2);
}
if (draft.status !== 'approved') {
  console.error(`Черновик ${arg1} в статусе «${draft.status}» — публикуются только approved (подтверждение основателя в Telegram).`);
  process.exit(4);
}

const { platform, url, text, subreddit } = draft;
const denied = actionDenied(platform, { subreddit });
if (denied) {
  console.error(`[limit] ${denied}`);
  process.exit(4);
}

// Discord публикуется существующим API-механизмом (user-токен, как discord-read),
// браузер не нужен (ADR-161 §2.2); контур подтверждения/лимитов — общий.
if (platform === 'discord') {
  const { readFileSync, writeFileSync } = await import('node:fs');
  const token = readFileSync(new URL('./.discord-token', import.meta.url), 'utf8').trim();
  const chan = /discord\.com\/channels\/\d+\/(\d+)/.exec(url)?.[1];
  if (!chan) { console.error(`[error] в url черновика нет id канала: ${url}`); process.exit(1); }
  const res = await fetch(`https://discord.com/api/v9/channels/${chan}/messages`, {
    method: 'POST',
    headers: { Authorization: token, 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36' },
    body: JSON.stringify({ content: text }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) { console.error(`[error] Discord API ${res.status}: ${body.message || ''}`); process.exit(1); }
  recordAction(platform, {});
  appendPublished({ platform, url: `${url.replace(/\/$/, '')}/${body.id}`, note: draft.note });
  draft.status = 'published';
  draft.publishedAt = Date.now();
  saveDrafts(drafts);
  console.log(`Опубликовано: ${url} (discord, сообщение ${body.id}). Записано в published.md, счётчики обновлены.`);
  process.exit(0);
}

try {
  await withSession(platform, async (page) => {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await jitter();
    const challenge = await detectChallenge(page);
    if (challenge) {
      haltPlatform(platform, challenge);
      throw Object.assign(new Error(`СТОП-КРАН: ${challenge}. Платформа ${platform} остановлена, основателю нужно сообщить в Telegram.`), { code: 5 });
    }
    if (platform === 'reddit') await fillRedditComment(page, text);
    else if (platform === 'x') await fillXReply(page, text);
    else throw new Error(`Платформа ${platform} браузерным контуром не публикуется`);
    await jitter(3000, 6000); // дождаться обработки отправки
    recordAction(platform, { subreddit });
    appendPublished({ platform, url, note: draft.note });
    draft.status = 'published';
    draft.publishedAt = Date.now();
    saveDrafts(drafts);
    console.log(`Опубликовано: ${url} (${platform}). Записано в published.md, счётчики обновлены.`);
  });
} catch (e) {
  console.error(`[error] ${e.message}`);
  if (e instanceof LoggedOutError) { haltPlatform(platform, 'разлогин'); process.exit(3); }
  process.exit(e.code === 5 ? 5 : 1);
}
