// k6/helpers.js — shared helpers for auth, WebSocket, etc.

import http from 'k6/http';
import { check } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import { BASE_URL, TEST_USER_PASSWORD, TEST_USER_PREFIX } from './config.js';

// Custom metrics
export const authErrors = new Counter('auth_errors');
export const wsConnectTime = new Trend('ws_connect_time', true);
export const gameMoveDuration = new Trend('game_move_duration', true);

/**
 * Register a test user. Ignores 409 (already exists).
 */
export function registerUser(vuId) {
  const payload = JSON.stringify({
    username: `${TEST_USER_PREFIX}${vuId}`,
    email: `${TEST_USER_PREFIX}${vuId}@loadtest.local`,
    password: TEST_USER_PASSWORD,
  });

  const res = http.post(`${BASE_URL}/auth/register`, payload, {
    headers: { 'Content-Type': 'application/json' },
    tags: { name: 'auth_register' },
  });

  if (res.status !== 201 && res.status !== 409) {
    authErrors.add(1);
  }

  return res;
}

/**
 * Login and return { accessToken, refreshToken }.
 */
export function login(vuId) {
  const payload = JSON.stringify({
    username: `${TEST_USER_PREFIX}${vuId}`,
    password: TEST_USER_PASSWORD,
  });

  const res = http.post(`${BASE_URL}/auth/login`, payload, {
    headers: { 'Content-Type': 'application/json' },
    tags: { name: 'auth_login' },
  });

  const ok = check(res, {
    'login status 200/201': (r) => r.status === 200 || r.status === 201,
  });

  if (!ok) {
    authErrors.add(1);
    return null;
  }

  try {
    return JSON.parse(res.body);
  } catch {
    return null;
  }
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

/**
 * Ensure test user exists: register (ignore 409) then login.
 */
export function ensureUser(vuId) {
  registerUser(vuId);
  return login(vuId);
}
