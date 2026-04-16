#!/usr/bin/env node
/**
 * MCP Server for Kingside AI Chat.
 * Communicates with Claude CLI over stdio (JSON-RPC).
 * Makes HTTP requests to Kingside API internal endpoints.
 *
 * Env: KINGSIDE_USER_ID, KINGSIDE_API_URL, KINGSIDE_API_KEY
 */

import { createInterface } from 'readline';

const USER_ID = process.env.KINGSIDE_USER_ID || '';
const API_URL = process.env.KINGSIDE_API_URL || 'http://localhost:3001/api';
const API_KEY = process.env.KINGSIDE_API_KEY || '';

const TOOLS = [
  {
    name: 'get_user_analyses',
    description: 'Get the current user\'s saved game analyses. Returns list with id, title, pgn preview, date.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max results (default 10, max 20)' },
      },
    },
  },
  {
    name: 'get_game_details',
    description: 'Get detailed info about a specific game by ID. Returns players, result, time control, PGN preview.',
    inputSchema: {
      type: 'object',
      properties: {
        gameId: { type: 'string', description: 'Game UUID' },
      },
      required: ['gameId'],
    },
  },
  {
    name: 'get_user_tournaments',
    description: 'Get tournaments the current user participated in or created. Returns name, status, scores.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'search_games',
    description: 'Search the current user\'s finished games with optional filters.',
    inputSchema: {
      type: 'object',
      properties: {
        timeControlType: { type: 'string', description: 'Filter: bullet, blitz, rapid, classical' },
        result: { type: 'string', description: 'Filter: white, black, draw' },
        limit: { type: 'number', description: 'Max results (default 10, max 20)' },
      },
    },
  },
  {
    name: 'get_puzzle_stats_by_theme',
    description: 'Get the current user\'s puzzle solving statistics broken down by theme (fork, pin, mate, etc).',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'navigate',
    description: 'Suggest the user navigate to a specific page on the site. Use this when you want to direct the user somewhere.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Relative URL path, e.g. /analysis or /puzzles' },
        description: { type: 'string', description: 'Why navigate there' },
      },
      required: ['url'],
    },
  },
];

async function callTool(name, args) {
  const params = new URLSearchParams({ userId: USER_ID, ...Object.fromEntries(
    Object.entries(args || {}).map(([k, v]) => [k, String(v)])
  )});
  const url = `${API_URL}/internal/tools/${name}?${params}`;
  const res = await fetch(url, {
    headers: { 'X-Admin-Key': API_KEY },
  });
  if (!res.ok) {
    const text = await res.text();
    return { error: `API returned ${res.status}: ${text}` };
  }
  return res.json();
}

function sendResponse(id, result) {
  const msg = JSON.stringify({ jsonrpc: '2.0', id, result });
  process.stdout.write(msg + '\n');
}

function sendError(id, code, message) {
  const msg = JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
  process.stdout.write(msg + '\n');
}

function sendNotification(method, params) {
  const msg = JSON.stringify({ jsonrpc: '2.0', method, params });
  process.stdout.write(msg + '\n');
}

const rl = createInterface({ input: process.stdin, terminal: false });

rl.on('line', async (line) => {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }

  const { id, method, params } = req;

  if (method === 'initialize') {
    sendResponse(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'kingside-mcp', version: '1.0.0' },
    });
    return;
  }

  if (method === 'notifications/initialized') {
    // Client acknowledged initialization — no response needed
    return;
  }

  if (method === 'tools/list') {
    sendResponse(id, { tools: TOOLS });
    return;
  }

  if (method === 'tools/call') {
    const toolName = params?.name;
    const toolArgs = params?.arguments || {};

    if (toolName === 'navigate') {
      sendResponse(id, {
        content: [{ type: 'text', text: JSON.stringify({ action: 'navigate', url: toolArgs.url, description: toolArgs.description }) }],
      });
      return;
    }

    try {
      const result = await callTool(toolName, toolArgs);
      sendResponse(id, {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      });
    } catch (e) {
      sendResponse(id, {
        content: [{ type: 'text', text: `Error: ${e.message}` }],
        isError: true,
      });
    }
    return;
  }

  if (id !== undefined) {
    sendError(id, -32601, `Method not found: ${method}`);
  }
});

rl.on('close', () => process.exit(0));
