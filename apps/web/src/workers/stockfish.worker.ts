/* eslint-disable no-restricted-globals */
/// <reference lib="webworker" />

type InMessage =
  | { type: 'init' }
  | { type: 'eval'; fen: string; depth: number; multiPv: number }
  | { type: 'stop' }
  | { type: 'quit' };

type OutMessage =
  | { type: 'ready' }
  | { type: 'info'; data: InfoLine }
  | { type: 'bestmove'; move: string }
  | { type: 'error'; message: string };

export type InfoLine = {
  depth: number;
  seldepth: number;
  multipv: number;
  score: { type: 'cp' | 'mate'; value: number };
  pv: string;
  nodes?: number;
  nps?: number;
  time?: number;
};

let engine: Worker | null = null;

function parseInfo(line: string): InfoLine | null {
  const depthMatch = line.match(/\bdepth (\d+)/);
  const seldepthMatch = line.match(/\bseldepth (\d+)/);
  const multipvMatch = line.match(/\bmultipv (\d+)/);
  const cpMatch = line.match(/\bscore cp (-?\d+)/);
  const mateMatch = line.match(/\bscore mate (-?\d+)/);
  const pvMatch = line.match(/\bpv (.+)/);
  const nodesMatch = line.match(/\bnodes (\d+)/);
  const npsMatch = line.match(/\bnps (\d+)/);
  const timeMatch = line.match(/\btime (\d+)/);

  if (!depthMatch || !pvMatch) return null;
  if (!cpMatch && !mateMatch) return null;

  return {
    depth: Number(depthMatch[1]),
    seldepth: Number(seldepthMatch?.[1] ?? 0),
    multipv: Number(multipvMatch?.[1] ?? 1),
    score: mateMatch
      ? { type: 'mate', value: Number(mateMatch[1]) }
      : { type: 'cp', value: Number(cpMatch![1]) },
    pv: pvMatch[1],
    nodes: nodesMatch ? Number(nodesMatch[1]) : undefined,
    nps: npsMatch ? Number(npsMatch[1]) : undefined,
    time: timeMatch ? Number(timeMatch[1]) : undefined,
  };
}

function sendOut(msg: OutMessage) {
  self.postMessage(msg);
}

function initEngine() {
  if (engine) {
    engine.terminate();
  }

  engine = new Worker('/stockfish/stockfish-18-single.js');

  engine.onmessage = (e: MessageEvent<string>) => {
    const line = typeof e.data === 'string' ? e.data : String(e.data);

    if (line === 'uciok') {
      engine!.postMessage('isready');
      return;
    }

    if (line === 'readyok') {
      sendOut({ type: 'ready' });
      return;
    }

    if (line.startsWith('info') && line.includes(' pv ')) {
      const info = parseInfo(line);
      if (info) {
        sendOut({ type: 'info', data: info });
      }
      return;
    }

    if (line.startsWith('bestmove')) {
      const move = line.split(' ')[1] ?? '';
      sendOut({ type: 'bestmove', move });
    }
  };

  engine.onerror = (err) => {
    sendOut({ type: 'error', message: err.message ?? 'Stockfish worker error' });
  };

  engine.postMessage('uci');
}

self.onmessage = (e: MessageEvent<InMessage>) => {
  const msg = e.data;

  switch (msg.type) {
    case 'init':
      initEngine();
      break;

    case 'eval':
      if (!engine) {
        sendOut({ type: 'error', message: 'Engine not initialized' });
        return;
      }
      engine.postMessage('stop');
      engine.postMessage(`setoption name MultiPV value ${msg.multiPv}`);
      engine.postMessage(`position fen ${msg.fen}`);
      engine.postMessage(`go depth ${msg.depth}`);
      break;

    case 'stop':
      engine?.postMessage('stop');
      break;

    case 'quit':
      engine?.postMessage('quit');
      engine?.terminate();
      engine = null;
      break;
  }
};
