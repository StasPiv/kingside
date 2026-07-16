#!/usr/bin/env node
/**
 * KS: крон-скан X. collectTimeline(accounts) → префильтр → inbox-x.json →
 * пинок агента только при непустом результате. См. scan-reddit.mjs.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectTimeline } from '../x-read.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(readFileSync(join(HERE, 'prefilter-config.json'), 'utf8')).x;
const SESSIONS = join(HERE, 'sessions');
const SEEN = join(SESSIONS, 'seen-x.json');
const INBOX = join(SESSIONS, 'inbox-x.json');
const WEBHOOK = process.env.WEBHOOK_URL || 'http://localhost:9876';
const TOKEN = process.env.WEBHOOK_AUTH_TOKEN || '';

const loadSeen = () => { try { return new Set(JSON.parse(readFileSync(SEEN, 'utf8'))); } catch { return new Set(); } };
const saveSeen = (s) => writeFileSync(SEEN, JSON.stringify([...s].slice(-2000)));

function passes(t, now) {
  if (t.rt) return false; // ретвиты пропускаем
  if (cfg.maxAgeHours && t.ts && (now - t.ts) / 3_600_000 > cfg.maxAgeHours) return false;
  const likes = Number(t.likes) || 0;
  if (cfg.minLikes != null && likes < cfg.minLikes) return false;
  const hay = (t.text || '').toLowerCase();
  if (cfg.keywordsAny?.length && !cfg.keywordsAny.some((k) => hay.includes(k.toLowerCase()))) return false;
  return true;
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

async function main() {
  const now = Date.now();
  const seen = loadSeen();
  const candidates = [];
  for (const acc of cfg.accounts) {
    let tweets;
    try { tweets = await collectTimeline(acc); }
    catch (e) { console.error(`[scan-x] @${acc}: ${e.message}`); continue; }
    for (const t of tweets) {
      if (seen.has(t.url)) continue;
      if (!passes(t, now)) continue;
      candidates.push({ account: acc, text: t.text, likes: t.likes, rts: t.rts, date: t.date, url: t.url });
      seen.add(t.url);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  saveSeen(seen);
  const top = candidates.slice(0, cfg.maxCandidatesPerTick || 6);
  writeFileSync(INBOX, JSON.stringify({ network: 'x', ts: now, items: top }, null, 2));
  if (top.length === 0) {
    console.log(`[scan-x] ${new Date().toISOString()} — новых нет, агента не бужу`);
    return;
  }
  await poke(top.length);
  console.log(`[scan-x] ${new Date().toISOString()} — ${top.length} кандидат(ов), агент разбужен`);
}

main().catch((e) => { console.error(`[scan-x] fatal: ${e.message}`); process.exit(1); });
