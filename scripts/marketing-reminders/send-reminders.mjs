#!/usr/bin/env node
/**
 * KS-4870, KS-4876: планировщик Telegram-напоминаний по маркетинговому календарю.
 *
 * Данные:
 * - tools/marketing/reminders.json (в контейнере /config/reminders.json) —
 *   календарь; перечитывается каждый тик, правки подхватываются без перезапуска;
 * - tools/marketing/briefs/{daily,weekly,monthly}/ (в контейнере /config/briefs) —
 *   брифы маркетолога (контракт — social-organic-strategy.md §3.1):
 *     daily/YYYY-MM-DD.md, weekly/YYYY-Www.md (ISO-неделя), monthly/YYYY-MM.md.
 *
 * Плейсхолдеры (KS-4876): в тексте напоминания допустимы {brief:daily},
 * {brief:weekly}, {brief:monthly}. В сообщение добавляется содержимое
 * актуального на дату отправки файла брифа — одной секцией после списка
 * пунктов, один раз на сообщение, даже если плейсхолдер встречается в
 * нескольких пунктах. Если файла нет — пометка «бриф не подготовлен»,
 * отправка не блокируется.
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
 * - сообщения длиннее лимита Telegram (4096) режутся на части по строкам;
 * - при ошибке отправки состояние не обновляется — повтор на следующем тике.
 *
 * Env: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, REMINDERS_TZ (default Europe/Prague),
 *      REMINDERS_CONFIG (default /config/reminders.json),
 *      REMINDERS_BRIEFS (default /config/briefs),
 *      REMINDERS_STATE (default /state/state.json),
 *      REMINDERS_DRY_RUN=1 — печатать сообщения в stdout вместо Telegram.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const TZ = process.env.REMINDERS_TZ || 'Europe/Prague';
const CONFIG_PATH = process.env.REMINDERS_CONFIG || '/config/reminders.json';
const BRIEFS_DIR = process.env.REMINDERS_BRIEFS || '/config/briefs';
const STATE_PATH = process.env.REMINDERS_STATE || '/state/state.json';
const DRY_RUN = process.env.REMINDERS_DRY_RUN === '1';
const TICK_MS = 30_000;
const TG_LIMIT = 4096;
const CHUNK_LIMIT = 4000; // запас под нумерацию частей

if (!DRY_RUN && (!TOKEN || !CHAT_ID || CHAT_ID === '0')) {
  console.error('[fatal] TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID не заданы');
  process.exit(1);
}

const DOW = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
const BRIEF_LABEL = { daily: 'Дневной бриф', weekly: 'Недельный бриф', monthly: 'Месячный бриф' };

function nowInTz() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: TZ, hour12: false, year: 'numeric', month: '2-digit',
      day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short',
    }).formatToParts(new Date()).map((p) => [p.type, p.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
    monthKey: `${parts.year}-${parts.month}`,
    minutes: (Number(parts.hour) % 24) * 60 + Number(parts.minute),
    dow: DOW[parts.weekday],
    dom: Number(parts.day),
  };
}

// ISO-неделя (YYYY-Www) по календарной дате.
function isoWeekKey(y, m, d) {
  const date = new Date(Date.UTC(y, m - 1, d));
  const dayNum = (date.getUTCDay() + 6) % 7; // Пн=0
  date.setUTCDate(date.getUTCDate() - dayNum + 3); // четверг этой недели
  const isoYear = date.getUTCFullYear();
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const week = 1 + Math.round(
    ((date - jan4) / 86400000 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7,
  );
  return `${isoYear}-W${String(week).padStart(2, '0')}`;
}

// Имя файла актуального брифа данного типа на дату now (без каталога).
function briefFileName(type, now) {
  switch (type) {
    case 'daily': return `${now.dateKey}.md`;
    case 'weekly': return `${isoWeekKey(now.year, now.month, now.day)}.md`;
    case 'monthly': return `${now.monthKey}.md`;
    default: return null;
  }
}

// { type, relPath, content|null }
function loadBrief(type, now) {
  const file = briefFileName(type, now);
  if (!file) return null;
  const relPath = `${type}/${file}`;
  try {
    const content = readFileSync(join(BRIEFS_DIR, type, file), 'utf8').trim();
    return { type, relPath, content: content || null };
  } catch {
    return { type, relPath, content: null };
  }
}

const PLACEHOLDER_RE = /\{brief:(daily|weekly|monthly)\}/g;

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

// Собирает текст сообщения: пункты + секции упомянутых брифов.
function buildMessage(due, now) {
  const briefTypes = [];
  const items = due.map((r) => {
    const text = String(r.text).replace(PLACEHOLDER_RE, (_, type) => {
      if (!briefTypes.includes(type)) briefTypes.push(type);
      return `(${BRIEF_LABEL[type].toLowerCase()} — ниже)`;
    });
    return `• [${r.id}] ${text}`;
  });

  let msg = `📣 Kingside — план на сегодня:\n\n${items.join('\n')}`;
  for (const type of briefTypes) {
    const brief = loadBrief(type, now);
    if (brief.content) {
      msg += `\n\n━━━ 📄 ${BRIEF_LABEL[type]} (${brief.relPath}) ━━━\n${brief.content}`;
    } else {
      msg += `\n\n━━━ ⚠️ ${BRIEF_LABEL[type]} не подготовлен (ожидался briefs/${brief.relPath}) ━━━`;
    }
  }
  return msg;
}

// Режет текст на части <= limit, стараясь по границам строк.
function chunkText(text, limit = CHUNK_LIMIT) {
  if (text.length <= limit) return [text];
  const chunks = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit);
    if (cut < limit / 2) cut = limit; // нет удобного переноса — режем жёстко
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  if (rest) chunks.push(rest);
  return chunks.map((c, i) => (chunks.length > 1 ? `(${i + 1}/${chunks.length})\n${c}` : c));
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

async function deliver(text) {
  for (const chunk of chunkText(text)) {
    if (chunk.length > TG_LIMIT) throw new Error('chunk превышает лимит Telegram');
    if (DRY_RUN) {
      console.log(`--- dry-run message (${chunk.length} chars) ---\n${chunk}\n--- end ---`);
    } else {
      await sendTelegram(chunk);
    }
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

  try {
    await deliver(buildMessage(due, now));
    for (const r of due) state[r.id] = now.dateKey;
    saveState(state);
    console.log(`[sent] ${now.dateKey} ${due.map((r) => r.id).join(',')}`);
  } catch (e) {
    console.error(`[error] отправка не удалась, повтор через тик: ${e.message}`);
  }
}

console.log(`[start] tz=${TZ} config=${CONFIG_PATH} briefs=${BRIEFS_DIR} state=${STATE_PATH} dry=${DRY_RUN ? 1 : 0}`);
await tick();
setInterval(() => tick().catch((e) => console.error(`[error] ${e.message}`)), TICK_MS);
