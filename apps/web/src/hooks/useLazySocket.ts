import { useEffect } from 'react';
import type { Socket } from 'socket.io-client';

/**
 * Lazily connect a socket.io socket on mount, disconnect on unmount.
 * If requireAuth is true (default), skips connection when no JWT token is available.
 */
export function useLazySocket(s: Socket, requireAuth = true) {
  useEffect(() => {
    const token = localStorage.getItem('token');
    if (requireAuth && !token) return;
    s.auth = token ? { token } : {};
    if (!s.connected) {
      s.connect();
    }
    return () => {
      s.disconnect();
    };
  }, [s, requireAuth]);
}
