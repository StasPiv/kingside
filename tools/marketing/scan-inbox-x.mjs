#!/usr/bin/env node
/**
 * KS: крон-скан ВХОДЯЩИХ X — ответы/упоминания нам, чтобы поддерживать
 * дискуссию. Поиск `to:<наш_хэндл>` в Latest → те же extractTweets → дедуп
 * → inbox-replies-x.json → пинок агента.
 *
 *   node tools/marketing/scan-inbox-x.mjs
 *
 * Хэндл определяется один раз под сессией (профиль в сайдбаре) и кэшируется
 * в sessions/x-handle.json — спрашивать пользователя не нужно.
 */
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withSession, LoggedOutError } from './session-lib.mjs';
import { extractTweets, recordRead, jitter } from './browse-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SESSIONS = join(HERE, 'sessions');
const SEEN = join(SESSIONS, 'seen-inbox-x.json');
const INBOX = join(SESSIONS, 'inbox-replies-x.json');
const HANDLE_FILE = join(SESSIONS, 'x-handle.json');
const ITEMS_LOG = join(HERE, '..', '..', 'logs', 'scan-inbox-x-items.log');
const WEBHOOK = process.env.WEBHOOK_URL || 'http://localhost:9876';
const TOKEN = process.env.WEBHOOK_AUTH_TOKEN || '';

const loadSeen = () => { try { return new Set(JSON.parse(readFileSync(SEEN, 'utf8'))); } catch { return new Set(); } };
const saveSeen = (s) => writeFileSync(SEEN, JSON.stringify([...s].slice(-2000)));
const dumpItem = (verdict, t) => {
  try { appendFileSync(ITEMS_LOG, `${new Date().toISOString()}\t${verdict}\t@${t.author}\t${(t.text || '').replace(/\s+/g, ' ').slice(0, 120)}\t${t.url}\n`); } catch { /* лог не критичен */ }
};

// Наш @хэндл из сайдбара профиля (href вида /<handle>). Кэшируется.
async function resolveHandle(page) {
  if (existsSync(HANDLE_FILE)) {
    try { const h = JSON.parse(readFileSync(HANDLE_FILE, 'utf8')).handle; if (h) return h; } catch { /* перечитаем */ }
  }
  const href = await page.getAttribute('a[data-testid="AppTabBar_Profile_Link"]', 'href').catch(() => null);
  const handle = href ? href.replace(/^\//, '').trim() : '';
  if (!handle) throw new Error('не удалось определить свой X-хэндл (профиль в сайдбаре не найден)');
  writeFileSync(HANDLE_FILE, JSON.stringify({ handle }, null, 2));
  return handle;
}

async function poke(count) {
  const msg = `[CRON x-inbox] ${count} ответ(ов)/упоминаний нам в tools/marketing/sessions/inbox-replies-x.json. `
    + `Прочитай, реши по criteria.md, стоит ли поддержать дискуссию. Достойные — черновик-ответ через marketing-bot send. Троллинг/пусто — молча отбрось.`;
  const res = await fetch(`${WEBHOOK}/agent/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ from: 'cron', to: 'marketing', reply_required: false, message: msg }),
  });
  if (!res.ok) throw new Error(`poke failed: ${res.status} ${await res.text()}`);
}

const now = Date.now();
const seen = loadSeen();
const items = [];
const funnel = { read: 0, dedup: 0, own: 0 };
try {
  await withSession('x', async (page) => {
    await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await jitter(2000, 4000);
    const handle = await resolveHandle(page);
    await page.goto(`https://x.com/search?q=${encodeURIComponent(`to:${handle}`)}&f=live`,
      { waitUntil: 'domcontentloaded', timeout: 45000 });
    await jitter(2500, 5000);
    for (const t of await extractTweets(page)) {
      if (!t.url) continue;
      funnel.read++;
      if ((t.author || '').toLowerCase() === handle.toLowerCase()) { funnel.own++; continue; }
      if (seen.has(t.url)) { funnel.dedup++; dumpItem('dedup', t); continue; }
      items.push({ from: t.author, text: t.text, date: t.date, url: t.url });
      seen.add(t.url);
      dumpItem('NEW', t);
    }
    recordRead('x-inbox');
  });
} catch (e) {
  console.error(`[scan-inbox-x] ${e instanceof LoggedOutError ? 'РАЗЛОГИН — нужен повторный захват сессии' : e.message}`);
  process.exit(e instanceof LoggedOutError ? 3 : 1);
}
saveSeen(seen);

writeFileSync(INBOX, JSON.stringify({ network: 'x-inbox', ts: now, items }, null, 2));
const funnelStr = `прочитано ${funnel.read} → наши ${funnel.own}, дубли ${funnel.dedup} → новых ${items.length}`;
const ts = new Date().toISOString();
if (items.length === 0) {
  console.log(`[scan-inbox-x] ${ts} — новых ответов нет. ${funnelStr}`);
  process.exit(0);
}
await poke(items.length);
console.log(`[scan-inbox-x] ${ts} — ${items.length} ответ(ов), агент разбужен. ${funnelStr}`);
