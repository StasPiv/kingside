#!/usr/bin/env node
/**
 * Чтение X/Twitter из контейнера без логина (мониторинг лент для маркетинга).
 *
 * Механизм: официальный syndication-эндпоинт X (виджеты для встраивания)
 * отдаёт последние твиты аккаунта без аутентификации. x.com напрямую
 * недоступен (анти-бот), nitter-инстансы нестабильны — syndication надёжнее.
 * Ограничение: только последние ~20 твитов публичного аккаунта; поиск
 * по хэштегам/ключевым словам эндпоинт не даёт.
 *
 * Использование:
 *   node tools/x-read.mjs <screen_name> [screen_name2 ...]
 * Пример:
 *   node tools/x-read.mjs chesscom GothamChess lichess
 */

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

async function readTimeline(name) {
  const url = `https://syndication.twitter.com/srv/timeline-profile/screen-name/${name}`;
  let html;
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (res.ok) { html = await res.text(); break; }
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      await new Promise((r) => setTimeout(r, attempt * 5000));
      continue;
    }
    throw new Error(`HTTP ${res.status} для @${name}`);
  }
  // Данные лежат в JSON внутри <script id="__NEXT_DATA__">
  const m = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  if (!m) throw new Error(`__NEXT_DATA__ не найден для @${name} — структура изменилась?`);
  const data = JSON.parse(m[1]);
  const entries = data?.props?.pageProps?.timeline?.entries || [];
  console.log(`# @${name} — ${entries.length} твитов\n`);
  for (const e of entries) {
    const t = e?.content?.tweet;
    if (!t) continue;
    const date = t.created_at ? new Date(t.created_at).toISOString().slice(0, 16).replace('T', ' ') : '?';
    const rt = t.retweeted_status ? ` [RT @${t.retweeted_status.user?.screen_name}]` : '';
    console.log(`• ${date}${rt} ♥${t.favorite_count ?? '?'} ↻${t.retweet_count ?? '?'}`);
    console.log(`  ${(t.full_text || t.text || '').replace(/\n/g, '\n  ')}`);
    console.log(`  https://x.com/${name}/status/${t.id_str}\n`);
  }
  if (!entries.length) console.log('(твитов нет или аккаунт закрыт)');
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
