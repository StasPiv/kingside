import { io, type Socket } from 'socket.io-client';

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3001';

const SOCKET_OPTS = {
  autoConnect: false,
  transports: ['websocket'] as ['websocket'],
};

function withServerBusyRetry(s: Socket): Socket {
  s.on('connect_error', (err) => {
    if (err.message === 'server_busy') {
      const delay = 1000 + Math.random() * 2000; // 1-3s jitter
      setTimeout(() => {
        if (!s.connected) s.connect();
      }, delay);
    }
  });
  return s;
}

export const socket = withServerBusyRetry(io(`${API_URL}/game`, SOCKET_OPTS));

export const matchmakingSocket = withServerBusyRetry(io(`${API_URL}/matchmaking`, SOCKET_OPTS));

export const broadcastSocket = withServerBusyRetry(io(`${API_URL}/broadcast`, SOCKET_OPTS));

export const messagesSocket = withServerBusyRetry(io(`${API_URL}/messages`, SOCKET_OPTS));

export const tournamentSocket = withServerBusyRetry(io(`${API_URL}/tournament`, SOCKET_OPTS));
