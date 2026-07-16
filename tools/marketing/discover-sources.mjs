#!/usr/bin/env node
/**
 * KS: открыватель источников мониторинга. Раз в сутки СОБИРАЕТ сырых
 * кандидатов на новые источники и отдаёт их marketing-агенту в
 * inbox-sources.json. Релевантность («это шахматное сообщество для нашей
 * аудитории?») решает LLM-агент — здесь НЕТ keyword-фильтра результатов.
 * Достойных агент оформляет как предложение (addSourceProposal +
 * marketing-bot send), и они уходят пользователю на `ok`.
 *
 *   node tools/marketing/discover-sources.mjs
 *
 * Что собирается:
 *  - reddit: результаты old.reddit.com/subreddits/search по шахматным ЗАПРОСАМ
 *    (запрос — это вход поиска, не фильтр результата; аналог searchQueries X);
 *  - discord: текстовые каналы серверов, в которых состоит аккаунт.
 * X (аккаунты) не собирается: источник X — поисковые фразы, их задаёт человек.
 *
 * Отсев здесь ТОЛЬКО структурный: уже подключённые (config) и уже показанные
 * раньше (sessions/seen-sources.json) не попадают агенту повторно. За счёт
 * этого агенту каждый день приходят лишь НОВЫЕ сообщества — их немного.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withSession, LoggedOutError } from './session-lib.mjs';
import { listGuilds, listTextChannels } from '../discord-read.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CFG = join(HERE, 'prefilter-config.json');
const SEEN = join(HERE, 'sessions', 'seen-sources.json');
const INBOX = join(HERE, 'sessions', 'inbox-sources.json');
const WEBHOOK = process.env.WEBHOOK_URL || 'http://localhost:9876';
const TOKEN = process.env.WEBHOOK_AUTH_TOKEN || '';

// Запросы к reddit-поиску (вход, не фильтр). Правит пользователь при желании.
const REDDIT_QUERIES = ['chess', 'chess puzzles', 'chess beginner', 'chess improvement'];

const cfg = JSON.parse(readFileSync(CFG, 'utf8'));
const loadSeen = () => { try { return new Set(JSON.parse(readFileSync(SEEN, 'utf8'))); } catch { return new Set(); } };
const saveSeen = (s) => writeFileSync(SEEN, JSON.stringify([...s].slice(-4000), null, 2) + '\n');

const seen = loadSeen();
const trackedSubs = new Set((cfg.reddit?.subreddits || []).map((s) => s.toLowerCase()));
const trackedChans = new Set(cfg.discord?.channels || []);

async function gatherReddit() {
  const out = [];
  const uniq = new Set();
  try {
    await withSession('reddit', async (page) => {
      await page.goto('https://old.reddit.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });
      for (const q of REDDIT_QUERIES) {
        const url = `https://old.reddit.com/subreddits/search.json?q=${encodeURIComponent(q)}&limit=25`;
        let data;
        try { data = await page.evaluate(async (u) => (await fetch(u, { credentials: 'include' })).json(), url); }
        catch (e) { console.error(`[discover-reddit] "${q}": ${e.message}`); continue; }
        for (const ch of data?.data?.children || []) {
          const d = ch.data || {};
          const name = (d.display_name_prefixed || '').toLowerCase(); // r/xxx
          if (!name || uniq.has(name)) continue;
          uniq.add(name);
          if (d.over18 || (d.subreddit_type && d.subreddit_type !== 'public')) continue;
          const key = `subreddit:${name}`;
          if (trackedSubs.has(name) || seen.has(key)) continue;
          out.push({
            key, sourceType: 'subreddit', sourceValue: name,
            subscribers: d.subscribers || 0,
            title: d.title || '',
            description: (d.public_description || '').slice(0, 300),
          });
        }
      }
    });
  } catch (e) {
    console.error(`[discover-reddit] ${e instanceof LoggedOutError ? 'РАЗЛОГИН reddit' : e.message}`);
  }
  return out;
}

async function gatherDiscord() {
  const out = [];
  let guilds;
  try { guilds = await listGuilds(); }
  catch (e) { console.error(`[discover-discord] guilds: ${e.message}`); return out; }
  for (const g of guilds) {
    let chans;
    try { chans = await listTextChannels(g.id); }
    catch (e) { console.error(`[discover-discord] ${g.name}: ${e.message}`); continue; }
    for (const c of chans) {
      const key = `discord-channel:${c.id}`;
      if (trackedChans.has(c.id) || seen.has(key)) continue;
      out.push({
        key, sourceType: 'discord-channel', sourceValue: c.id,
        server: g.name, channel: c.name, topic: (c.topic || '').slice(0, 300),
      });
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  return out;
}

async function poke(nReddit, nDiscord) {
  const msg = `[CRON discover] новые источники-кандидаты в tools/marketing/sessions/inbox-sources.json `
    + `(reddit ${nReddit}, discord ${nDiscord}). Оцени релевантность каждого для аудитории Kingside по `
    + `criteria.md. На достойных: addSourceProposal + marketing-bot send (уйдёт мне на ok). Остальное молча отбрось.`;
  const res = await fetch(`${WEBHOOK}/agent/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ from: 'cron', to: 'marketing', reply_required: false, message: msg }),
  });
  if (!res.ok) throw new Error(`poke failed: ${res.status} ${await res.text()}`);
}

const reddit = await gatherReddit();
const discord = await gatherDiscord();
const ts = new Date().toISOString();

if (process.argv.includes('--dry')) {
  console.log(`[discover] DRY — собрано reddit ${reddit.length}, discord ${discord.length} (seen/inbox НЕ трогаю, агент не разбужен):`);
  for (const c of reddit.slice(0, 40)) console.log(`  r ${c.sourceValue} — ${c.subscribers} подп. | ${c.title}`);
  for (const c of discord.slice(0, 40)) console.log(`  d ${c.server} → #${c.channel} (${c.sourceValue})`);
  process.exit(0);
}

// Помечаем показанным ВСЁ собранное — агент увидит каждого один раз, повтора не будет.
for (const c of [...reddit, ...discord]) seen.add(c.key);
saveSeen(seen);
writeFileSync(INBOX, JSON.stringify({ ts, reddit, discord }, null, 2) + '\n');

if (reddit.length === 0 && discord.length === 0) {
  console.log(`[discover] ${ts} — новых сообществ нет, агента не бужу`);
  process.exit(0);
}

await poke(reddit.length, discord.length);
console.log(`[discover] ${ts} — собрано reddit ${reddit.length}, discord ${discord.length}; агент разбужен на оценку`);
