#!/usr/bin/env node
/**
 * Чтение X/Twitter из контейнера без логина (мониторинг лент для маркетинга).
 *
 * Механизм: официальный syndication-эндпоинт X (виджеты для встраивания)
 * отдаёт последние твиты аккаунта без аутентификации. x.com напрямую
 * недоступен (анти-бот), nitter-инстансы нестабильны — syndication надёжнее.
 * Ограничение: только последние ~100 твитов публичного аккаунта; поиск
 * по хэштегам/ключевым словам эндпоинт не даёт.
 *
 * Лимит эндпоинта: 30 запросов / ~15 мин на связку IP+User-Agent (KS-4902).
 * Обход: пул User-Agent'ов — при 429 запрос повторяется с другой подписью
 * (другая связка = другое окно лимита). Успешный ответ кэшируется в /tmp;
 * если все подписи исчерпаны — отдаётся кэш с пометкой возраста.
 *
 * Использование:
 *   node tools/x-read.mjs <screen_name> [screen_name2 ...]
 *   FRESH_HOURS=24 node tools/x-read.mjs chesscom   — показать только твиты за N часов
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);

const UA_POOL = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0',
  'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
];

const cachePath = (name) => `/tmp/x-cache-${name.toLowerCase()}.json`;

/**
 * KS-4902: node fetch (undici) получает 429 там, где curl получает 200 с тем же
 * IP и User-Agent — эндпоинт различает TLS/HTTP-отпечаток клиента и режет
 * не-браузерные. curl проходит стабильно, поэтому запрос идёт через curl.
 */
async function fetchTimeline(name) {
  const url = `https://syndication.twitter.com/srv/timeline-profile/screen-name/${name}`;
  let lastStatus = 0;
  for (const ua of UA_POOL) {
    const { stdout } = await run('curl', [
      '-s', '-m', '15', '-w', '\n%{http_code}', url, '-H', `User-Agent: ${ua}`,
    ]);
    const cut = stdout.lastIndexOf('\n');
    const status = Number(stdout.slice(cut + 1));
    if (status === 200) return { html: stdout.slice(0, cut) };
    lastStatus = status;
    if (status !== 429) break; // не лимит — смена подписи не поможет
    await new Promise((r) => setTimeout(r, 800));
  }
  throw new Error(`HTTP ${lastStatus} для @${name} (все ${UA_POOL.length} подписей)`);
}

function parseEntries(html, name) {
  const m = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  if (!m) throw new Error(`__NEXT_DATA__ не найден для @${name} — структура изменилась?`);
  const data = JSON.parse(m[1]);
  const entries = data?.props?.pageProps?.timeline?.entries || [];
  return entries
    .map((e) => e?.content?.tweet)
    .filter(Boolean)
    .map((t) => ({
      date: t.created_at ? new Date(t.created_at).toISOString().slice(0, 16).replace('T', ' ') : '?',
      ts: t.created_at ? Date.parse(t.created_at) : 0,
      rt: t.retweeted_status ? t.retweeted_status.user?.screen_name : null,
      likes: t.favorite_count ?? '?',
      rts: t.retweet_count ?? '?',
      text: t.full_text || t.text || '',
      url: `https://x.com/${name}/status/${t.id_str}`,
    }))
    .sort((a, b) => b.ts - a.ts); // свежие сверху — мониторингу важна хронология
}

function printTweets(name, tweets, note) {
  const freshHours = Number(process.env.FRESH_HOURS || 0);
  const list = freshHours ? tweets.filter((t) => t.ts > Date.now() - freshHours * 3600_000) : tweets;
  console.log(`# @${name} — ${list.length} твитов${freshHours ? ` за ${freshHours}ч` : ''}${note ? ` ${note}` : ''}\n`);
  for (const t of list) {
    console.log(`• ${t.date}${t.rt ? ` [RT @${t.rt}]` : ''} ♥${t.likes} ↻${t.rts}`);
    console.log(`  ${t.text.replace(/\n/g, '\n  ')}`);
    console.log(`  ${t.url}\n`);
  }
  if (!list.length) console.log('(твитов нет, аккаунт закрыт или всё старше фильтра)');
}

async function readTimeline(name) {
  try {
    const { html } = await fetchTimeline(name);
    const tweets = parseEntries(html, name);
    writeFileSync(cachePath(name), JSON.stringify({ at: Date.now(), tweets }));
    printTweets(name, tweets);
  } catch (e) {
    // Лимит на всех подписях — отдаём кэш, если есть
    try {
      const c = JSON.parse(readFileSync(cachePath(name), 'utf8'));
      const ageMin = Math.round((Date.now() - c.at) / 60000);
      printTweets(name, c.tweets, `(кэш, ${ageMin} мин назад; живое чтение: ${e.message})`);
    } catch {
      throw e;
    }
  }
}

const names = process.argv.slice(2);
if (!names.length) {
  console.error('Использование: node tools/x-read.mjs <screen_name> [ещё...]');
  process.exit(2);
}
for (const n of names) {
  try {
    await readTimeline(n.replace(/^@/, ''));
  } catch (e) {
    console.error(`[error] ${e.message}`);
  }
}
