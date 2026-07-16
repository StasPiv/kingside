#!/usr/bin/env node
/**
 * KS: крон-скан Reddit ПОД СЕССИЕЙ (browse, ADR-161) — свежие треды, не
 * анонимный HTTP-кэш. extractRedditListing → префильтр (0 токенов) →
 * inbox-reddit.json → пинок marketing-агента только при непустом результате.
 *
 *   node tools/marketing/scan-reddit.mjs
 *
 * Ограничители чтения (часы активности, интервал) — browse-lib.guardOrExit:
 * вне окна крон-тик тихо выходит. Префильтр — prefilter-config.json.
 * Дедуп — seen-reddit.json. Inbox читает агент по пинку.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withSession, LoggedOutError } from './session-lib.mjs';
import { extractRedditListing, guardOrExit, recordRead, jitter } from './browse-lib.mjs';
import { loadBlockedSubs } from './publish-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(readFileSync(join(HERE, 'prefilter-config.json'), 'utf8')).reddit;
const SESSIONS = join(HERE, 'sessions');
const SEEN = join(SESSIONS, 'seen-reddit.json');
const INBOX = join(SESSIONS, 'inbox-reddit.json');
const WEBHOOK = process.env.WEBHOOK_URL || 'http://localhost:9876';
const TOKEN = process.env.WEBHOOK_AUTH_TOKEN || '';

const loadSeen = () => { try { return new Set(JSON.parse(readFileSync(SEEN, 'utf8'))); } catch { return new Set(); } };
const saveSeen = (s) => writeFileSync(SEEN, JSON.stringify([...s].slice(-2000)));
const QUESTION_RE = /\?|how|what|which|why|recommend|help|stuck|beginner|improve/i;

// Возвращает null если прошёл, иначе причину отсева (для воронки в логе).
function rejectReason(item) {
  const cm = Number(String(item.comments).replace(/\D+/g, '')) || 0;
  if (cfg.minComments != null && cm < cfg.minComments) return 'comments';
  if (cfg.maxComments != null && cm > cfg.maxComments) return 'comments';
  const hay = (item.title || '').toLowerCase();
  if (cfg.keywordsAny?.length && !cfg.keywordsAny.some((k) => hay.includes(k.toLowerCase()))) return 'keyword';
  if (cfg.titleMustBeQuestionOrHelp && !QUESTION_RE.test(item.title || '')) return 'not-question';
  return null;
}

async function poke(count) {
  const msg = `[CRON reddit] ${count} кандидат(ов) в tools/marketing/sessions/inbox-reddit.json. `
    + `Отмодерируй по tools/marketing/criteria.md, черновики → marketing-bot send. Мусор молча отбрось.`;
  const res = await fetch(`${WEBHOOK}/agent/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ from: 'cron', to: 'marketing', reply_required: false, message: msg }),
  });
  if (!res.ok) throw new Error(`poke failed: ${res.status} ${await res.text()}`);
}

// guardOrExit: вне часов активности / интервала — process.exit(4), тик no-op.
guardOrExit('reddit');

const now = Date.now();
const seen = loadSeen();
const candidates = [];
// Воронка отсева (для лога): чтобы «новых нет» было прозрачным.
const funnel = { read: 0, dedup: 0, keyword: 0, 'not-question': 0, comments: 0, skippedSubs: [] };
try {
  await withSession('reddit', async (page) => {
    const sort = cfg.sort || 'new';
    const blocked = loadBlockedSubs();
    for (const sub of cfg.subreddits) {
      const clean = sub.replace(/^\/?(r\/)?/, '');
      if (blocked[clean.toLowerCase()]) { funnel.skippedSubs.push(`r/${clean}(blocked)`); continue; }
      try {
        await page.goto(`https://old.reddit.com/r/${clean}/${sort === 'hot' ? '' : sort}`,
          { waitUntil: 'domcontentloaded', timeout: 45000 });
        for (const it of await extractRedditListing(page)) {
          if (!it.url) continue;
          funnel.read++;
          if (seen.has(it.url)) { funnel.dedup++; continue; }
          const rej = rejectReason(it);
          if (rej) { funnel[rej]++; continue; }
          candidates.push({ subreddit: `r/${clean}`, title: it.title, score: it.score, comments: it.comments, url: it.url });
          seen.add(it.url);
        }
      } catch (e) { console.error(`[scan-reddit] r/${clean}: ${e.message}`); }
      await jitter(2000, 5000);
    }
    recordRead('reddit');
  });
} catch (e) {
  console.error(`[scan-reddit] ${e instanceof LoggedOutError ? 'РАЗЛОГИН — нужен повторный захват сессии' : e.message}`);
  process.exit(e instanceof LoggedOutError ? 3 : 1);
}
saveSeen(seen);

const top = candidates.slice(0, cfg.maxCandidatesPerTick || 8);
writeFileSync(INBOX, JSON.stringify({ network: 'reddit', ts: now, items: top }, null, 2));
const funnelStr = `прочитано ${funnel.read} → дубли ${funnel.dedup}, без ключевых слов ${funnel.keyword}, не вопрос ${funnel['not-question']}, комментарии ${funnel.comments}${funnel.skippedSubs.length ? `, сабы-пропуск ${funnel.skippedSubs.join(',')}` : ''} → прошло ${candidates.length}`;
const ts = new Date().toISOString();
if (top.length === 0) {
  console.log(`[scan-reddit] ${ts} — новых нет, агента не бужу. ${funnelStr}`);
  process.exit(0);
}
await poke(top.length);
console.log(`[scan-reddit] ${ts} — ${top.length} кандидат(ов), агент разбужен. ${funnelStr}`);
