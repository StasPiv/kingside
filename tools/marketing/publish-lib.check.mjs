#!/usr/bin/env node
/**
 * KS-4906: быстрая проверка контура публикации без живых сессий.
 * Счётчики/черновики/таймауты — на инъецированном состоянии и времени;
 * детект челленджа и заполнение форм — на HTML-фикстурах в headless Chromium.
 *
 * Запуск: node tools/marketing/publish-lib.check.mjs
 */

import {
  actionDenied, recordAction, haltPlatform, resumePlatform, DAILY_LIMITS, MIN_GAP_MIN,
  addDraft, resolveDraft, expireDrafts, DRAFT_TTL_MS,
  detectChallenge, fillRedditComment, fillXReply,
} from './publish-lib.mjs';

let failed = 0;
const check = (name, cond) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}`); if (!cond) failed++; };
const at = (iso) => new Date(iso);
const NOON = at('2026-07-12T10:00:00Z');

// --- Счётчики и лимиты ---
let s = {};
check('пустое состояние → действовать можно', actionDenied('reddit', { now: NOON, state: s }) === null);

// Лимиты сняты (Infinity, решение пользователя 12.07). Тесты потолков идут
// ТОЛЬКО при конечных значениях — цикл до Infinity вешает систему (инцидент 12.07).
if (Number.isFinite(DAILY_LIMITS.reddit.total)) {
  for (let i = 0; i < DAILY_LIMITS.reddit.total; i++) {
    s = recordAction('reddit', { subreddit: `sub${i}`, now: new Date(NOON.getTime() + i * 11 * 60000), state: s });
  }
  const afterAll = new Date(NOON.getTime() + 6 * 11 * 60000);
  check(`дневной потолок reddit=${DAILY_LIMITS.reddit.total} → отказ`, /дневной лимит/.test(actionDenied('reddit', { now: afterAll, state: s }) || ''));
  check('другая платформа не затронута', actionDenied('x', { now: afterAll, state: s }) === null);
} else {
  const many = recordAction('reddit', { subreddit: 'chess', now: NOON, state: {} });
  check('лимиты сняты → отказа нет после действий', actionDenied('reddit', { subreddit: 'chess', now: new Date(NOON.getTime() + 60000), state: many }) === null);
}

if (Number.isFinite(DAILY_LIMITS.reddit.perSubreddit)) {
  let s2 = {};
  s2 = recordAction('reddit', { subreddit: 'chess', now: NOON, state: s2 });
  s2 = recordAction('reddit', { subreddit: 'chess', now: new Date(NOON.getTime() + 11 * 60000), state: s2 });
  const t3 = new Date(NOON.getTime() + 22 * 60000);
  check('лимит 2/сабреддит → отказ для r/chess', /r\/chess/.test(actionDenied('reddit', { subreddit: 'chess', now: t3, state: s2 }) || ''));
  check('в другой сабреддит — можно', actionDenied('reddit', { subreddit: 'other', now: t3, state: s2 }) === null);
}

let s3 = recordAction('x', { now: NOON, state: {} });
if (MIN_GAP_MIN > 0) {
  check(`пауза <${MIN_GAP_MIN} мин → отказ`, /пауза/.test(actionDenied('x', { now: new Date(NOON.getTime() + 5 * 60000), state: s3 }) || ''));
}
check('пауза 11 мин → можно', actionDenied('x', { now: new Date(NOON.getTime() + 11 * 60000), state: s3 }) === null);

let s4 = haltPlatform('x', 'капча', { now: NOON, state: {} });
check('стоп-кран → отказ с причиной', /СТОП-КРАН: капча/.test(actionDenied('x', { now: NOON, state: s4 }) || ''));
s4 = resumePlatform('x', { state: s4 });
check('после снятия стоп-крана → можно', actionDenied('x', { now: NOON, state: s4 }) === null);

// --- Черновики ---
let d = {};
const id = addDraft({ platform: 'reddit', url: 'https://old.reddit.com/r/chess/comments/abc/', text: 'draft text', subreddit: 'chess' }, { now: NOON, state: d });
check('черновик создан pending', d[id].status === 'pending');
resolveDraft(id, 'ok', { now: new Date(NOON.getTime() + 60000), state: d });
check('«ok» → approved, текст как есть', d[id].status === 'approved' && d[id].text === 'draft text');

const id2 = addDraft({ platform: 'x', url: 'u', text: 'orig' }, { now: NOON, state: d });
resolveDraft(id2, 'Мой вариант текста', { now: NOON, state: d });
check('правка → approved с текстом основателя', d[id2].status === 'approved' && d[id2].text === 'Мой вариант текста');

// KS-4954: лимит ≤280 символов — ТОЛЬКО для X
check('X 280 символов — черновик создаётся', (() => {
  try { addDraft({ platform: 'x', url: 'u', text: 'z'.repeat(280) }, { now: NOON, state: {} }); return true; } catch { return false; }
})());
check('X 281 символ — addDraft отклоняет (>280)', (() => {
  try { addDraft({ platform: 'x', url: 'u', text: 'z'.repeat(281) }, { now: NOON, state: {} }); return false; } catch { return true; }
})());
check('Reddit 1500 символов — проходит (без лимита)', (() => {
  try { addDraft({ platform: 'reddit', url: 'https://old.reddit.com/r/chess/comments/x/', text: 'z'.repeat(1500), subreddit: 'chess' }, { now: NOON, state: {} }); return true; } catch { return false; }
})());
check('Discord 1500 символов — проходит (без лимита)', (() => {
  try { addDraft({ platform: 'discord', url: 'https://discord.com/channels/1/692509042421006355', text: 'z'.repeat(1500) }, { now: NOON, state: {} }); return true; } catch { return false; }
})());

const id3 = addDraft({ platform: 'x', url: 'u', text: 't' }, { now: NOON, state: d });
resolveDraft(id3, 'skip', { now: NOON, state: d });
check('«skip» → skipped', d[id3].status === 'skipped');

const id4 = addDraft({ platform: 'x', url: 'u', text: 't' }, { now: NOON, state: d });
const expired = expireDrafts({ now: new Date(NOON.getTime() + DRAFT_TTL_MS + 60000), state: d });
check('4 часа без ответа → сгорел', expired.includes(id4) && d[id4].status === 'expired');
check('поздний ответ на сгоревший → не approved', (() => {
  const id5 = addDraft({ platform: 'x', url: 'u', text: 't' }, { now: NOON, state: d });
  const r = resolveDraft(id5, 'ok', { now: new Date(NOON.getTime() + DRAFT_TTL_MS + 60000), state: d });
  return r.status === 'expired';
})());

// --- Привязка ответа к черновику ---
import { resolveReply } from './publish-lib.mjs';
let rr = {};
const ra = addDraft({ platform: 'x', url: 'u1', text: 't1' }, { now: NOON, state: rr });
check('один pending + «ok» без id → привязка к нему', (() => {
  const res = resolveReply('ok', { now: NOON, state: rr });
  return res.id === ra && res.draft.status === 'approved';
})());
let rr2 = {};
const rb = addDraft({ platform: 'x', url: 'u1', text: 't1' }, { now: NOON, state: rr2 });
const rc = addDraft({ platform: 'reddit', url: 'u2', text: 't2' }, { now: NOON, state: rr2 });
check('несколько pending + «ok» без id → отказ ambiguous', (() => {
  const res = resolveReply('ok', { now: NOON, state: rr2 });
  return Array.isArray(res.ambiguous) && res.ambiguous.length === 2 && rr2[rb].status === 'pending' && rr2[rc].status === 'pending';
})());
check('«<id> skip» при нескольких → только указанный', (() => {
  const res = resolveReply(`${rc} skip`, { now: NOON, state: rr2 });
  return res.id === rc && rr2[rc].status === 'skipped' && rr2[rb].status === 'pending';
})());
check('«<id> свой текст» → approved с правкой', (() => {
  const res = resolveReply(`${rb} My edited version`, { now: NOON, state: rr2 });
  return res.id === rb && rr2[rb].status === 'approved' && rr2[rb].text === 'My edited version';
})());
check('нет активных → понятный отказ', /нет активных/.test(resolveReply('ok', { now: NOON, state: {} }).error || ''));
check('несуществующий id → отказ', /не найден/.test(resolveReply('d99-20990101 ok', { now: NOON, state: rr2 }).error || ''));

// --- Браузерная часть на фикстурах ---
const { chromium } = await import('playwright');
const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext()).newPage();

await page.setContent('<div class="commentarea"><form class="usertext"><textarea name="text"></textarea><button type="submit">save</button></form></div>');
await fillRedditComment(page, 'test comment', { submit: false });
check('reddit: форма заполняется', (await page.inputValue('.commentarea textarea[name="text"]')) === 'test comment');

await page.setContent('<div>нет формы</div>');
check('reddit: нет формы → понятная ошибка', await fillRedditComment(page, 'x', { submit: false }).then(() => false, (e) => /не найдена/.test(e.message)));

await page.setContent('<div data-testid="tweetTextarea_0" contenteditable="true"></div><button data-testid="tweetButtonInline">Reply</button>');
await fillXReply(page, 'hi', { submit: false });
check('x: поле ответа заполняется', ((await page.textContent('[data-testid="tweetTextarea_0"]')) || '').includes('hi'));

await page.setContent('<html><body>Обычная страница треда</body></html>');
check('челлендж: чистая страница → null', (await detectChallenge(page)) === null);
await page.setContent('<iframe src="https://hcaptcha.com/x"></iframe>');
check('челлендж: hcaptcha-iframe → детект', /hcaptcha/.test((await detectChallenge(page)) || ''));
await page.setContent('<body>We noticed unusual activity from your account</body>');
check('челлендж: текст «unusual activity» → детект', /unusual/i.test((await detectChallenge(page)) || ''));

await browser.close();
console.log(failed ? `\n${failed} проверок провалено` : '\nВсе проверки пройдены');
process.exit(failed ? 1 : 0);
