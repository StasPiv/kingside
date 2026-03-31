// k6/config.js — shared configuration for all load test scenarios

export const BASE_URL = __ENV.BASE_URL || 'http://localhost:3001';
export const WS_URL = __ENV.WS_URL || 'ws://localhost:3001';

// Test user pool — pre-created via k6/seed-users.sh (dev-bypass)
// Tokens loaded from k6/tokens.json or generated in setup()
export const TEST_USER_PREFIX = __ENV.USER_PREFIX || 'k6user';

// Profiles: smoke → load → stress
export const profiles = {
  smoke: {
    vus: 2,
    duration: '30s',
    thresholds: {
      http_req_failed: ['rate<0.01'],
      http_req_duration: ['p(95)<2000'],
    },
  },
  load: {
    stages: [
      { duration: '1m', target: 20 },
      { duration: '3m', target: 50 },
      { duration: '3m', target: 50 },
      { duration: '1m', target: 0 },
    ],
    thresholds: {
      http_req_failed: ['rate<0.05'],
      http_req_duration: ['p(95)<3000'],
    },
  },
  stress: {
    stages: [
      { duration: '1m', target: 50 },
      { duration: '2m', target: 150 },
      { duration: '3m', target: 300 },
      { duration: '2m', target: 150 },
      { duration: '1m', target: 0 },
    ],
    thresholds: {
      http_req_failed: ['rate<0.10'],
      http_req_duration: ['p(95)<5000'],
    },
  },
};

// Time controls for matchmaking
export const TIME_CONTROLS = {
  bullet: { timeInitial: 60, increment: 0 },
  blitz: { timeInitial: 300, increment: 0 },
  rapid: { timeInitial: 600, increment: 0 },
};

// Sample UCI moves for simulating games
export const SAMPLE_MOVES = [
  'e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5', 'a7a6',
  'b5a4', 'g8f6', 'e1g1', 'f8e7', 'f1e1', 'b7b5',
  'a4b3', 'd7d6', 'c2c3', 'e8g8', 'h2h3', 'c6b8',
  'd2d4', 'b8d7', 'b3c2', 'c7c5', 'd4d5', 'f6b7', // intentionally invalid late to end game
];
