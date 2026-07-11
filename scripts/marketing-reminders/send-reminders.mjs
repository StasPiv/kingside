#!/usr/bin/env node
/**
 * KS-4870: планировщик Telegram-напоминаний по маркетинговому календарю.
 *
 * Данные: tools/marketing/reminders.json (монтируется в /config/reminders.json).
 * Файл перечитывается каждый тик — правки текстов/расписания подхватываются
 * без перезапуска контейнера.
 *
 * Механика:
 * - тик раз в 30 секунд;
 * - напоминание "должно уйти сегодня", если сегодня подходящий день
 *   (daily / weekly по dow / monthly по dom) и текущее время >= time;
 * - состояние отправок (id -> дата последней отправки) в /state/state.json
 *   (named volume) — переживает перезапуск и не дублирует сообщения;
 * - если контейнер был выключен в момент срабатывания — сообщение уходит
 *   сразу после старта (catch-up в пределах того же дня);
 * - все напоминания, созревшие в один тик, склеиваются в одно сообщение;
 * - при ошибке отправки состояние не обновляется — повтор на следующем тике.
 *
 * Env: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, REMINDERS_TZ (default Europe/Kyiv),
 *      REMINDERS_CONFIG (default /config/reminders.json),
 *      REMINDERS_STATE (default /state/state.json).
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const TZ = process.env.REMINDERS_TZ || 'Europe/Kyiv';
const CONFIG_PATH = process.env.REMINDERS_CONFIG || '/config/reminders.json';
const STATE_PATH = process.env.REMINDERS_STATE || '/state/state.json';
const TICK_MS = 30_000;

if (!TOKEN || !CHAT_ID || CHAT_ID === '0') {
  console.error('[fatal] TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID не заданы');
  process.exit(1);
}

const DOW = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

function nowInTz() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: TZ, hour12: false, year: 'numeric', month: '2-digit',
      day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short',
    }).formatToParts(new Date()).map((p) => [p.type, p.value]),
  );
  return {
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: (Number(parts.hour) % 24) * 60 + Number(parts.minute),
    dow: DOW[parts.weekday],
    dom: Number(parts.day),
  };
}

function parseTime(t) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function loadJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    if (fallback !== undefined) return fallback;
    throw e;
  }
}

function saveState(state) {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function isDueToday(rec, now) {
  switch (rec.type) {
    case 'daily': return true;
    case 'weekly': return Number(rec.dow) === now.dow;
    case 'monthly': return Number(rec.dom) === now.dom;
    default: return false;
  }
}

async function sendTelegram(text) {
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: CHAT_ID, text }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.ok === false) {
    throw new Error(`telegram ${res.status}: ${JSON.stringify(body)}`);
  }
}

async function tick() {
  let config;
  try {
    config = loadJson(CONFIG_PATH);
  } catch (e) {
    console.error(`[error] не читается ${CONFIG_PATH}: ${e.message}`);
    return;
  }
  const reminders = Array.isArray(config.reminders) ? config.reminders : [];
  const now = nowInTz();
  const state = loadJson(STATE_PATH, {});

  const due = reminders.filter((r) => {
    const t = parseTime(r.time);
    return r.id && r.text && t !== null
      && isDueToday(r, now)
      && now.minutes >= t
      && state[r.id] !== now.dateKey;
  });
  if (!due.length) return;

  const text = '📣 Kingside — план на сегодня:\n\n'
    + due.map((r) => `• [${r.id}] ${r.text}`).join('\n');
  try {
    await sendTelegram(text);
    for (const r of due) state[r.id] = now.dateKey;
    saveState(state);
    console.log(`[sent] ${now.dateKey} ${due.map((r) => r.id).join(',')}`);
  } catch (e) {
    console.error(`[error] отправка не удалась, повтор через тик: ${e.message}`);
  }
}

console.log(`[start] tz=${TZ} config=${CONFIG_PATH} state=${STATE_PATH}`);
await tick();
setInterval(() => tick().catch((e) => console.error(`[error] ${e.message}`)), TICK_MS);
