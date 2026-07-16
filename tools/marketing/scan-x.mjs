#!/usr/bin/env node
/**
 * KS: крон-скан X ПОД СЕССИЕЙ (browse, ADR-161) — Latest-поиск по запросам,
 * свежие твиты (не syndication-кэш). extractTweets → префильтр → inbox-x.json
 * → пинок агента при непустом результате. См. scan-reddit.mjs.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withSession, LoggedOutError } from './session-lib.mjs';
import { extractTweets, guardOrExit, recordRead, jitter } from './browse-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(readFileSync(join(HERE, 'prefilter-config.json'), 'utf8')).x;
const SESSIONS = join(HERE, 'sessions');
const SEEN = join(SESSIONS, 'seen-x.json');
const INBOX = join(SESSIONS, 'inbox-x.json');
const WEBHOOK = process.env.WEBHOOK_URL || 'http://localhost:9876';
const TOKEN = process.env.WEBHOOK_AUTH_TOKEN || '';

const loadSeen = () => { try { return new Set(JSON.parse(readFileSync(SEEN, 'utf8'))); } catch { return new Set(); } };
const saveSeen = (s) => writeFileSync(SEEN, JSON.stringify([...s].slice(-2000)));

// null — прошёл; иначе причина отсева (для воронки в логе).
function rejectReason(t, now) {
  if (t.date && t.date !== '?' && cfg.maxAgeHours) {
    const ts = Date.parse(t.date.replace(' ', 'T') + ':00Z');
    if (ts && (now - ts) / 3_600_000 > cfg.maxAgeHours) return 'old';
  }
  const hay = (t.text || '').toLowerCase();
  if (cfg.keywordsAny?.length && !cfg.keywordsAny.some((k) => hay.includes(k.toLowerCase()))) return 'keyword';
  return null;
}

async function poke(count) {
  const msg = `[CRON x] ${count} кандидат(ов) в tools/marketing/sessions/inbox-x.json. `
    + `Отмодерируй по tools/marketing/criteria.md, черновики → marketing-bot send. Мусор молча отбрось.`;
  const res = await fetch(`${WEBHOOK}/agent/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ from: 'cron', to: 'marketing', reply_required: false, message: msg }),
  });
  if (!res.ok) throw new Error(`poke failed: ${res.status} ${await res.text()}`);
}

guardOrExit('x');

const now = Date.now();
const seen = loadSeen();
const candidates = [];
const funnel = { read: 0, dedup: 0, keyword: 0, old: 0 };
try {
  await withSession('x', async (page) => {
    for (const q of cfg.searchQueries || []) {
      try {
        await page.goto(`https://x.com/search?q=${encodeURIComponent(q)}&f=live`,
          { waitUntil: 'domcontentloaded', timeout: 45000 });
        await jitter(2500, 5000);
        for (const t of await extractTweets(page)) {
          if (!t.url) continue;
          funnel.read++;
          if (seen.has(t.url)) { funnel.dedup++; continue; }
          const rej = rejectReason(t, now);
          if (rej) { funnel[rej]++; continue; }
          candidates.push({ query: q, author: t.author, text: t.text, date: t.date, url: t.url });
          seen.add(t.url);
        }
      } catch (e) { console.error(`[scan-x] "${q}": ${e.message}`); }
      await jitter(2000, 5000);
    }
    recordRead('x');
  });
} catch (e) {
  console.error(`[scan-x] ${e instanceof LoggedOutError ? 'РАЗЛОГИН — нужен повторный захват сессии' : e.message}`);
  process.exit(e instanceof LoggedOutError ? 3 : 1);
}
saveSeen(seen);

const top = candidates.slice(0, cfg.maxCandidatesPerTick || 6);
writeFileSync(INBOX, JSON.stringify({ network: 'x', ts: now, items: top }, null, 2));
const funnelStr = `прочитано ${funnel.read} → видены ${funnel.dedup}, без ключевых слов ${funnel.keyword}, старые ${funnel.old} → прошло ${candidates.length}`;
const ts = new Date().toISOString();
if (top.length === 0) {
  console.log(`[scan-x] ${ts} — новых нет, агента не бужу. ${funnelStr}`);
  process.exit(0);
}
await poke(top.length);
console.log(`[scan-x] ${ts} — ${top.length} кандидат(ов), агент разбужен. ${funnelStr}`);
