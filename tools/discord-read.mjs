#!/usr/bin/env node
/**
 * Чтение Discord-каналов для мониторинга (маркетинг).
 *
 * Токен: env DISCORD_TOKEN или файл tools/marketing/.discord-token
 * (файл НЕ коммитить — токен даёт полный доступ к аккаунту).
 *
 * Использование:
 *   node tools/discord-read.mjs me                      — аккаунт + список серверов
 *   node tools/discord-read.mjs channels <guild_id>     — текстовые каналы сервера
 *   node tools/discord-read.mjs read <channel_id> [N]   — последние N сообщений (по умолчанию 30)
 *
 * Частота: между запросами пауза 1.5с, уважение retry_after при 429 —
 * щадящий режим, не дёргать чаще 3 циклов мониторинга в день.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const API = 'https://discord.com/api/v9';

function token() {
  if (process.env.DISCORD_TOKEN) return process.env.DISCORD_TOKEN.trim();
  const p = join(dirname(fileURLToPath(import.meta.url)), 'marketing', '.discord-token');
  try {
    return readFileSync(p, 'utf8').trim();
  } catch {
    console.error(`[error] токен не найден: задай DISCORD_TOKEN или создай ${p}`);
    process.exit(2);
  }
}

let last = 0;
async function api(path) {
  const wait = last + 1500 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  last = Date.now();
  const res = await fetch(`${API}${path}`, {
    headers: {
      Authorization: token(),
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
    },
  });
  if (res.status === 429) {
    const body = await res.json().catch(() => ({}));
    const delay = (body.retry_after || 5) * 1000 + 500;
    await new Promise((r) => setTimeout(r, delay));
    return api(path);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} на ${path}${res.status === 401 ? ' — токен невалиден/истёк' : ''}`);
  return res.json();
}

const fmtTs = (iso) => (iso ? iso.slice(0, 16).replace('T', ' ') : '?');

async function me() {
  const u = await api('/users/@me');
  console.log(`Аккаунт: ${u.username}${u.discriminator && u.discriminator !== '0' ? '#' + u.discriminator : ''} (id ${u.id})\n`);
  const guilds = await api('/users/@me/guilds');
  console.log(`Серверы (${guilds.length}):`);
  for (const g of guilds) console.log(`• ${g.name} — guild_id ${g.id}`);
  if (!guilds.length) console.log('(аккаунт не состоит ни в одном сервере)');
}

async function channels(guildId) {
  const chs = await api(`/guilds/${guildId}/channels`);
  const text = chs.filter((c) => c.type === 0 || c.type === 5).sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  console.log(`Текстовые каналы (${text.length}):`);
  for (const c of text) console.log(`• #${c.name} — channel_id ${c.id}${c.topic ? ` | ${c.topic.slice(0, 80)}` : ''}`);
}

async function read(channelId, limit) {
  const chan = await api(`/channels/${channelId}`);
  const guildId = chan.guild_id || '@me';
  const msgs = await api(`/channels/${channelId}/messages?limit=${Math.min(limit, 100)}`);
  console.log(`# Последние ${msgs.length} сообщений (новые сверху)\n`);
  for (const m of msgs) {
    const replyTo = m.referenced_message ? ` ↩ ${m.referenced_message.author?.username}` : '';
    console.log(`[${fmtTs(m.timestamp)}] ${m.author?.username}${replyTo}: ${(m.content || '(вложение/эмбед)').replace(/\n/g, ' ⏎ ')}`);
    console.log(`  → https://discord.com/channels/${guildId}/${channelId}/${m.id}`);
  }
}

// Список серверов аккаунта (для открывателя источников).
export async function listGuilds() {
  const guilds = await api('/users/@me/guilds');
  return guilds.map((g) => ({ id: g.id, name: g.name }));
}

// Текстовые каналы сервера (type 0/5), которые аккаунт может читать.
export async function listTextChannels(guildId) {
  const chs = await api(`/guilds/${guildId}/channels`);
  return chs
    .filter((c) => c.type === 0 || c.type === 5)
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .map((c) => ({ id: c.id, name: c.name, topic: c.topic || '' }));
}

// Структурный сбор сообщений канала (для scan-discord / префильтра).
export async function collectMessages(channelId, limit = 50) {
  const chan = await api(`/channels/${channelId}`);
  const guildId = chan.guild_id || '@me';
  const msgs = await api(`/channels/${channelId}/messages?limit=${Math.min(limit, 100)}`);
  return msgs.map((m) => ({
    channelId,
    author: m.author?.username || '',
    bot: !!m.author?.bot,
    text: m.content || '',
    ts: m.timestamp ? Date.parse(m.timestamp) : 0,
    url: `https://discord.com/channels/${guildId}/${channelId}/${m.id}`,
  }));
}

import { pathToFileURL } from 'node:url';
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const [cmd, arg, n] = process.argv.slice(2);
  try {
    if (cmd === 'me') await me();
    else if (cmd === 'channels' && arg) await channels(arg);
    else if (cmd === 'read' && arg) await read(arg, Number(n) || 30);
    else {
      console.error('Использование: node tools/discord-read.mjs <me | channels <guild_id> | read <channel_id> [N]>');
      process.exit(2);
    }
  } catch (e) {
    console.error(`[error] ${e.message}`);
    process.exit(1);
  }
}
