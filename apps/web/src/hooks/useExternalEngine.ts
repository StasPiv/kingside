import { useState, useEffect, useRef, useCallback } from 'react';
import type { EvalLine } from './useStockfish';

type ExternalEngineState = 'idle' | 'connecting' | 'ready' | 'analyzing' | 'error';

export type ExternalEngineConfig = {
  name: string;
  wsUrl: string;
  secretKey: string;
};

type UseExternalEngineOptions = {
  config: ExternalEngineConfig | null;
  depth?: number;
  multiPv?: number;
  autoStart?: boolean;
};

const RECONNECT_DELAY = 3000;
const PING_INTERVAL = 15000;

/**
 * Hook for connecting to an external chess engine via WebSocket bridge.
 * Protocol: JSON messages (line, bestmove, engine_info, error, pong).
 */
export function useExternalEngine(options: UseExternalEngineOptions) {
  const { config, depth = 20, multiPv = 3, autoStart = true } = options;

  const [state, setState] = useState<ExternalEngineState>('idle');
  const [lines, setLines] = useState<EvalLine[]>([]);
  const [analysisFen, setAnalysisFen] = useState<string | null>(null);
  const [bestMove, setBestMove] = useState<string | null>(null);
  const [engineName, setEngineName] = useState<string>('External Engine');

  const wsRef = useRef<WebSocket | null>(null);
  const linesBuffer = useRef<Map<number, EvalLine>>(new Map());
  const stateRef = useRef<ExternalEngineState>(state);
  const pendingFenRef = useRef<string | null>(null);
  const pingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  stateRef.current = state;

  const cleanup = useCallback(() => {
    if (pingRef.current) { clearInterval(pingRef.current); pingRef.current = null; }
    if (reconnectRef.current) { clearTimeout(reconnectRef.current); reconnectRef.current = null; }
    if (wsRef.current) {
      wsRef.current.onclose = null;
      wsRef.current.close();
      wsRef.current = null;
    }
    setState('idle');
  }, []);

  const connect = useCallback(() => {
    if (!config) return;
    cleanup();
    setState('connecting');

    const url = config.wsUrl.includes('?')
      ? `${config.wsUrl}&key=${encodeURIComponent(config.secretKey)}`
      : `${config.wsUrl}?key=${encodeURIComponent(config.secretKey)}`;

    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      setState('error');
      return;
    }

    ws.onopen = () => {
      setState('ready');
      // Start ping keepalive
      pingRef.current = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'ping' }));
        }
      }, PING_INTERVAL);
    };

    ws.onmessage = (e) => {
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(e.data); } catch { return; }

      switch (msg.type) {
        case 'engine_info':
          setEngineName(String(msg.name ?? 'External Engine'));
          break;

        case 'line': {
          const line: EvalLine = {
            depth: Number(msg.depth ?? 0),
            multipv: Number(msg.multipv ?? 1),
            score: {
              type: (msg.score as Record<string, unknown>)?.type === 'mate' ? 'mate' : 'cp',
              value: Number((msg.score as Record<string, unknown>)?.value ?? 0),
            },
            pv: String(msg.pv ?? ''),
            nodes: msg.nodes != null ? Number(msg.nodes) : undefined,
            nps: msg.nps != null ? Number(msg.nps) : undefined,
          };
          linesBuffer.current.set(line.multipv, line);
          setLines(Array.from(linesBuffer.current.values()).sort((a, b) => a.multipv - b.multipv));
          break;
        }

        case 'bestmove': {
          const move = String(msg.move ?? '');
          setBestMove(move);

          if (pendingFenRef.current && wsRef.current?.readyState === WebSocket.OPEN) {
            const fen = pendingFenRef.current;
            pendingFenRef.current = null;
            linesBuffer.current.clear();
            setLines([]);
            setAnalysisFen(fen);
            setBestMove(null);
            setState('analyzing');
            wsRef.current.send(JSON.stringify({ type: 'evaluate', fen, depth, multiPv }));
          } else if (stateRef.current === 'analyzing') {
            setState('ready');
          }
          break;
        }

        case 'error':
          console.error('[ExternalEngine] Bridge error:', msg.message);
          break;

        case 'pong':
          break;
      }
    };

    ws.onerror = () => {
      setState('error');
    };

    ws.onclose = () => {
      if (pingRef.current) { clearInterval(pingRef.current); pingRef.current = null; }
      if (stateRef.current !== 'idle') {
        setState('error');
        // Auto-reconnect
        reconnectRef.current = setTimeout(() => {
          if (stateRef.current === 'error') connect();
        }, RECONNECT_DELAY);
      }
    };

    wsRef.current = ws;
  }, [config, cleanup, depth, multiPv]);

  useEffect(() => {
    if (autoStart && config) {
      connect();
    }
    return cleanup;
  }, [autoStart, config, connect, cleanup]);

  const evaluate = useCallback((fen: string) => {
    const s = stateRef.current;
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    if (s === 'connecting' || s === 'idle' || s === 'error') return;

    if (s === 'analyzing') {
      pendingFenRef.current = fen;
      wsRef.current.send(JSON.stringify({ type: 'stop' }));
      return;
    }

    pendingFenRef.current = null;
    linesBuffer.current.clear();
    setLines([]);
    setAnalysisFen(fen);
    setBestMove(null);
    setState('analyzing');
    wsRef.current.send(JSON.stringify({ type: 'evaluate', fen, depth, multiPv }));
  }, [depth, multiPv]);

  const stop = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'stop' }));
    }
  }, []);

  return {
    state,
    lines,
    analysisFen,
    bestMove,
    evaluate,
    stop,
    init: connect,
    cleanup,
    isReady: state === 'ready' || state === 'analyzing',
    engineName,
  };
}
