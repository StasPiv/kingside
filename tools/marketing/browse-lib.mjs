#!/usr/bin/env node
/**
 * KS-4905 (ADR-161, задача 2/4): общее для браузерных читалок x-browse/reddit-browse.
 *
 *  - ограничители чтения ADR-161 §3.2: часы активности 08:00–23:00 Prague,
 *    ≤1 цикла ленты / 30 мин на платформу (reads-state.json), джиттер 2–8 с;
 *  - извлечение данных из DOM (чистые функции — проверяются на фикстурах
 *    без живых сессий);
 *  - file-lock и обратную запись storageState даёт session-lib.withSession.
 */

import { readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { SESSIONS_DIR } from './session-lib.mjs';

const READS_STATE = join(SESSIONS_DIR, 'reads-state.json');
// Порог чтения под сессией, единый для всех платформ (решение основателя
// 12.07: быстрая реакция на горячее важнее; лимиты ДЕЙСТВИЙ не тронуты,
// стоп-кран останавливает контур при первом же вызове проверки платформой).
export const READ_INTERVAL_MIN = 15;

// --- Ограничители (§3.2) ---

export function pragueHour(now = new Date()) {
  return Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone: 'Europe/Prague' }).format(now));
}

/** null — можно; строка — причина отказа. Инъекция now/state — для проверок. */
export function readDenied(platform, { now = new Date(), state } = {}) {
  const h = pragueHour(now);
  if (h < 8 || h >= 23) return `вне часов активности (08–23 Prague, сейчас ${h}ч)`;
  const s = state ?? loadReadsState();
  const last = s[platform]?.lastRead || 0;
  const minAgo = (now.getTime() - last) / 60000;
  if (minAgo < READ_INTERVAL_MIN) {
    return `лимит чтения: ≤1 цикла/${READ_INTERVAL_MIN} мин на платформу, прошло ${Math.floor(minAgo)} мин`;
  }
  return null;
}

export function loadReadsState() {
  try { return JSON.parse(readFileSync(READS_STATE, 'utf8')); } catch { return {}; }
}

export function recordRead(platform, now = new Date()) {
  const s = loadReadsState();
  s[platform] = { ...s[platform], lastRead: now.getTime() };
  writeFileSync(READS_STATE, JSON.stringify(s, null, 2));
  chmodSync(READS_STATE, 0o600);
}

/** Отказ по ограничителю: выход 4 (в циклах отличим от разлогина=3 и ошибки=1). */
export function guardOrExit(platform) {
  if (process.env.BROWSE_FORCE === '1') return; // только для отладки живой проверки
  const reason = readDenied(platform);
  if (reason) {
    console.error(`[guard] ${platform}: ${reason}`);
    process.exit(4);
  }
}

export const jitter = (min = 2000, max = 8000) =>
  new Promise((r) => setTimeout(r, min + Math.floor(Math.random() * (max - min))));

// --- Извлечение из DOM (выполняется в браузере через page.$$eval) ---

/** X: карточки твитов на любой странице-ленте (home/профиль/поиск). */
export async function extractTweets(page) {
  return page.$$eval('article[data-testid="tweet"]', (cards) =>
    cards.map((c) => {
      const timeEl = c.querySelector('time');
      const link = timeEl?.closest('a');
      const author = c.querySelector('[data-testid="User-Name"] a[href^="/"]');
      return {
        date: timeEl?.getAttribute('datetime')?.slice(0, 16).replace('T', ' ') || '?',
        author: author ? author.getAttribute('href').slice(1) : '?',
        text: c.querySelector('[data-testid="tweetText"]')?.innerText || '(медиа/цитата без текста)',
        url: link ? new URL(link.getAttribute('href'), 'https://x.com').href : '',
      };
    }),
  );
}

/** old.reddit: листинг тредов (hot/new/rising). */
export async function extractRedditListing(page) {
  return page.$$eval('#siteTable .thing.link', (things) =>
    things.map((t) => ({
      title: t.querySelector('a.title')?.innerText || '?',
      score: t.querySelector('.score.unvoted')?.getAttribute('title') || t.querySelector('.score.unvoted')?.innerText || '•',
      comments: (t.querySelector('a.comments')?.innerText || '0').replace(/\D+/g, '') || '0',
      url: t.dataset.permalink ? `https://old.reddit.com${t.dataset.permalink}` : '',
    })),
  );
}

/** old.reddit: входящие (ответы на наши комментарии) — прямая замена ручного обхода тредов. */
export async function extractRedditInbox(page) {
  return page.$$eval('#siteTable .thing', (things) =>
    things.map((t) => ({
      isNew: t.classList.contains('new'),
      from: t.querySelector('.author')?.innerText || '?',
      subject: t.querySelector('.subject a.title')?.innerText || t.dataset.type || '?',
      body: t.querySelector('.md')?.innerText?.slice(0, 500) || '',
      link: t.querySelector('.first a')?.href || t.querySelector('a.bylink')?.href || '',
    })),
  );
}
