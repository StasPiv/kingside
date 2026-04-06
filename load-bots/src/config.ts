export interface Config {
  baseUrl: string;
  wsUrl: string;
  concurrency: number;
  durationSec: number;
  devBypassSecret: string;
  userPrefix: string;
  thinkTimeMs: [number, number]; // [min, max] ms per move
}

export function loadConfig(): Config {
  return {
    baseUrl: process.env.BASE_URL || 'http://localhost:3001',
    wsUrl: process.env.WS_URL || 'http://localhost:3001',
    concurrency: parseInt(process.env.CONCURRENCY || '10', 10),
    durationSec: parseInt(process.env.DURATION_SEC || '120', 10),
    devBypassSecret: process.env.DEV_BYPASS_SECRET || 'secret',
    userPrefix: process.env.USER_PREFIX || 'loadbot',
    thinkTimeMs: [
      parseInt(process.env.THINK_MIN_MS || '500', 10),
      parseInt(process.env.THINK_MAX_MS || '3000', 10),
    ],
  };
}
