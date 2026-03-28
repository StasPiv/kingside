/**
 * EngineAdapter — unified interface for chess engine analysis.
 * Two implementations: WasmEngineAdapter (in-browser Stockfish)
 * and BridgeEngineAdapter (external engine via WebSocket).
 */

export type InfoLine = {
  multipv: number;
  depth: number;
  score: { type: 'cp' | 'mate'; value: number };
  pv: string[];
};

export type AnalysisResult = {
  lines: InfoLine[];
  bestByDepth: Map<number, string>;
  evalByDepth: Map<number, number>;
  firstAppearance: number;
};

export interface EngineAdapter {
  init(): Promise<void>;
  setOption(name: string, value: string): void;
  analyze(fen: string, depth: number, multiPv: number): Promise<AnalysisResult>;
  destroy(): void;
}

// ─── Shared helpers ───

function parseInfoLine(line: string): InfoLine | null {
  const depthMatch = line.match(/\bdepth (\d+)/);
  const pvMatch = line.match(/\bpv (.+)/);
  if (!depthMatch || !pvMatch) return null;

  const depth = parseInt(depthMatch[1], 10);
  const multipvMatch = line.match(/\bmultipv (\d+)/);
  const multipv = multipvMatch ? parseInt(multipvMatch[1], 10) : 1;
  const pv = pvMatch[1].split(/\s+/);

  let score: { type: 'cp' | 'mate'; value: number };
  const cpMatch = line.match(/\bscore cp (-?\d+)/);
  const mateMatch = line.match(/\bscore mate (-?\d+)/);
  if (mateMatch) {
    score = { type: 'mate', value: parseInt(mateMatch[1], 10) };
  } else if (cpMatch) {
    score = { type: 'cp', value: parseInt(cpMatch[1], 10) };
  } else {
    return null;
  }

  return { depth, multipv, score, pv };
}

function buildResult(
  finalLines: Map<number, InfoLine>,
  bestByDepth: Map<number, string>,
  evalByDepth: Map<number, number>,
  targetDepth: number,
): AnalysisResult {
  const lines = Array.from(finalLines.values()).sort((a, b) => a.multipv - b.multipv);
  const finalBest = lines.length > 0 ? lines[0].pv[0] : '';

  let firstAppearance = targetDepth;
  for (let d = 1; d <= targetDepth; d++) {
    if (bestByDepth.get(d) === finalBest) {
      firstAppearance = d;
      break;
    }
  }

  return { lines, bestByDepth, evalByDepth, firstAppearance };
}

function scoreToCP(score: { type: 'cp' | 'mate'; value: number }): number {
  if (score.type === 'mate') {
    const dist = Math.abs(score.value);
    const base = 10000 - (dist - 1) * 100;
    return score.value > 0 ? base : -base;
  }
  return score.value;
}

// ─── WASM Adapter ───

export class WasmEngineAdapter implements EngineAdapter {
  private worker: Worker | null = null;

  async init(): Promise<void> {
    this.worker = new Worker('/stockfish/stockfish-18-single.js');

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Stockfish init timeout')), 15000);
      const handler = (e: MessageEvent) => {
        if (typeof e.data === 'string' && e.data.includes('uciok')) {
          clearTimeout(timer);
          this.worker!.removeEventListener('message', handler);
          console.log('[WasmEngine] Stockfish ready');
          resolve();
        }
      };
      this.worker!.addEventListener('message', handler);
      this.worker!.postMessage('uci');
    });
  }

  setOption(name: string, value: string): void {
    this.worker?.postMessage(`setoption name ${name} value ${value}`);
  }

  analyze(fen: string, depth: number, multiPv: number): Promise<AnalysisResult> {
    return new Promise((resolve) => {
      const finalLines = new Map<number, InfoLine>();
      const bestByDepth = new Map<number, string>();
      const evalByDepth = new Map<number, number>();

      const handler = (e: MessageEvent) => {
        const msg = typeof e.data === 'string' ? e.data : '';

        if (msg.startsWith('info') && msg.includes(' pv ')) {
          const info = parseInfoLine(msg);
          if (info) {
            if (info.multipv === 1) {
              bestByDepth.set(info.depth, info.pv[0]);
              evalByDepth.set(info.depth, scoreToCP(info.score));
            }
            if (info.depth >= depth - 2) {
              finalLines.set(info.multipv, info);
            }
          }
        }

        if (msg.startsWith('bestmove')) {
          this.worker!.removeEventListener('message', handler);
          resolve(buildResult(finalLines, bestByDepth, evalByDepth, depth));
        }
      };

      this.worker!.addEventListener('message', handler);
      this.worker!.postMessage(`position fen ${fen}`);
      this.worker!.postMessage(`go depth ${depth}`);
    });
  }

  destroy(): void {
    this.worker?.terminate();
    this.worker = null;
  }
}

// ─── Bridge Adapter ───

export type BridgeConfig = {
  wsUrl: string;
  secretKey: string;
};

function normalizeWsUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (!url.pathname || url.pathname === '/') url.pathname = '/ws';
    return url.toString();
  } catch {
    const base = raw.replace(/\/+$/, '');
    return base.endsWith('/ws') ? base : `${base}/ws`;
  }
}

function isLocalhostUrl(wsUrl: string): boolean {
  try {
    const url = new URL(wsUrl);
    return url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  } catch {
    return wsUrl.includes('localhost') || wsUrl.includes('127.0.0.1');
  }
}

export class BridgeEngineAdapter implements EngineAdapter {
  private ws: WebSocket | null = null;
  private config: BridgeConfig;

  constructor(config: BridgeConfig) {
    this.config = config;
  }

  async init(): Promise<void> {
    const baseUrl = normalizeWsUrl(this.config.wsUrl);
    const isLocal = isLocalhostUrl(this.config.wsUrl);
    const url = isLocal || !this.config.secretKey
      ? baseUrl
      : baseUrl.includes('?')
        ? `${baseUrl}&key=${encodeURIComponent(this.config.secretKey)}`
        : `${baseUrl}?key=${encodeURIComponent(this.config.secretKey)}`;

    console.log('[BridgeEngine] Connecting to:', url);

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Bridge connection timeout')), 10000);
      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch (err) {
        clearTimeout(timer);
        reject(new Error('Failed to create WebSocket: ' + (err instanceof Error ? err.message : String(err))));
        return;
      }

      ws.onopen = () => {
        clearTimeout(timer);
        this.ws = ws;
        console.log('[BridgeEngine] Connected');
        resolve();
      };

      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error('Bridge connection failed — is the bridge running?'));
      };

      ws.onclose = (ev) => {
        clearTimeout(timer);
        if (!this.ws) {
          reject(new Error(`Bridge closed during connect (code ${ev.code})`));
        }
      };
    });
  }

  setOption(name: string, value: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'setoption', name, value }));
    }
  }

  analyze(fen: string, depth: number, multiPv: number): Promise<AnalysisResult> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('Bridge not connected'));
        return;
      }

      const finalLines = new Map<number, InfoLine>();
      const bestByDepth = new Map<number, string>();
      const evalByDepth = new Map<number, number>();

      const handler = (e: MessageEvent) => {
        let msg: Record<string, unknown>;
        try { msg = JSON.parse(e.data); } catch { return; }

        if (msg.type === 'line') {
          const info: InfoLine = {
            depth: Number(msg.depth ?? 0),
            multipv: Number(msg.multipv ?? 1),
            score: {
              type: (msg.score as Record<string, unknown>)?.type === 'mate' ? 'mate' : 'cp',
              value: Number((msg.score as Record<string, unknown>)?.value ?? 0),
            },
            pv: String(msg.pv ?? '').split(/\s+/).filter(Boolean),
          };

          if (info.multipv === 1) {
            bestByDepth.set(info.depth, info.pv[0]);
            evalByDepth.set(info.depth, scoreToCP(info.score));
          }
          if (info.depth >= depth - 2) {
            finalLines.set(info.multipv, info);
          }
        }

        if (msg.type === 'bestmove') {
          this.ws!.removeEventListener('message', handler);
          resolve(buildResult(finalLines, bestByDepth, evalByDepth, depth));
        }

        if (msg.type === 'error') {
          this.ws!.removeEventListener('message', handler);
          reject(new Error(String(msg.message ?? 'Bridge error')));
        }
      };

      this.ws.addEventListener('message', handler);
      this.ws.send(JSON.stringify({ type: 'analyze', fen, depth, multiPv }));
    });
  }

  destroy(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}
