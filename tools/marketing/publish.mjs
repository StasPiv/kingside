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
  detectRedditPostDenied, addBlockedSub,
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

// Telegram: пост в канал @kingside_site ботом @kingside_marketing_bot (админ, 13.07).
// url черновика: https://t.me/kingside_site (информативно), канал задан константой.
if (platform === 'telegram') {
  const { readFileSync } = await import('node:fs');
  const tgToken = readFileSync(new URL('./.marketing-bot-token', import.meta.url), 'utf8').trim();
  const res = await fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: '@kingside_site', text, disable_web_page_preview: false }),
  });
  const body = await res.json().catch(() => ({}));
  if (!body.ok) { console.error(`[error] Telegram API: ${body.description || res.status}`); process.exit(1); }
  recordAction(platform, {});
  const postUrl = `https://t.me/kingside_site/${body.result.message_id}`;
  appendPublished({ platform, url: postUrl, note: draft.note });
  draft.status = 'published';
  draft.publishedAt = Date.now();
  saveDrafts(drafts);
  console.log(`Опубликовано: ${postUrl} (telegram). Записано в published.md, счётчики обновлены.`);
  process.exit(0);
}

// Discord публикуется существующим API-механизмом (user-токен, как discord-read),
// браузер не нужен (ADR-161 §2.2); контур подтверждения/лимитов — общий.
if (platform === 'discord') {
  const { readFileSync, writeFileSync } = await import('node:fs');
  const token = readFileSync(new URL('./.discord-token', import.meta.url), 'utf8').trim();
  const m = /discord\.com\/channels\/\d+\/(\d+)(?:\/(\d+))?/.exec(url);
  const chan = m?.[1];
  const replyTo = m?.[2]; // id сообщения в url → публикуем как «ответить», не в общий поток
  if (!chan) { console.error(`[error] в url черновика нет id канала: ${url}`); process.exit(1); }
  const payload = { content: text };
  if (replyTo) payload.message_reference = { message_id: replyTo, fail_if_not_exists: false };
  const res = await fetch(`https://discord.com/api/v9/channels/${chan}/messages`, {
    method: 'POST',
    headers: { Authorization: token, 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36' },
    body: JSON.stringify(payload),
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
    if (draft.kind === 'repost') {
      const { repostTweet } = await import('./publish-lib.mjs');
      await repostTweet(page);
    } else if (platform === 'reddit') await fillRedditComment(page, text);
    else if (platform === 'x') await fillXReply(page, text);
    else throw new Error(`Платформа ${platform} браузерным контуром не публикуется`);
    await jitter(3000, 6000); // дождаться обработки отправки
    // Reddit: отказ по карме/бану/закрытому сабу → в blocked, scan туда больше не лезет.
    if (platform === 'reddit') {
      const denied = await detectRedditPostDenied(page);
      if (denied) {
        addBlockedSub(subreddit, denied);
        throw Object.assign(new Error(`Отказ публикации в r/${subreddit}: ${denied}. Сабреддит добавлен в blocked.`), { code: 6 });
      }
    }
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
  process.exit(e.code === 5 ? 5 : e.code === 6 ? 6 : 1);
}
