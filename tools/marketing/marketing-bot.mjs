#!/usr/bin/env node
/**
 * KS-4908: контур черновиков через выделенного бота @kingside_marketing_bot.
 *
 * Отправка — sendMessage, приём ответов — getUpdates (long-poll разово,
 * webhook НЕ используется). Координаторный telegram_send для черновиков
 * больше не применяется.
 *
 * Токен: tools/marketing/.marketing-bot-token (0600, вне git) или env
 * MARKETING_BOT_TOKEN. Состояние (chat_id пользователя, смещение updates):
 * sessions/bot-state.json.
 *
 * Использование:
 *   node tools/marketing/marketing-bot.mjs start            — принять /start пользователя (регистрация chat_id)
 *   node tools/marketing/marketing-bot.mjs send <draft-id>  — отправить черновик пользователю
 *   node tools/marketing/marketing-bot.mjs poll             — забрать ответы: ok/skip/правка[/с id] → резолв
 *                                                             + публикация approved через publish.mjs
 *   node tools/marketing/marketing-bot.mjs notify "текст"   — произвольное сообщение пользователю (≤280)
 *
 * Коды выхода poll: 0 — обработано (или пусто); 1 — ошибка API/токена.
 */

import { readFileSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { SESSIONS_DIR } from './session-lib.mjs';
import { loadDrafts, resolveReply } from './publish-lib.mjs';

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const BOT_STATE = join(SESSIONS_DIR, 'bot-state.json');

function token() {
  if (process.env.MARKETING_BOT_TOKEN) return process.env.MARKETING_BOT_TOKEN.trim();
  const p = join(HERE, '.marketing-bot-token');
  try {
    return readFileSync(p, 'utf8').trim();
  } catch {
    console.error(`[error] токен не найден: задай MARKETING_BOT_TOKEN или создай ${p} (0600)`);
    process.exit(1);
  }
}

const api = async (method, params = {}) => {
  const res = await fetch(`https://api.telegram.org/bot${token()}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  const body = await res.json();
  if (!body.ok) throw new Error(`${method}: ${body.description || res.status}`);
  return body.result;
};

const loadState = () => { try { return JSON.parse(readFileSync(BOT_STATE, 'utf8')); } catch { return {}; } };
const saveState = (s) => { writeFileSync(BOT_STATE, JSON.stringify(s, null, 2)); chmodSync(BOT_STATE, 0o600); };

async function fetchUpdates(state, timeoutSec = 0) {
  const updates = await api('getUpdates', {
    offset: (state.lastUpdateId ?? 0) + 1,
    timeout: timeoutSec,
    allowed_updates: ['message'],
  });
  if (updates.length) {
    state.lastUpdateId = updates[updates.length - 1].update_id;
    saveState(state);
  }
  return updates;
}

const requireChat = (state) => {
  if (!state.chatId) {
    console.error('[error] chat_id не зарегистрирован — пользователь ещё не написал боту /start (команда start)');
    process.exit(1);
  }
  return state.chatId;
};

const send = (chatId, text) => api('sendMessage', { chat_id: chatId, text, disable_web_page_preview: false });

// --- Команды ---

const [cmd, ...rest] = process.argv.slice(2);
const state = loadState();

if (cmd === 'start') {
  // Ждём /start до 120 с (координатор просит пользователя написать боту)
  const deadline = Date.now() + 120_000;
  let found = null;
  while (Date.now() < deadline && !found) {
    const updates = await fetchUpdates(state, 20);
    found = updates.map((u) => u.message).find((m) => m?.text?.startsWith('/start'));
  }
  if (!found) {
    console.error('за 120 с /start не пришёл — запусти ещё раз, когда пользователь напишет боту');
    process.exit(1);
  }
  state.chatId = found.chat.id;
  state.user = found.from?.username || found.from?.first_name || '';
  saveState(state);
  await send(state.chatId, 'Контур черновиков подключён. Черновики публикаций будут приходить сюда; отвечай: ok · skip · свой текст (при нескольких активных — начни ответ с id черновика).');
  console.log(`chat_id зарегистрирован: ${state.chatId} (@${state.user})`);
} else if (cmd === 'send') {
  const chatId = requireChat(state);
  const draft = loadDrafts()[rest[0]];
  if (!draft) { console.error(`черновик «${rest[0]}» не найден`); process.exit(2); }
  await send(chatId, `ЧЕРНОВИК ${rest[0]} [${draft.platform}]${draft.note ? ` — ${draft.note}` : ''}\n${draft.url}\nОтветь: ok · skip · свой текст.`);
  await send(chatId, draft.text);
  console.log(`черновик ${rest[0]} отправлен в чат ${chatId}`);
} else if (cmd === 'notify') {
  const chatId = requireChat(state);
  await send(chatId, rest.join(' ').slice(0, 280));
  console.log('отправлено');
} else if (cmd === 'poll') {
  const chatId = requireChat(state);
  const updates = await fetchUpdates(state, 0);
  const replies = updates
    .map((u) => u.message)
    .filter((m) => m && m.chat?.id === chatId && m.text && !m.text.startsWith('/'));
  if (!replies.length) { console.log('новых ответов нет'); process.exit(0); }
  for (const m of replies) {
    const r = resolveReply(m.text);
    if (r.error) { await send(chatId, `⚠️ ${r.error}`); console.log(`ответ «${m.text.slice(0, 40)}»: ${r.error}`); continue; }
    if (r.ambiguous) {
      await send(chatId, `Активных черновиков несколько — начни ответ с id: ${r.ambiguous.join(', ')}`);
      console.log(`ambiguous: ${r.ambiguous.join(', ')}`);
      continue;
    }
    console.log(`черновик ${r.id} → ${r.draft.status}`);
    if (r.draft.status === 'approved') {
      const { stdout, stderr, code } = await run('node', [join(HERE, 'publish.mjs'), r.id]).catch((e) => e);
      const ok = (stdout || '').includes('Опубликовано');
      await send(chatId, ok ? `✅ ${r.id} опубликован: ${r.draft.url}` : `⚠️ ${r.id} не опубликован: ${(stderr || stdout || '').trim().slice(0, 200)}`);
      console.log((stdout || stderr || '').trim());
      if (!ok && code === 5) console.error('СТОП-КРАН — платформа остановлена');
    } else if (r.draft.status === 'skipped') {
      await send(chatId, `Ок, ${r.id} не публикуем.`);
    } else if (r.draft.status === 'expired') {
      await send(chatId, `${r.id} уже сгорел (4 часа) — не публикую. Если нужно, пришлю новый черновик.`);
    }
  }
} else {
  console.error('Использование: node tools/marketing/marketing-bot.mjs <start | send <draft-id> | poll | notify "текст">');
  process.exit(2);
}
