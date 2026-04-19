import { io, type Socket } from 'socket.io-client';

const DEV_API_URL = 'http://localhost:3001';

function isLocalHostUrl(url: string): boolean {
  return /^(wss?|https?):\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(url);
}

function pageIsOnLocalhost(): boolean {
  if (typeof window === 'undefined') return true;
  const h = window.location.hostname;
  return h === 'localhost' || h === '127.0.0.1';
}

/**
 * Resolve a websocket/HTTP service URL from Vite env, guarding against
 * misconfigured production builds that accidentally baked in localhost.
 *
 * Root cause history (KS-1570): deploy-aws.sh inherits VITE_GAME_URL from
 * the shell; if the operator's shell exported VITE_GAME_URL=ws://localhost:3002
 * (typical for local dev) the prod bundle ended up with that hardcoded,
 * breaking game creation on kingside.site.
 *
 * Rule: if the page is served from a non-localhost origin we refuse to
 * return a localhost URL — we fall back to the page origin and log a loud
 * error so the broken deploy is visible.
 */
function resolveServiceUrl(
  envValue: string | undefined,
  devFallback: string,
  varName: string,
): string {
  const isProdOrigin = !pageIsOnLocalhost();

  if (envValue) {
    if (isProdOrigin && isLocalHostUrl(envValue)) {
      const derived = typeof window !== 'undefined' ? window.location.origin : devFallback;
      // eslint-disable-next-line no-console
      console.error(
        `[socket] ${varName}="${envValue}" points to localhost but the page is served from ${
          typeof window !== 'undefined' ? window.location.origin : '(non-browser)'
        }. Ignoring env and falling back to ${derived}. Fix the build pipeline (scripts/deploy-aws.sh must pass a public ${varName}).`,
      );
      return derived;
    }
    return envValue;
  }

  // No env value provided — in prod derive from the page origin instead of
  // leaking the dev default into the production bundle.
  if (isProdOrigin && typeof window !== 'undefined') {
    return window.location.origin;
  }
  return devFallback;
}

const API_URL = resolveServiceUrl(import.meta.env.VITE_API_URL, DEV_API_URL, 'VITE_API_URL');
const GAME_URL = resolveServiceUrl(import.meta.env.VITE_GAME_URL, API_URL, 'VITE_GAME_URL');

const SOCKET_OPTS = {
  autoConnect: false,
  transports: ['websocket'] as ['websocket'],
};

let reconnectToastTimeout: ReturnType<typeof setTimeout> | null = null;

function showReconnectingToast() {
  // Avoid duplicate toasts
  if (reconnectToastTimeout) return;
  const el = document.createElement('div');
  el.className = 'reconnect-toast';
  el.textContent = 'Reconnecting...';
  document.body.appendChild(el);
  reconnectToastTimeout = setTimeout(() => {
    el.remove();
    reconnectToastTimeout = null;
  }, 4000);
}

function withHandlers(s: Socket): Socket {
  s.on('connect_error', (err) => {
    if (err.message === 'server_busy') {
      const delay = 1000 + Math.random() * 2000; // 1-3s jitter
      setTimeout(() => {
        if (!s.connected) s.connect();
      }, delay);
    }
  });

  s.on('reconnect_suggestion', () => {
    showReconnectingToast();
    s.disconnect();
    const delay = 1000 + Math.random() * 2000;
    setTimeout(() => {
      s.connect();
    }, delay);
  });

  return s;
}

// Game Service (GAME_URL) — game, matchmaking, tournament
export const socket = withHandlers(io(`${GAME_URL}/game`, SOCKET_OPTS));

export const matchmakingSocket = withHandlers(io(`${GAME_URL}/matchmaking`, SOCKET_OPTS));

export const tournamentSocket = withHandlers(io(`${GAME_URL}/tournament`, SOCKET_OPTS));

// API Service (API_URL) — broadcast, messages
export const broadcastSocket = withHandlers(io(`${API_URL}/broadcast`, SOCKET_OPTS));

export const messagesSocket = withHandlers(io(`${API_URL}/messages`, SOCKET_OPTS));
