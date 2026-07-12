#!/usr/bin/env node
/**
 * KS-4906 (ADR-161, задача 3/4): публикация с подтверждением — состояние и механика.
 *
 *  - счётчики действий за день (actions-state.json) и лимиты стратегии §3.4
 *    + потолки ADR §3.2 (≥10 мин между действиями на платформе);
 *  - реестр черновиков с Telegram-подтверждением (drafts-state.json,
 *    таймаут 4 часа → черновик сгорает, ADR §4);
 *  - стоп-кран: капча/челлендж/разлогин → платформа останавливается флагом
 *    halt до ручного снятия, никаких ретраев (ADR §3.2);
 *  - заполнение форм комментария (X / old.reddit) — отделено от отправки,
 *    проверяется на фикстурах;
 *  - лог публикаций в briefs/published.md.
 *
 * Все состояния — в tools/marketing/sessions/ (не в общем /tmp, ADR §3.1).
 */

import { readFileSync, writeFileSync, chmodSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SESSIONS_DIR } from './session-lib.mjs';

const ACTIONS_STATE = join(SESSIONS_DIR, 'actions-state.json');
const DRAFTS_STATE = join(SESSIONS_DIR, 'drafts-state.json');
const PUBLISHED_MD = join(dirname(fileURLToPath(import.meta.url)), 'briefs', 'published.md');

export const DRAFT_TTL_MS = 4 * 60 * 60 * 1000; // 4 часа (ADR §4)
export const MIN_GAP_MIN = 10; // ≥10 мин между действиями на платформе (ADR §3.2)

/** Дневные потолки: ADR §3.2 (публикации) ∩ стратегия §3.4. */
export const DAILY_LIMITS = {
  x: { total: 5 },
  reddit: { total: 5, perSubreddit: 2 }, // до 100 кармы; после — поднять в стратегии
  discord: { total: 5 },
};

const load = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return {}; } };
const save = (p, data) => { writeFileSync(p, JSON.stringify(data, null, 2)); chmodSync(p, 0o600); };
const dayKey = (now) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Prague' }).format(now);

// --- Счётчики и стоп-кран ---

export function loadActions() { return load(ACTIONS_STATE); }

/** null — можно действовать; строка — причина отказа. Инъекции — для проверок. */
export function actionDenied(platform, { subreddit, now = new Date(), state } = {}) {
  const s = state ?? loadActions();
  const p = s[platform] || {};
  if (p.halted) return `СТОП-КРАН: ${p.halted.reason} (${p.halted.at}). Снятие — вручную после разбора.`;
  const limits = DAILY_LIMITS[platform];
  if (!limits) return `неизвестная платформа ${platform}`;
  const day = p[dayKey(now)] || { count: 0, bySub: {} };
  if (day.count >= limits.total) return `дневной лимит публикаций ${platform}: ${limits.total}`;
  if (limits.perSubreddit && subreddit && (day.bySub[subreddit] || 0) >= limits.perSubreddit) {
    return `лимит ${limits.perSubreddit}/день в r/${subreddit}`;
  }
  if (p.lastActionAt && (now.getTime() - p.lastActionAt) / 60000 < MIN_GAP_MIN) {
    return `пауза между действиями <${MIN_GAP_MIN} мин`;
  }
  return null;
}

export function recordAction(platform, { subreddit, now = new Date(), state } = {}) {
  const s = state ?? loadActions();
  const p = (s[platform] ||= {});
  const day = (p[dayKey(now)] ||= { count: 0, bySub: {} });
  day.count++;
  if (subreddit) day.bySub[subreddit] = (day.bySub[subreddit] || 0) + 1;
  p.lastActionAt = now.getTime();
  if (!state) save(ACTIONS_STATE, s);
  return s;
}

export function haltPlatform(platform, reason, { now = new Date(), state } = {}) {
  const s = state ?? loadActions();
  (s[platform] ||= {}).halted = { reason, at: now.toISOString() };
  if (!state) save(ACTIONS_STATE, s);
  return s;
}

export function resumePlatform(platform, { state } = {}) {
  const s = state ?? loadActions();
  if (s[platform]) delete s[platform].halted;
  if (!state) save(ACTIONS_STATE, s);
  return s;
}

// --- Реестр черновиков (подтверждение в Telegram) ---

export function loadDrafts() { return load(DRAFTS_STATE); }
export function saveDrafts(state) { save(DRAFTS_STATE, state); }

export function addDraft({ platform, url, text, subreddit, note }, { now = new Date(), state } = {}) {
  const s = state ?? loadDrafts();
  const id = `d${Object.keys(s).length + 1}-${dayKey(now).replaceAll('-', '')}`;
  s[id] = { platform, url, text, subreddit, note, status: 'pending', sentAt: now.getTime() };
  if (!state) save(DRAFTS_STATE, s);
  return id;
}

/**
 * Разбор ответа основателя: 'ok' → approved (текст как есть);
 * 'skip' → skipped; любой другой текст → approved с правкой основателя.
 */
export function resolveDraft(id, reply, { now = new Date(), state } = {}) {
  const s = state ?? loadDrafts();
  const d = s[id];
  if (!d) throw new Error(`Черновик ${id} не найден`);
  if (d.status !== 'pending') throw new Error(`Черновик ${id} уже ${d.status}`);
  if (now.getTime() - d.sentAt > DRAFT_TTL_MS) {
    d.status = 'expired';
  } else {
    const r = reply.trim();
    if (/^skip$/i.test(r)) d.status = 'skipped';
    else { d.status = 'approved'; if (!/^ok$/i.test(r)) d.text = r; }
  }
  if (!state) save(DRAFTS_STATE, s);
  return d;
}

/** Протухшие pending-черновики сгорают (вызывается каждым циклом). */
export function expireDrafts({ now = new Date(), state } = {}) {
  const s = state ?? loadDrafts();
  const expired = [];
  for (const [id, d] of Object.entries(s)) {
    if (d.status === 'pending' && now.getTime() - d.sentAt > DRAFT_TTL_MS) {
      d.status = 'expired';
      expired.push(id);
    }
  }
  if (!state && expired.length) save(DRAFTS_STATE, s);
  return expired;
}

// --- Детект капчи/челленджа (стоп-кран) ---

const CHALLENGE_SELECTORS = [
  'iframe[src*="hcaptcha"]', 'iframe[src*="recaptcha"]', 'iframe[src*="arkoselabs"]',
  '#challenge-form', '[data-testid="ocfEnterTextTextInput"]',
];
const CHALLENGE_TEXTS = [/unusual activity/i, /verify (you('| a)re|it'?s you)/i, /suspicious activity/i, /rate limit/i];

export async function detectChallenge(page) {
  for (const sel of CHALLENGE_SELECTORS) {
    if (await page.$(sel)) return `элемент челленджа: ${sel}`;
  }
  const body = (await page.textContent('body').catch(() => '')) || '';
  for (const re of CHALLENGE_TEXTS) {
    if (re.test(body)) return `текст челленджа: ${re}`;
  }
  return null;
}

// --- Заполнение форм (отправка отделена — проверяемо на фикстурах) ---

/** old.reddit: комментарий верхнего уровня на странице треда. */
export async function fillRedditComment(page, text, { submit = true } = {}) {
  const area = await page.$('.commentarea form.usertext textarea[name="text"]');
  if (!area) throw new Error('Форма комментария не найдена (тред закрыт или разметка уехала)');
  await area.fill(text);
  if (submit) await page.click('.commentarea form.usertext button[type="submit"]');
  return true;
}

/** X: реплай на открытой странице твита. */
export async function fillXReply(page, text, { submit = true } = {}) {
  const area = await page.$('[data-testid="tweetTextarea_0"]');
  if (!area) throw new Error('Поле ответа не найдено (твит закрыт или разметка уехала)');
  await area.click();
  await page.keyboard.type(text, { delay: 30 + Math.floor(Math.random() * 40) });
  if (submit) await page.click('[data-testid="tweetButtonInline"], [data-testid="tweetButton"]');
  return true;
}

// --- Лог публикаций ---

export function appendPublished({ platform, url, note }, { now = new Date(), path = PUBLISHED_MD } = {}) {
  const line = `| ${dayKey(now)} | ${url} (${note || 'публикация'}) | опубликовано (${platform}, браузерный контур) |\n`;
  appendFileSync(path, line);
  return line;
}
