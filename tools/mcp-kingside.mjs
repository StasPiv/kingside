#!/usr/bin/env node
/**
 * MCP Server for Kingside AI Chat.
 * Calls existing public API endpoints using user JWT.
 *
 * Env: KINGSIDE_USER_TOKEN (JWT), KINGSIDE_USER_ID, KINGSIDE_API_URL
 */

import { createInterface } from 'readline';

const USER_TOKEN = process.env.KINGSIDE_USER_TOKEN || '';
const USER_ID = process.env.KINGSIDE_USER_ID || '';
const API = process.env.KINGSIDE_API_URL || 'http://localhost:3001/api';

const TOOLS = [
  { name: 'get_user_analyses', description: "Get the user's saved game analyses.", inputSchema: { type: 'object', properties: { limit: { type: 'number' } } } },
  { name: 'get_game_details', description: 'Get details of a specific game by ID.', inputSchema: { type: 'object', properties: { gameId: { type: 'string' } }, required: ['gameId'] } },
  { name: 'get_user_tournaments', description: "Get user's tournaments (created or joined).", inputSchema: { type: 'object', properties: {} } },
  { name: 'search_games', description: "Search user's finished games.", inputSchema: { type: 'object', properties: { timeControlType: { type: 'string' }, result: { type: 'string' }, limit: { type: 'number' } } } },
  { name: 'get_puzzle_stats_by_theme', description: "User's puzzle stats by theme.", inputSchema: { type: 'object', properties: {} } },
  { name: 'get_user_profile', description: "Get user's full profile and ratings.", inputSchema: { type: 'object', properties: {} } },
  { name: 'get_player_profile', description: "Get any player's profile by username.", inputSchema: { type: 'object', properties: { username: { type: 'string' } }, required: ['username'] } },
  { name: 'get_friends', description: "Get user's friends with online status.", inputSchema: { type: 'object', properties: {} } },
  { name: 'get_online_players', description: 'Get currently online players.', inputSchema: { type: 'object', properties: { limit: { type: 'number' } } } },
  { name: 'get_daily_puzzle', description: "Today's daily puzzle.", inputSchema: { type: 'object', properties: {} } },
  { name: 'get_puzzle_rush_leaderboard', description: 'Puzzle Rush top scores.', inputSchema: { type: 'object', properties: { limit: { type: 'number' } } } },
  { name: 'get_puzzle_rating_history', description: "User's puzzle rating over time.", inputSchema: { type: 'object', properties: { days: { type: 'number' } } } },
  { name: 'get_broadcasts', description: 'Chess event broadcasts.', inputSchema: { type: 'object', properties: { limit: { type: 'number' } } } },
  { name: 'get_workshop_files', description: "User's PGN files from Workshop.", inputSchema: { type: 'object', properties: { limit: { type: 'number' } } } },
  { name: 'get_feedback_list', description: 'Community feedback posts.', inputSchema: { type: 'object', properties: { type: { type: 'string' }, status: { type: 'string' }, sort: { type: 'string' }, limit: { type: 'number' } } } },
  { name: 'get_user_settings', description: "User's settings (language, board theme, etc).", inputSchema: { type: 'object', properties: {} } },
  { name: 'get_game_history', description: "User's game history with pagination.", inputSchema: { type: 'object', properties: { limit: { type: 'number' }, offset: { type: 'number' } } } },
  { name: 'get_active_games', description: "User's active (in-progress) games.", inputSchema: { type: 'object', properties: {} } },
  { name: 'navigate', description: 'Suggest user navigate to a page.', inputSchema: { type: 'object', properties: { url: { type: 'string' }, description: { type: 'string' } }, required: ['url'] } },
];

function qs(params) {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) { if (v != null) s.set(k, String(v)); }
  const r = s.toString();
  return r ? `?${r}` : '';
}

function buildUrl(tool, args) {
  switch (tool) {
    case 'get_user_analyses':     return `${API}/analyses${qs({ limit: args.limit })}`;
    case 'get_game_details':      return `${API}/games/${args.gameId}`;
    case 'get_user_tournaments':  return `${API}/arena/my`;
    case 'search_games':          return `${API}/users/${USER_ID}/games${qs({ timeControlType: args.timeControlType, result: args.result, limit: args.limit })}`;
    case 'get_puzzle_stats_by_theme': return `${API}/puzzles/stats/themes`;
    case 'get_user_profile':      return `${API}/auth/me`;
    case 'get_player_profile':    return `${API}/players/${encodeURIComponent(args.username)}`;
    case 'get_friends':           return `${API}/friends`;
    case 'get_online_players':    return `${API}/players/online${qs({ limit: args.limit })}`;
    case 'get_daily_puzzle':      return `${API}/puzzles/daily`;
    case 'get_puzzle_rush_leaderboard': return `${API}/puzzle-rush/leaderboard${qs({ limit: args.limit })}`;
    case 'get_puzzle_rating_history':   return `${API}/puzzles/stats/rating-history${qs({ days: args.days })}`;
    case 'get_broadcasts':        return `${API}/broadcasts${qs({ limit: args.limit })}`;
    case 'get_workshop_files':    return `${API}/workshop/pgn-files${qs({ limit: args.limit })}`;
    case 'get_feedback_list':     return `${API}/feedback${qs({ type: args.type, status: args.status, sort: args.sort, limit: args.limit })}`;
    case 'get_user_settings':     return `${API}/users/me/settings`;
    case 'get_game_history':      return `${API}/users/${USER_ID}/games${qs({ limit: args.limit, offset: args.offset })}`;
    case 'get_active_games':      return `${API}/games/active`;
    default: return null;
  }
}

async function callApi(url) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${USER_TOKEN}` } });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { error: `${res.status}: ${text.slice(0, 200)}` };
  }
  return res.json();
}

function send(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }

const rl = createInterface({ input: process.stdin, terminal: false });

rl.on('line', async (line) => {
  let req;
  try { req = JSON.parse(line); } catch { return; }
  const { id, method, params } = req;

  if (method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'kingside-mcp', version: '2.0.0' } } });
    return;
  }
  if (method === 'notifications/initialized') return;
  if (method === 'tools/list') { send({ jsonrpc: '2.0', id, result: { tools: TOOLS } }); return; }
  if (method === 'tools/call') {
    const name = params?.name;
    const args = params?.arguments || {};
    if (name === 'navigate') {
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify({ action: 'navigate', url: args.url, description: args.description }) }] } });
      return;
    }
    const url = buildUrl(name, args);
    if (!url) { send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true } }); return; }
    try {
      const result = await callApi(url);
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] } });
    } catch (e) {
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true } });
    }
    return;
  }
  if (id !== undefined) { send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } }); }
});

rl.on('close', () => process.exit(0));
