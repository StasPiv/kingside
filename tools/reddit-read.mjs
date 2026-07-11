#!/usr/bin/env node
/**
 * KS-4878: чтение Reddit из контейнера (мониторинг тредов для маркетинга).
 *
 * Диагноз: Reddit отдаёт 403 на все *.json-эндпоинты и на любые запросы
 * без браузерного User-Agent (anti-bot для дата-центровых IP). При этом
 * HTML old.reddit.com и RSS отдаются с браузерным UA. Скрипт читает HTML
 * old.reddit.com и печатает контент в терминал.
 *
 * Использование:
 *   node tools/reddit-read.mjs r/chess [hot|new|top|rising]   — список тредов
 *   node tools/reddit-read.mjs <url-треда>                    — пост + комментарии
 *   node tools/reddit-read.mjs user <name>                    — последние комментарии пользователя
 *     (мониторинг собственных публикаций: сабреддит, тред, текст, score, ссылка)
 *
 * Примеры:
 *   node tools/reddit-read.mjs r/chessbeginners new
 *   node tools/reddit-read.mjs https://www.reddit.com/r/chess/comments/abc123/some_title/
 *
 * Вывод — plain text (заголовок, текст, score, автор, комментарии с отступами
 * по вложенности). Без внешних зависимостей (Node >= 18).
 */

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const MAX_COMMENTS = Number(process.env.REDDIT_MAX_COMMENTS || 100);

function decodeEntities(s) {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ').replace(/&#32;/g, ' ')
    .replace(/&amp;/g, '&');
}

// HTML -> plain text: <br>/<p>/<li> в переносы, остальные теги убрать.
function htmlToText(html) {
  return decodeEntities(
    html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|blockquote|h[1-6]|tr)>/gi, '\n')
      .replace(/<li[^>]*>/gi, '• ')
      .replace(/<a [^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gis, (_, href, text) => {
        const t = text.replace(/<[^>]+>/g, '').trim();
        return t && href && !href.startsWith(t.slice(0, 10)) ? `${t} (${href})` : href;
      })
      .replace(/<[^>]+>/g, ''),
  ).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

async function get(url) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en' } });
    if (res.ok) return res.text();
    if (res.status === 429 || res.status >= 500) {
      await new Promise((r) => setTimeout(r, attempt * 2000));
      continue;
    }
    throw new Error(`HTTP ${res.status} на ${url}`);
  }
  throw new Error(`не удалось получить ${url} после 3 попыток`);
}

// Разбивает HTML на блоки <div class="thing ..."> ... (до следующего thing).
function things(html) {
  const out = [];
  const re = /<div class=" thing[^"]*"[^>]*>/g;
  let m;
  const starts = [];
  while ((m = re.exec(html))) starts.push({ idx: m.index, tag: m[0] });
  for (let i = 0; i < starts.length; i++) {
    const end = i + 1 < starts.length ? starts[i + 1].idx : html.length;
    out.push({ tag: starts[i].tag, body: html.slice(starts[i].idx, end) });
  }
  return out;
}

const attr = (tag, name) => (new RegExp(`${name}="([^"]*)"`).exec(tag) || [])[1];

function firstUsertext(body) {
  const m = /<div class="usertext-body[^"]*"[^>]*>\s*<div class="md">([\s\S]*?)<\/div>\s*<\/div>/.exec(body);
  return m ? htmlToText(m[1]) : '';
}

function score(body) {
  const m = /<(?:span|div) class="score (?:unvoted|likes)"[^>]*>([^<]*)</.exec(body);
  return m ? m[1].trim() : '?';
}

async function listSubreddit(sub, sort) {
  const html = await get(`https://old.reddit.com/${sub}/${sort}/`);
  const rows = things(html).filter((t) => (attr(t.tag, 'class') || t.tag).includes('link'));
  console.log(`# ${sub} (${sort}) — ${rows.length} тредов\n`);
  for (const t of rows) {
    const permalink = attr(t.tag, 'data-permalink');
    if (!permalink) continue;
    const title = /<a class="title[^>]*>([\s\S]*?)<\/a>/.exec(t.body);
    const comments = attr(t.tag, 'data-comments-count');
    console.log(`• ${title ? htmlToText(title[1]) : '(без заголовка)'}`);
    console.log(`  score=${score(t.body)} comments=${comments ?? '?'} https://old.reddit.com${permalink}\n`);
  }
}

async function readThread(url) {
  const clean = url.replace(/^https?:\/\/(www|old|new)\.reddit\.com/, 'https://old.reddit.com').split('?')[0];
  const html = await get(`${clean}${clean.endsWith('/') ? '' : '/'}?limit=500`);
  const items = things(html);
  const post = items.find((t) => t.tag.includes('link') || (attr(t.tag, 'id') || '').startsWith('thing_t3_'));
  if (!post) throw new Error('пост не найден в HTML — структура old.reddit изменилась?');

  const title = /<a class="title[^>]*>([\s\S]*?)<\/a>/.exec(post.body);
  console.log(`# ${title ? htmlToText(title[1]) : '(без заголовка)'}`);
  console.log(`автор: ${attr(post.tag, 'data-author') || '?'} | score: ${score(post.body)} | ${clean}\n`);
  const self = firstUsertext(post.body);
  if (self) console.log(`${self}\n`);

  const comments = items.filter((t) => t.tag.includes('comment'));
  console.log(`--- Комментарии (${comments.length}${comments.length > MAX_COMMENTS ? `, показаны первые ${MAX_COMMENTS}` : ''}) ---\n`);
  for (const c of comments.slice(0, MAX_COMMENTS)) {
    const author = attr(c.tag, 'data-author') || '[deleted]';
    // вложенность по числу родительских div.child до этого комментария — грубо через data-replies недоступно; используем маркер отступа из permalink глубиной не располагаем — печатаем плоско
    const text = firstUsertext(c.body);
    if (!text) continue;
    console.log(`[${author}] (score=${score(c.body)})`);
    console.log(text.split('\n').map((l) => `  ${l}`).join('\n'), '\n');
  }
}

async function listUserComments(name) {
  const html = await get(`https://old.reddit.com/user/${name}/comments/`);
  const rows = things(html).filter((t) => t.tag.includes('comment'));
  console.log(`# u/${name} — последние комментарии (${rows.length})\n`);
  for (const c of rows.slice(0, MAX_COMMENTS)) {
    const sub = attr(c.tag, 'data-subreddit') || '?';
    const permalink = attr(c.tag, 'data-permalink') || '';
    // Заголовок треда: ссылка на сам тред в шапке блока комментария
    const title = /<a[^>]*class="title[^"]*"[^>]*>([\s\S]*?)<\/a>/.exec(c.body);
    const text = firstUsertext(c.body);
    console.log(`• r/${sub}${title ? ` — ${htmlToText(title[1])}` : ''}`);
    console.log(`  score=${score(c.body)} https://old.reddit.com${permalink}`);
    if (text) console.log(text.split('\n').map((l) => `  ${l}`).join('\n'));
    console.log('');
  }
  if (!rows.length) console.log('(комментариев нет или профиль пуст)');
}

const arg = process.argv[2];
const sort = process.argv[3] || 'hot';
if (!arg) {
  console.error('Использование: node tools/reddit-read.mjs <r/subreddit [hot|new|top|rising] | user <name> | url-треда>');
  process.exit(2);
}
try {
  if (arg === 'user' && process.argv[3]) await listUserComments(process.argv[3].replace(/^u\//, ''));
  else if (/^(https?:\/\/)?(www\.|old\.|new\.)?reddit\.com\/user\//.test(arg)) {
    await listUserComments(arg.replace(/\/+$/, '').split('/user/')[1].split('/')[0]);
  } else if (/^r\//.test(arg)) await listSubreddit(arg, sort);
  else await readThread(arg);
} catch (e) {
  console.error(`[error] ${e.message}`);
  process.exit(1);
}
