import { useState, useEffect } from 'react';
import type { Socket } from 'socket.io-client';

/**
 * Listen for server:busy / server:ready on a socket.
 * Returns true while the server signals overload.
 * Also clears on tournament:paired or matchmaking:found (game started).
 */
export function useServerBusy(s: Socket): boolean {
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onBusy = () => setBusy(true);
    const onReady = () => setBusy(false);
    const onClear = () => setBusy(false);

    s.on('server:busy', onBusy);
    s.on('server:ready', onReady);
    s.on('tournament:paired', onClear);
    s.on('matchmaking:found', onClear);

    return () => {
      s.off('server:busy', onBusy);
      s.off('server:ready', onReady);
      s.off('tournament:paired', onClear);
      s.off('matchmaking:found', onClear);
    };
  }, [s]);

  return busy;
}
