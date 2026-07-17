#!/usr/bin/env node
/**
 * KS: крон-скан ВХОДЯЩИХ reddit — ответы на наши комментарии, чтобы
 * поддерживать дискуссию, а не бросать её после первого ответа.
 * extractRedditInbox → дедуп → inbox-replies-reddit.json → пинок агента.
 *
 *   node tools/marketing/scan-inbox-reddit.mjs
 *
 * Отсев только структурный (дедуп уже виденного). Стоит ли отвечать и как —
 * решает LLM-агент по criteria.md (тон, уместность). Ответ уходит как reply
 * на пермалинк через обычный контур черновиков (publish.mjs умеет replyTo).
 */
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withSession, LoggedOutError } from './session-lib.mjs';
import { extractRedditInbox, recordRead, jitter } from './browse-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SESSIONS = join(HERE, 'sessions');
const SEEN = join(SESSIONS, 'seen-inbox-reddit.json');
const INBOX = join(SESSIONS, 'inbox-replies-reddit.json');
const ITEMS_LOG = join(HERE, '..', '..', 'logs', 'scan-inbox-reddit-items.log');
const WEBHOOK = process.env.WEBHOOK_URL || 'http://localhost:9876';
const TOKEN = process.env.WEBHOOK_AUTH_TOKEN || '';

const loadSeen = () => { try { return new Set(JSON.parse(readFileSync(SEEN, 'utf8'))); } catch { return new Set(); } };
const saveSeen = (s) => writeFileSync(SEEN, JSON.stringify([...s].slice(-2000)));
const dumpItem = (verdict, it) => {
  try { appendFileSync(ITEMS_LOG, `${new Date().toISOString()}\t${verdict}\t${it.from}\t${(it.body || '').replace(/\s+/g, ' ').slice(0, 120)}\t${it.link}\n`); } catch { /* лог не критичен */ }
};

// Ключ дедупа: пермалинк ответа + автор (один пермалинк может нести разные реплики).
const keyOf = (it) => `${it.link}|${it.from}`;

async function poke(count) {
  const msg = `[CRON reddit-inbox] ${count} ответ(ов) на твои комментарии в tools/marketing/sessions/inbox-replies-reddit.json. `
    + `Прочитай, реши по criteria.md, стоит ли поддержать дискуссию (по существу, тон режима — как у исходного ответа). `
    + `Достойные — черновик-ответ через marketing-bot send (уйдёт мне на ok). Троллинг/пусто/нечего добавить — молча отбрось.`;
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
const funnel = { read: 0, dedup: 0 };
// inbox — ответы на комментарии/посты и упоминания; messages — личка (ЛС).
const SOURCES = [
  ['https://old.reddit.com/message/inbox/', 'reply'],
  ['https://old.reddit.com/message/messages/', 'pm'],
];
try {
  await withSession('reddit', async (page) => {
    for (const [url, kind] of SOURCES) {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      for (const it of await extractRedditInbox(page)) {
        funnel.read++;
        // У ЛС пермалинк может отсутствовать — ключ дедупа берём с фолбэком на тело.
        const k = it.link ? keyOf(it) : `pm|${it.from}|${(it.body || '').slice(0, 80)}`;
        if (seen.has(k)) { funnel.dedup++; dumpItem('dedup', it); continue; }
        items.push({ from: it.from, subject: it.subject, body: it.body, link: it.link, isNew: it.isNew, kind });
        seen.add(k);
        dumpItem(kind === 'pm' ? 'NEW-pm' : 'NEW', it);
      }
      await jitter(1500, 3500);
    }
    recordRead('reddit-inbox');
  });
} catch (e) {
  console.error(`[scan-inbox-reddit] ${e instanceof LoggedOutError ? 'РАЗЛОГИН — нужен повторный захват сессии' : e.message}`);
  process.exit(e instanceof LoggedOutError ? 3 : 1);
}
saveSeen(seen);

writeFileSync(INBOX, JSON.stringify({ network: 'reddit-inbox', ts: now, items }, null, 2));
const funnelStr = `прочитано ${funnel.read} → дубли ${funnel.dedup} → новых ${items.length}`;
const ts = new Date().toISOString();
if (items.length === 0) {
  console.log(`[scan-inbox-reddit] ${ts} — новых ответов нет. ${funnelStr}`);
  process.exit(0);
}
await poke(items.length);
console.log(`[scan-inbox-reddit] ${ts} — ${items.length} ответ(ов), агент разбужен. ${funnelStr}`);
