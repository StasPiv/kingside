// k6/01-auth-rest.js — Auth + REST baseline
// Tests: register, login, profile, puzzles, leaderboard
//
// Usage:
//   k6 run k6/01-auth-rest.js                          # smoke (default)
//   k6 run -e PROFILE=load k6/01-auth-rest.js          # load
//   k6 run -e PROFILE=stress k6/01-auth-rest.js        # stress
//   k6 run -e BASE_URL=https://kingside.site/api k6/01-auth-rest.js

import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Trend } from 'k6/metrics';
import { BASE_URL, profiles } from './config.js';
import { ensureUser, authHeaders } from './helpers.js';

const profile = profiles[__ENV.PROFILE || 'smoke'];

export const options = {
  scenarios: {
    auth_rest: {
      executor: profile.stages ? 'ramping-vus' : 'constant-vus',
      ...(profile.stages ? { stages: profile.stages } : { vus: profile.vus, duration: profile.duration }),
    },
  },
  thresholds: {
    ...profile.thresholds,
    'http_req_duration{name:auth_login}': ['p(95)<1000'],
    'http_req_duration{name:get_profile}': ['p(95)<500'],
    'http_req_duration{name:get_puzzles}': ['p(95)<1000'],
  },
};

const puzzleDuration = new Trend('puzzle_fetch_duration', true);

export default function () {
  const vuId = __VU;

  group('Auth flow', () => {
    const tokens = ensureUser(vuId);
    if (!tokens) {
      sleep(1);
      return;
    }
    const opts = authHeaders(tokens.accessToken);

    group('Profile', () => {
      const me = http.get(`${BASE_URL}/auth/me`, {
        ...opts,
        tags: { name: 'get_profile' },
      });
      check(me, { 'profile 200': (r) => r.status === 200 });
    });

    group('Puzzles', () => {
      const daily = http.get(`${BASE_URL}/puzzles/daily`, {
        tags: { name: 'get_puzzles' },
      });
      check(daily, { 'daily puzzle 200': (r) => r.status === 200 });
      puzzleDuration.add(daily.timings.duration);

      const themes = http.get(`${BASE_URL}/puzzles/themes`, {
        tags: { name: 'get_puzzles' },
      });
      check(themes, { 'themes 200': (r) => r.status === 200 });

      const puzzles = http.get(`${BASE_URL}/puzzles?limit=10`, {
        tags: { name: 'get_puzzles' },
      });
      check(puzzles, { 'puzzles list 200': (r) => r.status === 200 });

      const next = http.get(`${BASE_URL}/puzzles/next`, {
        ...opts,
        tags: { name: 'get_puzzles' },
      });
      check(next, { 'next puzzle 200': (r) => r.status === 200 });
    });

    group('Leaderboards', () => {
      const top = http.get(`${BASE_URL}/players/top?type=blitz&limit=20`, {
        tags: { name: 'get_leaderboard' },
      });
      check(top, { 'leaderboard 200': (r) => r.status === 200 });

      const online = http.get(`${BASE_URL}/players/online?limit=20`, {
        tags: { name: 'get_online' },
      });
      check(online, { 'online 200': (r) => r.status === 200 });
    });

    group('User games history', () => {
      const me = http.get(`${BASE_URL}/auth/me`, opts);
      if (me.status === 200) {
        try {
          const userId = JSON.parse(me.body).id;
          const games = http.get(`${BASE_URL}/users/${userId}/games?take=10`, {
            tags: { name: 'get_user_games' },
          });
          check(games, { 'user games 200': (r) => r.status === 200 });
        } catch { /* ignore */ }
      }
    });
  });

  sleep(Math.random() * 2 + 1);
}
