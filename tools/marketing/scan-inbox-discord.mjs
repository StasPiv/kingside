#!/usr/bin/env node
/**
 * KS: крон-скан ВХОДЯЩИХ discord — ответы на наши сообщения и упоминания,
 * чтобы поддерживать дискуссию. Из отслеживаемых каналов (prefilter-config
 * discord.channels) берём сообщения, где refAuthorId == наш id ИЛИ наш id в
 * mentions, и это не наше собственное сообщение. Дедуп → inbox-replies-discord.json
 * → пинок агента.
 *
 *   node tools/marketing/scan-inbox-discord.mjs
 *
 * Ограничение: ловит ответы только в каналах из мониторинга, не в личках.
 */
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectMessages, whoAmI } from '../discord-read.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(readFileSync(join(HERE, 'prefilter-config.json'), 'utf8')).discord;
const SESSIONS = join(HERE, 'sessions');
const SEEN = join(SESSIONS, 'seen-inbox-discord.json');
const INBOX = join(SESSIONS, 'inbox-replies-discord.json');
const ITEMS_LOG = join(HERE, '..', '..', 'logs', 'scan-inbox-discord-items.log');
const WEBHOOK = process.env.WEBHOOK_URL || 'http://localhost:9876';
const TOKEN = process.env.WEBHOOK_AUTH_TOKEN || '';

const loadSeen = () => { try { return new Set(JSON.parse(readFileSync(SEEN, 'utf8'))); } catch { return new Set(); } };
const saveSeen = (s) => writeFileSync(SEEN, JSON.stringify([...s].slice(-2000)));
const dumpItem = (verdict, m) => {
  try { appendFileSync(ITEMS_LOG, `${new Date().toISOString()}\t${verdict}\t${m.author}\t${(m.text || '').replace(/\s+/g, ' ').slice(0, 120)}\t${m.url}\n`); } catch { /* лог не критичен */ }
};

async function poke(count) {
  const msg = `[CRON discord-inbox] ${count} ответ(ов)/упоминаний нам в tools/marketing/sessions/inbox-replies-discord.json. `
    + `Прочитай, реши по criteria.md, стоит ли поддержать дискуссию. Достойные — черновик-ответ через marketing-bot send. Троллинг/пусто — молча отбрось.`;
  const res = await fetch(`${WEBHOOK}/agent/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ from: 'cron', to: 'marketing', reply_required: false, message: msg }),
  });
  if (!res.ok) throw new Error(`poke failed: ${res.status} ${await res.text()}`);
}

async function main() {
  if (!cfg.channels?.length) {
    console.log('[scan-inbox-discord] channels пуст — скан пропущен');
    return;
  }
  let me;
  try { me = await whoAmI(); }
  catch (e) { console.error(`[scan-inbox-discord] whoAmI: ${e.message}`); process.exit(1); }

  const seen = loadSeen();
  const items = [];
  const funnel = { read: 0, dedup: 0, 'not-to-us': 0, own: 0 };
  for (const ch of cfg.channels) {
    let msgs;
    try { msgs = await collectMessages(ch, 50); }
    catch (e) { console.error(`[scan-inbox-discord] ${ch}: ${e.message}`); continue; }
    for (const m of msgs) {
      funnel.read++;
      if (m.authorId === me.id) { funnel.own++; continue; } // наше же сообщение
      const toUs = m.refAuthorId === me.id || (m.mentions || []).includes(me.id);
      if (!toUs) { funnel['not-to-us']++; continue; }
      if (seen.has(m.url)) { funnel.dedup++; dumpItem('dedup', m); continue; }
      items.push({ from: m.author, text: m.text, url: m.url, kind: m.refAuthorId === me.id ? 'reply' : 'mention' });
      seen.add(m.url);
      dumpItem('NEW', m);
    }
    await new Promise((r) => setTimeout(r, 1200));
  }
  saveSeen(seen);
  writeFileSync(INBOX, JSON.stringify({ network: 'discord-inbox', ts: Date.now(), items }, null, 2));
  const funnelStr = `прочитано ${funnel.read} → наши ${funnel.own}, не нам ${funnel['not-to-us']}, дубли ${funnel.dedup} → новых ${items.length}`;
  const ts = new Date().toISOString();
  if (items.length === 0) {
    console.log(`[scan-inbox-discord] ${ts} — новых ответов нет. ${funnelStr}`);
    return;
  }
  await poke(items.length);
  console.log(`[scan-inbox-discord] ${ts} — ${items.length} ответ(ов), агент разбужен. ${funnelStr}`);
}

main().catch((e) => { console.error(`[scan-inbox-discord] fatal: ${e.message}`); process.exit(1); });
