import { io, type Socket } from 'socket.io-client';

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3001';
const GAME_URL = import.meta.env.VITE_GAME_URL ?? API_URL;

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
