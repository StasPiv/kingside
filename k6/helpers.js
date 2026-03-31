// k6/helpers.js — shared helpers for auth, WebSocket, etc.
//
// Auth strategy: tokens are obtained ONCE during setup() via dev-bypass
// and reused across all iterations — no bcrypt on hot path.

import http from 'k6/http';
import { check } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import { SharedArray } from 'k6/data';
import { BASE_URL, TEST_USER_PREFIX } from './config.js';

// Custom metrics
export const authErrors = new Counter('auth_errors');
export const wsConnectTime = new Trend('ws_connect_time', true);
export const gameMoveDuration = new Trend('game_move_duration', true);

// Pre-loaded tokens from seed-users.sh output (if available)
let preloadedTokens = null;
try {
  preloadedTokens = new SharedArray('tokens', function () {
    return JSON.parse(open('./tokens.json'));
  });
} catch {
  // tokens.json not found — will use dev-bypass at setup time
}

/**
 * Call in setup() to obtain tokens for all VUs.
 * Returns array of { vuId, accessToken }.
 *
 * If tokens.json exists (from seed-users.sh), returns it directly.
 * Otherwise, calls dev-bypass for each VU on the fly.
 */
export function setupTokens(maxVUs) {
  if (preloadedTokens && preloadedTokens.length >= maxVUs) {
    return preloadedTokens;
  }

  // Fallback: generate tokens via dev-bypass during setup
  const secret = __ENV.DEV_BYPASS_SECRET || 'dev-secret';
  const tokens = [];

  for (let i = 1; i <= maxVUs; i++) {
    const username = `${TEST_USER_PREFIX}${i}`;
    const res = http.post(`${BASE_URL}/auth/dev-bypass`,
      JSON.stringify({ secret, user: username }),
      { headers: { 'Content-Type': 'application/json' }, tags: { name: 'setup_auth' } },
    );

    if (res.status === 200 || res.status === 201) {
      try {
        const body = JSON.parse(res.body);
        tokens.push({ vuId: i, username, accessToken: body.accessToken });
      } catch {
        authErrors.add(1);
      }
    } else {
      authErrors.add(1);
    }
  }

  return tokens;
}

/**
 * Get token for current VU from setup data.
 * @param {Array} tokens — array returned by setupTokens()
 * @returns {{ accessToken: string, username: string } | null}
 */
export function getVUToken(tokens) {
  if (!tokens || tokens.length === 0) return null;
  // Map VU id to token index (VU ids start at 1)
  const idx = ((__VU - 1) % tokens.length);
  return tokens[idx] || null;
}

/**
 * Return common auth headers for REST requests.
 */
export function authHeaders(accessToken) {
  return {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
  };
}
