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
    description: "Get the current user's saved game analyses. Returns list with id, title, pgn preview, date.",
    inputSchema: { type: 'object', properties: { limit: { type: 'number', description: 'Max results (default 10, max 20)' } } },
  },
  {
    name: 'get_game_details',
    description: 'Get detailed info about a specific game by ID. Returns players, result, time control, PGN preview.',
    inputSchema: { type: 'object', properties: { gameId: { type: 'string', description: 'Game UUID' } }, required: ['gameId'] },
  },
  {
    name: 'get_user_tournaments',
    description: "Get tournaments the current user participated in or created.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'search_games',
    description: "Search the current user's finished games with optional filters.",
    inputSchema: {
      type: 'object',
      properties: {
        timeControlType: { type: 'string', description: 'Filter: bullet, blitz, rapid, classical' },
        result: { type: 'string', description: 'Filter: white, black, draw' },
        opponent: { type: 'string', description: 'Filter by opponent username' },
        limit: { type: 'number', description: 'Max results (default 10, max 20)' },
      },
    },
  },
  {
    name: 'get_puzzle_stats_by_theme',
    description: "Get the current user's puzzle solving stats broken down by theme (fork, pin, mate, etc).",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_user_profile',
    description: "Get the current user's full profile: ratings, games played, streak, settings.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_player_profile',
    description: "Get any player's public profile by username.",
    inputSchema: { type: 'object', properties: { username: { type: 'string', description: 'Player username' } }, required: ['username'] },
  },
  {
    name: 'get_friends',
    description: "Get the current user's friends list with online/offline status.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_online_players',
    description: 'Get currently online players.',
    inputSchema: { type: 'object', properties: { limit: { type: 'number', description: 'Max results (default 10)' } } },
  },
  {
    name: 'get_daily_puzzle',
    description: "Get today's daily puzzle — id, FEN, rating, themes.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_puzzle_rush_leaderboard',
    description: 'Get Puzzle Rush leaderboard — top scores.',
    inputSchema: { type: 'object', properties: { limit: { type: 'number', description: 'Max results (default 10)' } } },
  },
  {
    name: 'get_puzzle_rating_history',
    description: "Get the current user's puzzle rating history over time.",
    inputSchema: { type: 'object', properties: { days: { type: 'number', description: 'Days (default 30, max 365)' } } },
  },
  {
    name: 'get_broadcasts',
    description: 'Get list of chess event broadcasts (FIDE, etc).',
    inputSchema: { type: 'object', properties: { limit: { type: 'number', description: 'Max results (default 10)' } } },
  },
  {
    name: 'get_workshop_files',
    description: "Get the current user's PGN files from Workshop.",
    inputSchema: { type: 'object', properties: { limit: { type: 'number', description: 'Max results (default 10)' } } },
  },
  {
    name: 'get_feedback_list',
    description: 'Get community feedback posts. Can filter by type and status.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'Filter: bug, suggestion, question' },
        status: { type: 'string', description: 'Filter: new, in_progress, resolved, closed' },
        sort: { type: 'string', description: 'Sort: newest or popular' },
        limit: { type: 'number', description: 'Max results (default 10)' },
      },
    },
  },
  {
    name: 'get_user_settings',
    description: "Get the current user's settings: language, board theme, piece set, linked accounts.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_game_history',
    description: "Get the current user's full game history with pagination.",
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max results (default 10, max 20)' },
        offset: { type: 'number', description: 'Skip first N games (default 0)' },
      },
    },
  },
  {
    name: 'get_active_games',
    description: "Get the current user's active (in-progress) games.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'navigate',
    description: 'Suggest the user navigate to a specific page on the site.',
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
    Object.entries(args || {}).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)])
  )});
  const url = `${API_URL}/internal/tools/${name}?${params}`;
  const res = await fetch(url, { headers: { 'X-Admin-Key': API_KEY } });
  if (!res.ok) {
    const text = await res.text();
    return { error: `API returned ${res.status}: ${text}` };
  }
  return res.json();
}

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

const rl = createInterface({ input: process.stdin, terminal: false });

rl.on('line', async (line) => {
  let req;
  try { req = JSON.parse(line); } catch { return; }
  const { id, method, params } = req;

  if (method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'kingside-mcp', version: '1.0.0' },
    }});
    return;
  }
  if (method === 'notifications/initialized') return;
  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    return;
  }
  if (method === 'tools/call') {
    const toolName = params?.name;
    const toolArgs = params?.arguments || {};
    if (toolName === 'navigate') {
      send({ jsonrpc: '2.0', id, result: {
        content: [{ type: 'text', text: JSON.stringify({ action: 'navigate', url: toolArgs.url, description: toolArgs.description }) }],
      }});
      return;
    }
    try {
      const result = await callTool(toolName, toolArgs);
      send({ jsonrpc: '2.0', id, result: {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      }});
    } catch (e) {
      send({ jsonrpc: '2.0', id, result: {
        content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true,
      }});
    }
    return;
  }
  if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
});

rl.on('close', () => process.exit(0));
