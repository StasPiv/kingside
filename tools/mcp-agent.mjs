#!/usr/bin/env node
/**
 * MCP Server для агентов Kingside — обёртка над HTTP endpoints
 * трекера (localhost:8090) и webhook-сервера (localhost:9876).
 *
 * Env: WEBHOOK_AUTH_TOKEN, AGENT_NAME (имя текущего агента, для from в message)
 */

import { createInterface } from 'readline';
import { spawn } from 'child_process';
import nodeHttp from 'node:http';
import { URL } from 'node:url';

const TOKEN = process.env.WEBHOOK_AUTH_TOKEN || '';
const AGENT = process.env.AGENT_NAME || '';
const DEV_BYPASS = process.env.VITE_DEV_BYPASS_SECRET || 'secret';
const TRACKER = 'http://localhost:8090';
const WEBHOOK = 'http://localhost:9876';

const TOOLS = [
  // --- Tracker ---
  { name: 'issue_get', description: 'Получить задачу трекера по ключу (KS-XX).',
    inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] } },
  { name: 'issue_search', description: 'Поиск задач по фильтрам (assignee, status, labels CSV, search).',
    inputSchema: { type: 'object', properties: { assignee: { type: 'string' }, status: { type: 'string', enum: ['todo','in_progress','done'] }, labels: { type: 'string', description: 'CSV меток, задача должна содержать ВСЕ' }, search: { type: 'string' } } } },
  { name: 'issue_create', description: 'Создать задачу. Метки обязательны (1-3).',
    inputSchema: { type: 'object', properties: { summary: { type: 'string' }, description: { type: 'string' }, assignee: { type: 'string' }, labels: { type: 'array', items: { type: 'string' } } }, required: ['summary', 'labels'] } },
  { name: 'issue_update', description: 'Обновить поля задачи (summary, description, assignee, status, labels).',
    inputSchema: { type: 'object', properties: { key: { type: 'string' }, summary: { type: 'string' }, description: { type: 'string' }, assignee: { type: 'string' }, status: { type: 'string' }, labels: { type: 'array', items: { type: 'string' } } }, required: ['key'] } },
  { name: 'issue_transition', description: 'Сменить статус задачи. 11=To Do, 21=In Progress, 41=Done. Ролевые ограничения: 21 — только assignee задачи; 11 и 41 — только coordinator. actor подставляется автоматически из AGENT_NAME.',
    inputSchema: { type: 'object', properties: { key: { type: 'string' }, id: { type: 'number' } }, required: ['key', 'id'] } },
  { name: 'issue_comments', description: 'Получить список комментариев задачи.',
    inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] } },
  { name: 'comment_add', description: 'Добавить комментарий к задаче.',
    inputSchema: { type: 'object', properties: { key: { type: 'string' }, body: { type: 'string' }, author: { type: 'string', description: 'Автор, по умолчанию AGENT_NAME' } }, required: ['key', 'body'] } },

  // --- Webhook ---
  { name: 'commit', description: 'Коммит изменённых файлов в main (требует роль).',
    inputSchema: { type: 'object', properties: { message: { type: 'string' }, files: { type: 'array', items: { type: 'string' } } }, required: ['message', 'files'] } },
  { name: 'git_log', description: 'Прочитать git-историю репозитория. mode="log" (по умолчанию): список коммитов с фильтрами since/grep/path; mode="show": diff одного коммита по sha. Используй при диагностике регрессий и поиске виновного коммита.',
    inputSchema: { type: 'object', properties: {
      mode: { type: 'string', enum: ['log', 'show'], description: 'log — список коммитов; show — diff коммита (нужен sha)' },
      since: { type: 'string', description: 'для mode=log: ограничить по дате, например "2026-05-04" или "1 day ago"' },
      limit: { type: 'number', description: 'для mode=log: сколько коммитов (1..500, по умолч. 50)' },
      path: { type: 'string', description: 'для mode=log: фильтр по пути, например "apps/web/src"' },
      grep: { type: 'string', description: 'для mode=log: поиск подстроки в commit message' },
      sha: { type: 'string', description: 'для mode=show: SHA коммита (hex)' },
    } } },
  { name: 'agent_message', description: 'Прямое сообщение другому агенту. Ставится в FIFO-очередь target; target увидит его следующим tool-запросом. reply_required — обязательный флаг: true (target обязан ответить) | false (уведомление без ответа).',
    inputSchema: { type: 'object', properties: {
      to: { type: 'string' },
      message: { type: 'string' },
      reply_required: { type: 'boolean', description: 'ОБЯЗАТЕЛЬНО. true — target обязан ответить через agent_message, webhook пришлёт напоминание если не ответит. false — уведомление/ACK, ответ не ожидается' },
    }, required: ['to', 'message', 'reply_required'] } },
  { name: 'agent_kill', description: 'Убить daemon-процесс агента (координатор).',
    inputSchema: { type: 'object', properties: { agent: { type: 'string' } }, required: ['agent'] } },
  { name: 'agent_status', description: 'Получить статус всех daemon-агентов: alive, busy, queue_size, message_count, total_cost. Без параметров возвращает всех.',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'agent_logs', description: 'Получить последние события из текущей сессии другого агента (text, tool_use, tool_result, result). Для диагностики — что делал агент, где застрял.',
    inputSchema: { type: 'object', properties: {
      agent: { type: 'string', description: 'Имя агента' },
      limit: { type: 'number', description: 'Сколько последних событий (по умолчанию 30)' },
    }, required: ['agent'] } },
  { name: 'telegram_send', description: 'Отправить сообщение пользователю в Telegram.',
    inputSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] } },
  { name: 'deploy', description: 'Запустить деплой на AWS. scope: frontend | api | game-service | broadcast-service | archive-service | tactic-worker | workers (broadcast+archive) | all | "" (auto).',
    inputSchema: { type: 'object', properties: { scope: { type: 'string' } } } },
  { name: 'npm_install', description: 'Запустить npm install на хосте (после изменения package.json).',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'api_start', description: 'Запустить API на хосте. По умолчанию идемпотентно (если уже запущен — ничего не делает). С force=true убивает старый процесс и поднимает заново — нужно после изменения .env или пересборки зависимостей.',
    inputSchema: { type: 'object', properties: {
      force: { type: 'boolean', description: 'true — убить старый процесс и перезапустить (для подхвата нового .env)' },
    } } },
  { name: 'vite_start', description: 'Перезапустить vite dev-сервер на 5173 (убивает старый процесс перед стартом). Нужно после изменения .env или пересборки зависимостей.',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'docker_compose', description: 'Выполнить docker compose <command> <args...> на хосте. Whitelist: build, up, down, logs, ps, config, restart. Требует роль ROLE_DOCKER_COMPOSE (только devops).',
    inputSchema: { type: 'object', properties: {
      command: { type: 'string', enum: ['build', 'up', 'down', 'logs', 'ps', 'config', 'restart'] },
      args: { type: 'array', items: { type: 'string' }, description: 'Дополнительные аргументы, например ["archive-importer"] или ["--build", "archive-importer"]' },
    }, required: ['command'] } },
  { name: 'npm_run', description: 'Выполнить npm run <script> на хосте. Whitelist: build, test, lint, prisma:generate, prisma:migrate. Long-running скрипты (dev/start) НЕ поддерживаются — используй /api-start или /up endpoints.',
    inputSchema: { type: 'object', properties: {
      script: { type: 'string', enum: ['build', 'test', 'lint', 'prisma:generate', 'prisma:migrate'] },
      workspace: { type: 'string', description: 'Опционально: имя workspace, например "@kingside/archive-importer"' },
    }, required: ['script'] } },

  // --- Playwright ---
  { name: 'screenshot', description: 'Скриншот страницы localhost:5173 через Playwright с dev_bypass (без логина). Сохраняет в /tmp/<task>/<name>.png.',
    inputSchema: { type: 'object', properties: {
      task: { type: 'string', description: 'Ключ задачи, например "KS-1592"' },
      path: { type: 'string', description: 'Относительный путь страницы, например "/broadcasts"' },
      name: { type: 'string', description: 'Имя файла без расширения' },
      viewport: { type: 'string', description: '"desktop" (1280x720) или "mobile" (390x844)' },
      waitFor: { type: 'number', description: 'Пауза в мс перед скриншотом' },
    }, required: ['task', 'path', 'name'] } },

  { name: 'interact', description: 'Выполнить последовательность действий на странице и сделать финальный скриншот. Действия: click:<selector>, type:<selector>:<text>, wait:<ms>, reload, goto:<path>.',
    inputSchema: { type: 'object', properties: {
      task: { type: 'string' },
      path: { type: 'string', description: 'Стартовый путь, например "/puzzle-rush"' },
      name: { type: 'string', description: 'Имя финального скриншота' },
      actions: { type: 'array', items: { type: 'string' }, description: 'Массив действий, напр. ["click:button:has-text(\'Start\')", "wait:2000", "type:#input:hello"]' },
      viewport: { type: 'string', description: '"desktop" или "mobile"' },
    }, required: ['task', 'path', 'name', 'actions'] } },

  { name: 'record_gif', description: 'Записать GIF последовательности действий на странице через scripts/record-verification.js.',
    inputSchema: { type: 'object', properties: {
      task: { type: 'string' },
      path: { type: 'string' },
      name: { type: 'string', description: 'Имя GIF файла без расширения' },
      actions: { type: 'array', items: { type: 'string' } },
      viewport: { type: 'string' },
    }, required: ['task', 'path', 'name', 'actions'] } },

  { name: 'inspect', description: 'Открыть URL и вернуть текст body + список console errors и pageerror. Для диагностики белых страниц и JS-ошибок.',
    inputSchema: { type: 'object', properties: {
      path: { type: 'string', description: 'Относительный путь, например "/"' },
      waitFor: { type: 'number', description: 'Пауза в мс перед снятием состояния' },
    }, required: ['path'] } },
];

// Используем node:http вместо глобального fetch — у fetch (undici) в Node 20
// headersTimeout/bodyTimeout дефолтом 300с, длинные операции (deploy, npm build,
// docker_compose) дольше — fetch падает 'fetch failed', скрипт на хосте
// продолжает работать и отвечает в закрытый сокет ('Broken pipe' в webhook).
// http.request таких таймаутов не навязывает.
async function http(url, opts = {}) {
  const method = (opts.method || 'GET').toUpperCase();
  const u = new URL(url);
  const bodyStr = opts.body ? JSON.stringify(opts.body) : undefined;
  const headers = {
    'Content-Type': 'application/json',
    ...(opts.headers || {}),
  };
  if (bodyStr) headers['Content-Length'] = Buffer.byteLength(bodyStr);

  return new Promise((resolve) => {
    const req = nodeHttp.request({
      method,
      hostname: u.hostname,
      port: u.port || 80,
      path: u.pathname + u.search,
      headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let data;
        try { data = JSON.parse(text); } catch { data = text; }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          resolve({ error: `${res.statusCode}`, detail: data });
        } else {
          resolve(data);
        }
      });
      res.on('error', (e) => resolve({ error: 'response_error', detail: e.message }));
    });
    req.on('error', (e) => resolve({ error: 'request_error', detail: e.message }));
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function webhookPost(path, body) {
  return http(`${WEBHOOK}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}` },
    body,
  });
}

async function call(name, args) {
  switch (name) {
    // Tracker (no auth needed)
    case 'issue_get':
      return http(`${TRACKER}/api/issues/${args.key}`);
    case 'issue_search': {
      const qs = new URLSearchParams();
      for (const k of ['assignee', 'status', 'labels', 'search']) {
        if (args[k]) qs.set(k, args[k]);
      }
      return http(`${TRACKER}/api/issues${qs.toString() ? '?' + qs : ''}`);
    }
    case 'issue_create':
      return http(`${TRACKER}/api/issues`, {
        method: 'POST',
        body: { summary: args.summary, description: args.description || '', assignee: args.assignee || '', labels: args.labels || [] },
      });
    case 'issue_update': {
      const { key, ...rest } = args;
      return http(`${TRACKER}/api/issues/${key}`, { method: 'PATCH', body: rest });
    }
    case 'issue_transition':
      return http(`${TRACKER}/api/issues/${args.key}/transitions`, {
        method: 'POST', body: { id: args.id, actor: AGENT },
      });
    case 'issue_comments':
      return http(`${TRACKER}/api/issues/${args.key}/comments`);
    case 'comment_add':
      return http(`${TRACKER}/api/issues/${args.key}/comments`, {
        method: 'POST', body: { author: args.author || AGENT, body: args.body },
      });

    // Webhook (with auth + roles)
    case 'commit':
      return webhookPost('/commit', { message: args.message, files: args.files, agent: AGENT });
    case 'git_log':
      return webhookPost('/git-log', {
        mode: args.mode || 'log',
        since: args.since || '',
        limit: args.limit || 50,
        path: args.path || '',
        grep: args.grep || '',
        sha: args.sha || '',
      });
    case 'agent_message':
      if (typeof args.reply_required !== 'boolean') {
        return { error: 'reply_required is required and must be boolean (true | false)' };
      }
      return webhookPost('/agent/message', {
        from: AGENT,
        to: args.to,
        message: args.message,
        reply_required: args.reply_required,
      });
    case 'agent_kill':
      return webhookPost('/agent/kill', { agent: args.agent });
    case 'agent_status':
      return http(`${WEBHOOK}/health`);
    case 'agent_logs':
      return webhookPost('/agent/logs', { agent: args.agent, limit: args.limit || 30 });
    case 'telegram_send':
      return webhookPost('/telegram/send', { message: args.message });
    case 'deploy':
      return webhookPost('/deploy', { scope: args.scope || '' });
    case 'npm_install':
      return webhookPost('/npm-install', {});
    case 'api_start':
      return webhookPost('/api-start', { force: !!args.force });
    case 'vite_start':
      return webhookPost('/vite-start', {});
    case 'docker_compose':
      return webhookPost('/docker-compose', { command: args.command, args: args.args || [] });
    case 'npm_run':
      return webhookPost('/npm-run', { script: args.script, workspace: args.workspace || '' });

    case 'screenshot': {
      if (!args.task || !args.path || !args.name) return { error: 'task, path, name required' };
      const outputDir = `/tmp/${args.task}`;
      const output = `${outputDir}/${args.name}.png`;
      const sep = args.path.includes('?') ? '&' : '?';
      const url = `http://localhost:5173${args.path}${sep}dev_bypass=${DEV_BYPASS}`;
      const viewport = args.viewport === 'mobile' ? '390,844' : '1280,720';
      const cliArgs = ['screenshot', '--viewport-size', viewport];
      if (args.waitFor) cliArgs.push('--wait-for-timeout', String(args.waitFor));
      cliArgs.push(url, output);
      await new Promise((resolve) => {
        const mk = spawn('mkdir', ['-p', outputDir]);
        mk.on('close', resolve);
      });
      return new Promise((resolve) => {
        const proc = spawn('/project/node_modules/.bin/playwright', cliArgs);
        let stderr = '';
        proc.stderr.on('data', (d) => { stderr += d.toString(); });
        proc.on('close', (code) => {
          if (code === 0) resolve({ status: 'ok', output });
          else resolve({ error: `playwright exit ${code}`, stderr: stderr.slice(-500) });
        });
        proc.on('error', (e) => resolve({ error: e.message }));
      });
    }

    case 'interact': {
      if (!args.task || !args.path || !args.name || !args.actions) return { error: 'task, path, name, actions required' };
      const { chromium } = await import('/project/node_modules/playwright/index.mjs');
      const outputDir = `/tmp/${args.task}`;
      const output = `${outputDir}/${args.name}.png`;
      const sep = args.path.includes('?') ? '&' : '?';
      const url = `http://localhost:5173${args.path}${sep}dev_bypass=${DEV_BYPASS}`;
      const [w, h] = args.viewport === 'mobile' ? [390, 844] : [1280, 720];
      await new Promise((r) => spawn('mkdir', ['-p', outputDir]).on('close', r));
      const browser = await chromium.launch();
      const page = await browser.newPage({ viewport: { width: w, height: h } });
      const log = [];
      try {
        await page.goto(url);
        for (const a of args.actions) {
          const [type, ...rest] = a.split(':');
          const arg = rest.join(':');
          if (type === 'click') await page.click(arg, { timeout: 10000 });
          else if (type === 'wait') await page.waitForTimeout(parseInt(arg, 10));
          else if (type === 'type') {
            const [sel, ...text] = arg.split(':');
            await page.fill(sel, text.join(':'));
          }
          else if (type === 'reload') await page.reload();
          else if (type === 'goto') await page.goto(`http://localhost:5173${arg}${arg.includes('?') ? '&' : '?'}dev_bypass=${DEV_BYPASS}`);
          else throw new Error(`Unknown action: ${type}`);
          log.push(`ok: ${a}`);
        }
        await page.screenshot({ path: output });
        return { status: 'ok', output, log };
      } catch (e) {
        return { error: e.message, log };
      } finally {
        await browser.close();
      }
    }

    case 'record_gif': {
      if (!args.task || !args.path || !args.name || !args.actions) return { error: 'task, path, name, actions required' };
      const outputDir = `/tmp/${args.task}`;
      const output = `${outputDir}/${args.name}.gif`;
      const sep = args.path.includes('?') ? '&' : '?';
      const url = `http://localhost:5173${args.path}${sep}dev_bypass=${DEV_BYPASS}`;
      const viewport = args.viewport === 'mobile' ? '390x844' : '1280x720';
      await new Promise((r) => spawn('mkdir', ['-p', outputDir]).on('close', r));
      const cliArgs = ['/project/scripts/record-verification.js', '--url', url, '--output', output, '--viewport', viewport, '--actions', ...args.actions];
      return new Promise((resolve) => {
        const proc = spawn('node', cliArgs);
        let stderr = '';
        proc.stderr.on('data', (d) => { stderr += d.toString(); });
        proc.on('close', (code) => {
          if (code === 0) resolve({ status: 'ok', output });
          else resolve({ error: `record exit ${code}`, stderr: stderr.slice(-500) });
        });
        proc.on('error', (e) => resolve({ error: e.message }));
      });
    }

    case 'inspect': {
      if (!args.path) return { error: 'path required' };
      const { chromium } = await import('/project/node_modules/playwright/index.mjs');
      const sep = args.path.includes('?') ? '&' : '?';
      const url = `http://localhost:5173${args.path}${sep}dev_bypass=${DEV_BYPASS}`;
      const browser = await chromium.launch();
      const page = await browser.newPage();
      const consoleMsgs = [];
      const errors = [];
      page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') consoleMsgs.push(`${m.type()}: ${m.text()}`); });
      page.on('pageerror', (e) => { errors.push(e.message); });
      try {
        await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
        if (args.waitFor) await page.waitForTimeout(args.waitFor);
        const body = await page.evaluate(() => document.body ? document.body.innerText.slice(0, 2000) : '');
        return { status: 'ok', body, consoleMsgs, errors };
      } catch (e) {
        return { error: e.message, consoleMsgs, errors };
      } finally {
        await browser.close();
      }
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

function send(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }

const rl = createInterface({ input: process.stdin, terminal: false });

rl.on('line', async (line) => {
  let req;
  try { req = JSON.parse(line); } catch { return; }
  const { id, method, params } = req;

  if (method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'kingside-agent-mcp', version: '1.0.0' } } });
    return;
  }
  if (method === 'notifications/initialized') return;
  if (method === 'tools/list') { send({ jsonrpc: '2.0', id, result: { tools: TOOLS } }); return; }
  if (method === 'tools/call') {
    const name = params?.name;
    const args = params?.arguments || {};
    try {
      const result = await call(name, args);
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] } });
    } catch (e) {
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true } });
    }
    return;
  }
  if (id !== undefined) { send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } }); }
});

rl.on('close', () => process.exit(0));
