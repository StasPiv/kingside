#!/usr/bin/env node
/**
 * KS: крон-скан Discord. collectMessages(channels) → префильтр → inbox-discord.json
 * → пинок агента при непустом результате. См. scan-reddit.mjs.
 * Discord щадящий: реже всех (config channels пуст → скан ничего не делает).
 */
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectMessages } from '../discord-read.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ITEMS_LOG = join(HERE, '..', '..', 'logs', 'scan-discord-items.log');
const dumpItem = (verdict, m) => {
  try { appendFileSync(ITEMS_LOG, `${new Date().toISOString()}\t${verdict}\t${m.channel || '?'}\t${(m.text || '').replace(/\s+/g, ' ').slice(0, 120)}\t${m.url}\n`); } catch { /* лог не критичен */ }
};
const cfg = JSON.parse(readFileSync(join(HERE, 'prefilter-config.json'), 'utf8')).discord;
const SESSIONS = join(HERE, 'sessions');
const SEEN = join(SESSIONS, 'seen-discord.json');
const INBOX = join(SESSIONS, 'inbox-discord.json');
const WEBHOOK = process.env.WEBHOOK_URL || 'http://localhost:9876';
const TOKEN = process.env.WEBHOOK_AUTH_TOKEN || '';

const loadSeen = () => { try { return new Set(JSON.parse(readFileSync(SEEN, 'utf8'))); } catch { return new Set(); } };
const saveSeen = (s) => writeFileSync(SEEN, JSON.stringify([...s].slice(-2000)));

// null — прошёл; иначе структурная причина отсева (не контентная).
// Семантику решает LLM-агент по criteria.md.
function rejectReason(m) {
  if (m.bot) return 'bot';
  if (!m.text) return 'empty';
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
  const funnel = { read: 0, dedup: 0, bot: 0, empty: 0 };
  for (const ch of cfg.channels) {
    let msgs;
    try { msgs = await collectMessages(ch, 50); }
    catch (e) { console.error(`[scan-discord] ${ch}: ${e.message}`); continue; }
    for (const m of msgs) {
      funnel.read++;
      if (seen.has(m.url)) { funnel.dedup++; dumpItem('dedup', m); continue; }
      const rej = rejectReason(m);
      if (rej) { funnel[rej]++; dumpItem(rej, m); continue; }
      candidates.push(m);
      seen.add(m.url);
      dumpItem('NEW', m);
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  saveSeen(seen);
  const top = candidates.slice(0, cfg.maxCandidatesPerTick || 40);
  writeFileSync(INBOX, JSON.stringify({ network: 'discord', ts: now, items: top }, null, 2));
  const funnelStr = `прочитано ${funnel.read} → дубли ${funnel.dedup}, боты ${funnel.bot}, пустые ${funnel.empty} → новых ${candidates.length}`;
  const ts = new Date().toISOString();
  if (top.length === 0) {
    console.log(`[scan-discord] ${ts} — новых нет, агента не бужу. ${funnelStr}`);
    return;
  }
  await poke(top.length);
  console.log(`[scan-discord] ${ts} — ${top.length} кандидат(ов), агент разбужен. ${funnelStr}`);
}

main().catch((e) => { console.error(`[scan-discord] fatal: ${e.message}`); process.exit(1); });
