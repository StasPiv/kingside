#!/usr/bin/env node
/**
 * MCP Server для агентов Kingside — обёртка над HTTP endpoints
 * трекера (localhost:8090) и webhook-сервера (localhost:9876).
 *
 * Env: WEBHOOK_AUTH_TOKEN, AGENT_NAME (имя текущего агента, для from в message)
 */

import { createInterface } from 'readline';

const TOKEN = process.env.WEBHOOK_AUTH_TOKEN || '';
const AGENT = process.env.AGENT_NAME || '';
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
  { name: 'issue_transition', description: 'Сменить статус задачи. 11=To Do, 21=In Progress, 41=Done.',
    inputSchema: { type: 'object', properties: { key: { type: 'string' }, id: { type: 'number' } }, required: ['key', 'id'] } },
  { name: 'issue_comments', description: 'Получить список комментариев задачи.',
    inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] } },
  { name: 'comment_add', description: 'Добавить комментарий к задаче.',
    inputSchema: { type: 'object', properties: { key: { type: 'string' }, body: { type: 'string' }, author: { type: 'string', description: 'Автор, по умолчанию AGENT_NAME' } }, required: ['key', 'body'] } },

  // --- Webhook ---
  { name: 'commit', description: 'Коммит изменённых файлов в main (требует роль).',
    inputSchema: { type: 'object', properties: { message: { type: 'string' }, files: { type: 'array', items: { type: 'string' } } }, required: ['message', 'files'] } },
  { name: 'agent_message', description: 'Прямое сообщение другому агенту.',
    inputSchema: { type: 'object', properties: { to: { type: 'string' }, message: { type: 'string' }, force: { type: 'boolean', description: 'Обходит lock (только после agent_kill)' } }, required: ['to', 'message'] } },
  { name: 'agent_kill', description: 'Убить daemon-процесс агента (координатор).',
    inputSchema: { type: 'object', properties: { agent: { type: 'string' } }, required: ['agent'] } },
  { name: 'telegram_send', description: 'Отправить сообщение пользователю в Telegram.',
    inputSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] } },
  { name: 'deploy', description: 'Запустить деплой на AWS. scope: frontend | api | workers | all | "" (auto).',
    inputSchema: { type: 'object', properties: { scope: { type: 'string' } } } },
  { name: 'npm_install', description: 'Запустить npm install на хосте (после изменения package.json).',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'api_start', description: 'Запустить API на хосте если не запущен.',
    inputSchema: { type: 'object', properties: {} } },
];

async function http(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) return { error: `${res.status}`, detail: data };
  return data;
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
        method: 'POST', body: { id: args.id },
      });
    case 'issue_comments':
      return http(`${TRACKER}/api/issues/${args.key}/comments`);
    case 'comment_add':
      return http(`${TRACKER}/api/issues/${args.key}/comments`, {
        method: 'POST', body: { author: args.author || AGENT, body: args.body },
      });

    // Webhook (with auth + roles)
    case 'commit':
      return webhookPost('/commit', { message: args.message, files: args.files });
    case 'agent_message':
      return webhookPost('/agent/message', { from: AGENT, to: args.to, message: args.message, force: !!args.force });
    case 'agent_kill':
      return webhookPost('/agent/kill', { agent: args.agent });
    case 'telegram_send':
      return webhookPost('/telegram/send', { message: args.message });
    case 'deploy':
      return webhookPost('/deploy', { scope: args.scope || '' });
    case 'npm_install':
      return webhookPost('/npm-install', {});
    case 'api_start':
      return webhookPost('/api-start', {});
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
