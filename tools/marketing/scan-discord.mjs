#!/usr/bin/env node
/**
 * KS: крон-скан Discord. collectMessages(channels) → префильтр → inbox-discord.json
 * → пинок агента при непустом результате. См. scan-reddit.mjs.
 * Discord щадящий: реже всех (config channels пуст → скан ничего не делает).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectMessages } from '../discord-read.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(readFileSync(join(HERE, 'prefilter-config.json'), 'utf8')).discord;
const SESSIONS = join(HERE, 'sessions');
const SEEN = join(SESSIONS, 'seen-discord.json');
const INBOX = join(SESSIONS, 'inbox-discord.json');
const WEBHOOK = process.env.WEBHOOK_URL || 'http://localhost:9876';
const TOKEN = process.env.WEBHOOK_AUTH_TOKEN || '';

const loadSeen = () => { try { return new Set(JSON.parse(readFileSync(SEEN, 'utf8'))); } catch { return new Set(); } };
const saveSeen = (s) => writeFileSync(SEEN, JSON.stringify([...s].slice(-2000)));

// null — прошёл; иначе причина отсева (для воронки в логе).
function rejectReason(m, now) {
  if (m.bot) return 'bot';
  if (!m.text) return 'empty';
  if (cfg.maxAgeHours && m.ts && (now - m.ts) / 3_600_000 > cfg.maxAgeHours) return 'old';
  const hay = m.text.toLowerCase();
  if (cfg.keywordsAny?.length && !cfg.keywordsAny.some((k) => hay.includes(k.toLowerCase()))) return 'keyword';
  return null;
}

async function poke(count) {
  const msg = `[CRON discord] ${count} кандидат(ов) в tools/marketing/sessions/inbox-discord.json. `
    + `Отмодерируй по tools/marketing/criteria.md, черновики → marketing-bot send. Мусор молча отбрось.`;
  const res = await fetch(`${WEBHOOK}/agent/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ from: 'cron', to: 'marketing', reply_required: false, message: msg }),
  });
  if (!res.ok) throw new Error(`poke failed: ${res.status} ${await res.text()}`);
}

async function main() {
  if (!cfg.channels?.length) {
    console.log('[scan-discord] channels пуст в prefilter-config.json — скан пропущен');
    return;
  }
  const now = Date.now();
  const seen = loadSeen();
  const candidates = [];
  const funnel = { read: 0, dedup: 0, keyword: 0, old: 0, bot: 0, empty: 0 };
  for (const ch of cfg.channels) {
    let msgs;
    try { msgs = await collectMessages(ch, 50); }
    catch (e) { console.error(`[scan-discord] ${ch}: ${e.message}`); continue; }
    for (const m of msgs) {
      funnel.read++;
      if (seen.has(m.url)) { funnel.dedup++; continue; }
      const rej = rejectReason(m, now);
      if (rej) { funnel[rej]++; continue; }
      candidates.push(m);
      seen.add(m.url);
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  saveSeen(seen);
  const top = candidates.slice(0, cfg.maxCandidatesPerTick || 6);
  writeFileSync(INBOX, JSON.stringify({ network: 'discord', ts: now, items: top }, null, 2));
  const funnelStr = `прочитано ${funnel.read} → видены ${funnel.dedup}, без ключевых слов ${funnel.keyword}, старые ${funnel.old}, боты ${funnel.bot}, пустые ${funnel.empty} → прошло ${candidates.length}`;
  const ts = new Date().toISOString();
  if (top.length === 0) {
    console.log(`[scan-discord] ${ts} — новых нет, агента не бужу. ${funnelStr}`);
    return;
  }
  await poke(top.length);
  console.log(`[scan-discord] ${ts} — ${top.length} кандидат(ов), агент разбужен. ${funnelStr}`);
}

main().catch((e) => { console.error(`[scan-discord] fatal: ${e.message}`); process.exit(1); });
