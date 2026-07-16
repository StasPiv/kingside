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

import { readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SESSIONS_DIR } from './session-lib.mjs';

const ACTIONS_STATE = join(SESSIONS_DIR, 'actions-state.json');
const DRAFTS_STATE = join(SESSIONS_DIR, 'drafts-state.json');
const BLOCKED_SUBS = join(SESSIONS_DIR, 'blocked-subreddits.json');
const PUBLISHED_MD = join(dirname(fileURLToPath(import.meta.url)), 'briefs', 'published.md');

export const DRAFT_TTL_MS = 4 * 60 * 60 * 1000; // 4 часа (ADR §4)
export const MIN_GAP_MIN = 0; // лимиты сняты пользователем 12.07 (каждая публикация и так проходит его «ok»)

/** Лимиты сняты пользователем 12.07: публикации идут только после его подтверждения,
 * темп задаёт человек. Стоп-кран (haltPlatform при детекте проверки) сохранён. */
export const DAILY_LIMITS = {
  x: { total: Infinity },
  reddit: { total: Infinity, perSubreddit: Infinity },
  discord: { total: Infinity },
  telegram: { total: Infinity }, // канал @kingside_site (создан пользователем 13.07)
  'x-like': { total: Infinity, gapMin: 0 },
  'x-repost': { total: Infinity },
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
  const gapMin = limits.gapMin ?? MIN_GAP_MIN;
  if (p.lastActionAt && (now.getTime() - p.lastActionAt) / 60000 < gapMin) {
    return `пауза между действиями <${gapMin} мин`;
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

// Черновик-предложение нового источника мониторинга. Пользователь одобряет
// `ok` в Telegram → листенер вызывает addSource и дописывает в конфиг.
export function addSourceProposal({ sourceType, sourceValue, note }, { now = new Date(), state } = {}) {
  const s = state ?? loadDrafts();
  const id = `src${Object.keys(s).length + 1}-${dayKey(now).replaceAll('-', '')}`;
  s[id] = {
    kind: 'source-add', sourceType, sourceValue,
    platform: sourceType, url: '', note,
    text: `Предложение: добавить источник [${sourceType}] «${sourceValue}» в мониторинг.${note ? ` ${note}` : ''}`,
    status: 'pending', sentAt: now.getTime(),
  };
  if (!state) save(DRAFTS_STATE, s);
  return id;
}

// --- Добавление источника мониторинга (по одобрению пользователя) ---
// Дописывает value в prefilter-config.json. sourceType:
//   'subreddit' → reddit.subreddits, 'x-query' → x.searchQueries,
//   'discord-channel' → discord.channels. Дедуп. Возвращает {added, network, key}.
export function addSource(sourceType, value) {
  const CFG = join(dirname(fileURLToPath(import.meta.url)), 'prefilter-config.json');
  const cfg = JSON.parse(readFileSync(CFG, 'utf8'));
  const map = {
    'subreddit': ['reddit', 'subreddits', (v) => (v.startsWith('r/') ? v : `r/${v.replace(/^\/?(r\/)?/, '')}`)],
    'x-query': ['x', 'searchQueries', (v) => v.trim()],
    'discord-channel': ['discord', 'channels', (v) => v.trim()],
  };
  const spec = map[sourceType];
  if (!spec) return { added: false, error: `неизвестный тип источника: ${sourceType}` };
  const [network, field, norm] = spec;
  const val = norm(value);
  cfg[network][field] = cfg[network][field] || [];
  if (cfg[network][field].some((x) => x.toLowerCase() === val.toLowerCase())) {
    return { added: false, network, key: val, dup: true };
  }
  cfg[network][field].push(val);
  writeFileSync(CFG, JSON.stringify(cfg, null, 2) + '\n');
  return { added: true, network, key: val };
}

// --- Blocked subreddits (куда аккаунт не может постить) ---
// Автопополняется при отказе публикации; scan-reddit оттуда не предлагает.
export function loadBlockedSubs() {
  const s = load(BLOCKED_SUBS);
  return s && typeof s === 'object' ? s : {};
}
export function addBlockedSub(sub, reason) {
  if (!sub) return;
  const key = sub.replace(/^\/?(r\/)?/, '').toLowerCase();
  const s = loadBlockedSubs();
  s[key] = { reason: reason || 'нет доступа', at: Date.now() };
  save(BLOCKED_SUBS, s);
}

// Проверяет страницу reddit после отправки комментария на явный отказ
// (карма/бан/сабреддит закрыт). Возвращает строку-причину или null.
// Ratelimit («doing that too much») НЕ блокирует — временный.
export async function detectRedditPostDenied(page) {
  try {
    const err = await page.$$eval('.error, .status, span.error', (els) =>
      els.map((e) => e.textContent.trim()).filter(Boolean).join(' | '));
    const t = (err || '').toLowerCase();
    if (!t) return null;
    if (/too much|try again|ratelimit/.test(t)) return null; // временный лимит
    if (/karma|not allowed|isn.t allowed|banned|must be a member|restricted|only approved|private/.test(t)) {
      return err.slice(0, 200);
    }
    return null;
  } catch { return null; }
}

/** Discord: канал открыт на запись по discord-sources-analysis.tsv (колонка «запись»). */
export function discordWritable(url) {
  const chan = /discord\.com\/channels\/\d+\/(\d+)/.exec(url)?.[1];
  if (!chan) return false;
  const tsv = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'discord-sources-analysis.tsv'), 'utf8');
  const row = tsv.split('\n').map((l) => l.split('\t')).find((c) => c[2]?.trim() === chan);
  return !!row && row[3]?.trim() === 'да';
}

export const MAX_COMMENT_LEN = 280; // формат Твиттера (KS-4954): комментарий ≤280 символов

export function addDraft({ platform, url, text, subreddit, note }, { now = new Date(), state } = {}) {
  if (platform === 'discord' && !discordWritable(url)) {
    throw new Error('канал Discord закрыт для записи (discord-sources-analysis.tsv) — только мониторинг, черновик не создан');
  }
  // KS-4954: формат Твиттера — не более 280 символов. По решению пользователя
  // лимит применяется ТОЛЬКО к X (Twitter); Reddit/Discord остаются длинными
  // (развёрнутые ответы-помощь). Ограничение на этапе генерации: слишком длинный
  // X-черновик не создаётся, текст переписывается в лимит.
  if (platform === 'x') {
    const len = [...(text ?? '')].length; // по кодовым точкам, как считает Твиттер
    if (len > MAX_COMMENT_LEN) {
      throw new Error(`X-комментарий ${len} символов > ${MAX_COMMENT_LEN} (формат Твиттера, KS-4954) — черновик не создан, перепиши короче`);
    }
  }
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

/**
 * Привязка ответа основателя к черновику (KS-4906, доработка):
 *  - ответ начинается с id («d2-20260712 ok», «d2-20260712 мой текст») → этот черновик;
 *  - без id и ждёт РОВНО ОДИН черновик → он;
 *  - без id при нескольких pending → отказ { ambiguous: [ids] } — агент
 *    переспрашивает с явными id, ничего не публикуется.
 */
export function resolveReply(reply, { now = new Date(), state } = {}) {
  const s = state ?? loadDrafts();
  const persist = !state; // состояние не инъецировано → результат пишем на диск
  const done = (id) => {
    if (persist) save(DRAFTS_STATE, s);
    return { id, draft: s[id] };
  };
  const r = reply.trim();
  // id-префикс: публикации — d<N>-<ГГГГММДД>, предложения источников — src<N>-<ГГГГММДД>.
  // «id verb» (src61-20260716 ok) и «id» отдельной строкой без глагола (= ok).
  const idRe = /^((?:d|src)\d+-\d{8})(?:\s+([\s\S]+))?$/;
  const m = idRe.exec(r);
  if (m) {
    if (!s[m[1]]) return { error: `черновик ${m[1]} не найден` };
    resolveDraft(m[1], m[2] ? m[2] : 'ok', { now, state: s });
    return done(m[1]);
  }
  const pending = Object.entries(s).filter(([, d]) => d.status === 'pending' && now.getTime() - d.sentAt <= DRAFT_TTL_MS);
  if (pending.length === 0) return { error: 'нет активных черновиков' };
  if (pending.length > 1) return { ambiguous: pending.map(([id]) => id) };
  const [id] = pending[0];
  resolveDraft(id, r, { now, state: s });
  return done(id);
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

/** old.reddit: комментарий верхнего уровня на треде ИЛИ ответ на комментарий (пермалинк). */
export async function fillRedditComment(page, text, { submit = true } = {}) {
  let area = await page.$('.commentarea > form.usertext textarea[name="text"]');
  if (!area || !(await area.isVisible())) {
    // Пермалинк комментария: главная форма скрыта — открываем инлайн-ответ
    // на верхний (целевой) комментарий кликом «reply»
    const replyBtns = await page.$$('.commentarea .comment a[onclick*="reply"]');
    if (!replyBtns.length) throw new Error('Форма комментария не найдена (тред закрыт или разметка уехала)');
    await replyBtns[replyBtns.length - 1].click(); // целевой комментарий — последний в контексте
    area = await page.waitForSelector('.commentarea .comment form.usertext textarea[name="text"]:visible', { timeout: 5000 });
  }
  await area.fill(text);
  if (submit) {
    const btn = await area.evaluateHandle((el) => el.closest('form').querySelector('button[type="submit"]'));
    await btn.asElement().click();
  }
  return true;
}

/** X: лайк на открытой странице твита. true — поставлен, 'already' — уже стоял. */
export async function likeTweet(page) {
  if (await page.$('[data-testid="unlike"]')) return 'already';
  const btn = await page.$('[data-testid="like"]');
  if (!btn) throw new Error('Кнопка лайка не найдена (разметка уехала или твит недоступен)');
  await btn.click();
  return true;
}

/** X: репост на открытой странице твита. true — сделан, 'already' — уже был. */
export async function repostTweet(page) {
  if (await page.$('[data-testid="unretweet"]')) return 'already';
  const btn = await page.$('[data-testid="retweet"]');
  if (!btn) throw new Error('Кнопка репоста не найдена (разметка уехала или твит недоступен)');
  await btn.click();
  const confirm = await page.waitForSelector('[data-testid="retweetConfirm"]', { timeout: 5000 });
  await confirm.click();
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
  const line = `| ${dayKey(now)} | ${url} (${note || 'публикация'}) | опубликовано (${platform}, контур с подтверждением) |`;
  // строка — В таблицу (перед строкой «Статусы: …»), а не в хвост файла
  const md = readFileSync(path, 'utf8');
  const anchor = md.indexOf('\nСтатусы:');
  if (anchor === -1) {
    writeFileSync(path, `${md}${line}\n`);
  } else {
    const prefix = md.slice(0, anchor).replace(/\n+$/, '\n'); // ровно одна пустая строка не образуется
    writeFileSync(path, `${prefix}${prefix.endsWith('\n') ? '' : '\n'}${line}${md.slice(anchor)}`);
  }
  return line;
}
