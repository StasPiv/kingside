#!/usr/bin/env node
/**
 * MCP Server for Kingside AI Chat (динамический, ADR-061 §10).
 *
 * Тянет каталог инструментов с GET /_mcp/tools, регистрирует их в
 * Claude CLI и проксирует вызовы в публичный API под JWT юзера.
 * Новые эндпоинты, помеченные `@McpTool`, появляются автоматически
 * (кэш обновляется каждые 10 минут, по ETag).
 *
 * Env:
 *   KINGSIDE_USER_TOKEN — JWT пользователя (для auth: user/optional).
 *   KINGSIDE_USER_ID    — sub юзера (вспомогательно, для логов).
 *   KINGSIDE_API_URL    — база API (https://api.kingside.site в prod).
 *   MCP_DISCOVERY_KEY   — заголовок X-Mcp-Discovery-Key (в dev можно пусто).
 */

import { createInterface } from 'readline';

const USER_TOKEN = process.env.KINGSIDE_USER_TOKEN || '';
const USER_ID = process.env.KINGSIDE_USER_ID || '';
const API = (process.env.KINGSIDE_API_URL || 'http://localhost:3001').replace(/\/$/, '');
const DISCOVERY_KEY = process.env.MCP_DISCOVERY_KEY || '';

const SUPPORTED_SCHEMA_VERSION = 1;
const CATALOG_REFRESH_MS = 10 * 60 * 1000;

let catalog = null;
let catalogEtag = null;
let lastFetch = 0;

function logErr(msg) { process.stderr.write(`[mcp-kingside] ${msg}\n`); }

async function fetchCatalog() {
  const headers = {};
  if (DISCOVERY_KEY) headers['X-Mcp-Discovery-Key'] = DISCOVERY_KEY;
  if (catalogEtag) headers['If-None-Match'] = catalogEtag;
  const res = await fetch(`${API}/_mcp/tools`, { headers });
  if (res.status === 304 && catalog) {
    lastFetch = Date.now();
    return catalog;
  }
  if (!res.ok) {
    throw new Error(`GET /_mcp/tools → ${res.status}`);
  }
  const etag = res.headers.get('etag');
  if (etag) catalogEtag = etag;
  const data = await res.json();
  if (data.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported schemaVersion ${data.schemaVersion}, expected ${SUPPORTED_SCHEMA_VERSION}`,
    );
  }
  catalog = data;
  lastFetch = Date.now();
  return catalog;
}

async function getCatalog() {
  if (!catalog || Date.now() - lastFetch > CATALOG_REFRESH_MS) {
    return await fetchCatalog();
  }
  return catalog;
}

function buildMcpTools(cat) {
  // Анонимные сессии (без JWT) не видят auth='user' инструменты.
  return cat.tools
    .filter((t) => USER_TOKEN || t.auth !== 'user')
    .map((t) => ({
      name: t.name,
      description: t.description || `${t.method} ${t.path}`,
      inputSchema: t.input || { type: 'object', properties: {} },
    }));
}

function applyDefaults(args, defaults) {
  if (!defaults) return args;
  const out = { ...args };
  for (const [k, v] of Object.entries(defaults)) {
    if (out[k] == null) out[k] = v;
  }
  return out;
}

function applyLimits(args, limits) {
  if (!limits) return args;
  const out = { ...args };
  if (typeof limits.maxLimit === 'number' && typeof out.limit === 'number') {
    out.limit = Math.min(out.limit, limits.maxLimit);
  }
  return out;
}

// excludeFields: ["pgn", "items[].pgn", "items[].fen"] → удаляем из ответа.
function deleteByPath(node, parts) {
  if (node == null) return;
  const [head, ...rest] = parts;
  if (!head) return;
  const arr = head.match(/^(\w+)\[\]$/);
  if (arr) {
    const list = node[arr[1]];
    if (Array.isArray(list)) {
      for (const item of list) deleteByPath(item, rest);
    }
    return;
  }
  if (rest.length === 0) {
    if (typeof node === 'object') delete node[head];
    return;
  }
  deleteByPath(node?.[head], rest);
}

function applyExcludeFields(data, paths) {
  if (!paths || !paths.length) return data;
  for (const p of paths) deleteByPath(data, p.split('.'));
  return data;
}

function substitutePathParams(path, args) {
  const used = new Set();
  const out = path.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_, name) => {
    if (args[name] == null) {
      throw new Error(`Missing path parameter "${name}" for ${path}`);
    }
    used.add(name);
    return encodeURIComponent(String(args[name]));
  });
  return { path: out, used };
}

function buildRequest(tool, args) {
  const method = (tool.method || 'GET').toUpperCase();
  const { path: substPath, used } = substitutePathParams(tool.path, args);
  const hasBody = ['POST', 'PUT', 'PATCH'].includes(method);
  const query = new URLSearchParams();
  let body = null;
  for (const [k, v] of Object.entries(args)) {
    if (used.has(k) || v == null) continue;
    if (hasBody) {
      body = body || {};
      body[k] = v;
    } else {
      query.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    }
  }
  const qs = query.toString();
  const url = `${API}${substPath}${qs ? '?' + qs : ''}`;
  return { url, method, body };
}

async function callTool(tool, rawArgs) {
  const args = applyLimits(applyDefaults(rawArgs, tool.defaults), tool.limits);
  const { url, method, body } = buildRequest(tool, args);
  const headers = {};
  if ((tool.auth === 'user' || tool.auth === 'optional') && USER_TOKEN) {
    headers['Authorization'] = `Bearer ${USER_TOKEN}`;
  }
  const init = { method, headers };
  if (body) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { error: `${res.status}: ${text.slice(0, 300)}` };
  }
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('json')) {
    const text = await res.text();
    return { raw: text.slice(0, 2000) };
  }
  let data;
  try {
    data = await res.json();
  } catch {
    return { error: 'invalid json response' };
  }
  return applyExcludeFields(data, tool.excludeFields);
}

function send(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }

const rl = createInterface({ input: process.stdin, terminal: false });

rl.on('line', async (line) => {
  let req;
  try { req = JSON.parse(line); } catch { return; }
  const { id, method, params } = req;

  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'kingside-mcp', version: '3.0.0' },
      },
    });
    return;
  }
  if (method === 'notifications/initialized') return;

  if (method === 'tools/list') {
    try {
      const cat = await getCatalog();
      send({ jsonrpc: '2.0', id, result: { tools: buildMcpTools(cat) } });
    } catch (e) {
      logErr(`tools/list failed: ${e.message}`);
      send({
        jsonrpc: '2.0',
        id,
        error: { code: -32000, message: `Discovery failed: ${e.message}` },
      });
    }
    return;
  }

  if (method === 'tools/call') {
    const name = params?.name;
    const args = params?.arguments || {};
    try {
      const cat = await getCatalog();
      const tool = cat.tools.find((t) => t.name === name);
      if (!tool) {
        send({
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true },
        });
        return;
      }
      if (tool.auth === 'user' && !USER_TOKEN) {
        send({
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: `Tool "${name}" requires user JWT, but none provided.` }],
            isError: true,
          },
        });
        return;
      }
      const result = await callTool(tool, args);
      send({
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] },
      });
    } catch (e) {
      logErr(`tools/call ${name} failed: ${e.message}`);
      send({
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true },
      });
    }
    return;
  }

  if (id !== undefined) {
    send({
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    });
  }
});

rl.on('close', () => process.exit(0));
