#!/usr/bin/env node
/**
 * KS: крон-скан Reddit. reader → детерминированный префильтр (0 токенов) →
 * inbox-reddit.json. Пинок marketing-агента — ТОЛЬКО если есть кандидаты
 * (на пустом тике агент не будится, токены не тратятся).
 *
 *   node tools/marketing/scan-reddit.mjs
 *
 * Префильтр: tools/marketing/prefilter-config.json (правь на лету).
 * Дедуп: sessions/seen-reddit.json (url уже виденных — не шлём повторно).
 * Inbox: sessions/inbox-reddit.json — читает marketing-агент по пинку.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectSubreddit } from '../reddit-read.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(readFileSync(join(HERE, 'prefilter-config.json'), 'utf8')).reddit;
const SESSIONS = join(HERE, 'sessions');
const SEEN = join(SESSIONS, 'seen-reddit.json');
const INBOX = join(SESSIONS, 'inbox-reddit.json');

const WEBHOOK = process.env.WEBHOOK_URL || 'http://localhost:9876';
const TOKEN = process.env.WEBHOOK_AUTH_TOKEN || '';

function loadSeen() {
  try { return new Set(JSON.parse(readFileSync(SEEN, 'utf8'))); } catch { return new Set(); }
}
function saveSeen(set) {
  // Держим последние 2000 url, чтобы файл не рос бесконечно.
  writeFileSync(SEEN, JSON.stringify([...set].slice(-2000)));
}

const QUESTION_RE = /\?|how|what|which|why|recommend|help|stuck|beginner|improve/i;

function passesPrefilter(item, now) {
  if (item.timestamp && cfg.maxAgeHours) {
    const ageH = (now - item.timestamp) / 3_600_000;
    if (ageH > cfg.maxAgeHours) return false;
  }
  if (cfg.minComments != null && item.comments < cfg.minComments) return false;
  if (cfg.maxComments != null && item.comments > cfg.maxComments) return false;
  const hay = (item.title || '').toLowerCase();
  if (cfg.keywordsAny?.length && !cfg.keywordsAny.some((k) => hay.includes(k.toLowerCase()))) return false;
  if (cfg.titleMustBeQuestionOrHelp && !QUESTION_RE.test(item.title || '')) return false;
  return true;
}

async function pokeAgent(count) {
  const msg = `[CRON reddit] ${count} кандидат(ов) в tools/marketing/sessions/inbox-reddit.json. `
    + `Отмодерируй по tools/marketing/criteria.md, на прошедших подготовь черновики ответов `
    + `и отправь мне через marketing-bot send. Мусор — молча отбрось.`;
  const body = JSON.stringify({ from: 'cron', to: 'marketing', reply_required: false, message: msg });
  const res = await fetch(`${WEBHOOK}/agent/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body,
  });
  if (!res.ok) throw new Error(`poke failed: ${res.status} ${await res.text()}`);
}

async function main() {
  const now = Date.now();
  const seen = loadSeen();
  const candidates = [];
  for (const sub of cfg.subreddits) {
    let items;
    try { items = await collectSubreddit(sub, cfg.sort || 'new'); }
    catch (e) { console.error(`[scan-reddit] ${sub}: ${e.message}`); continue; }
    for (const it of items) {
      if (seen.has(it.url)) continue;
      if (!passesPrefilter(it, now)) continue;
      candidates.push(it);
      seen.add(it.url);
    }
    await new Promise((r) => setTimeout(r, 1500)); // щадящий ритм между сабами
  }
  saveSeen(seen);

  const top = candidates.slice(0, cfg.maxCandidatesPerTick || 8);
  if (top.length === 0) {
    console.log(`[scan-reddit] ${new Date().toISOString()} — новых кандидатов нет, агента не бужу`);
    writeFileSync(INBOX, JSON.stringify({ network: 'reddit', ts: now, items: [] }, null, 2));
    return;
  }
  writeFileSync(INBOX, JSON.stringify({ network: 'reddit', ts: now, items: top }, null, 2));
  await pokeAgent(top.length);
  console.log(`[scan-reddit] ${new Date().toISOString()} — ${top.length} кандидат(ов), агент разбужен`);
}

main().catch((e) => { console.error(`[scan-reddit] fatal: ${e.message}`); process.exit(1); });
