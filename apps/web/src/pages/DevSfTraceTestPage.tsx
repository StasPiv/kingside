/**
 * KS-3684. Локальная отладочная страница для stockfish-16-trace.
 *
 * Доступна через `/dev/sf-trace-test?dev_bypass=<secret>`. Позволяет
 * прогонять `evalTrace` на произвольной FEN через разные UCI-каналы
 * (`postMessage` / `_uci_command` / `ccall` / `cwrap` / `all`) и видеть
 * весь поток stdout-сообщений от исполнителя плюс итоговый JSON прямо
 * на экране (а не только в DevTools).
 *
 * Для локального прогона с настоящим WASM нужен сервер, выставляющий
 * COOP/COEP-заголовки — см. `scripts/sf-trace-local-server.mjs`.
 */
import { useState } from 'react';

const STARTPOS = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const MODULE_URL = '/stockfish/stockfish-16-trace.js';

type Channel =
  | 'postMessage'
  | '_uci_command'
  | 'ccall'
  | 'cwrap'
  | 'all'
  | 'init-ccall+postMessage'
  | 'init-ccall+_uci_command';

interface SfInstance {
  // KS-3676 v2 (bb cb_backend сборка): Module без addMessageListener /
  // postMessage / terminate — print/printErr приходят через опции
  // factory(opts), команды UCI отправляются через ccall.
  ccall: (
    name: string,
    ret: string | null,
    types: string[],
    args: unknown[],
  ) => unknown;
  cwrap?: (
    name: string,
    ret: string | null,
    types: string[],
  ) => (...args: unknown[]) => unknown;
  _uci_command?: (cmd: string) => void;
  // Legacy API из первой devops-сборки — оставлено опционально,
  // вдруг новой сборке тоже доступно.
  addMessageListener?: (cb: (line: unknown) => void) => void;
  removeMessageListener?: (cb: (line: unknown) => void) => void;
  postMessage?: (cmd: string) => void;
  terminate?: () => void;
}

interface FactoryOptions {
  print?: (line: string) => void;
  printErr?: (line: string) => void;
}

declare global {
  interface Window {
    StockfishTrace?: (opts?: FactoryOptions) => Promise<SfInstance>;
  }
}

async function loadFactory(
  log: (s: string) => void,
): Promise<() => Promise<SfInstance>> {
  if (window.StockfishTrace) return window.StockfishTrace;
  log(`[probe] loading ${MODULE_URL}…`);
  await new Promise<void>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = MODULE_URL;
    s.onload = () => resolve();
    s.onerror = (e) => reject(e);
    document.head.appendChild(s);
  });
  if (!window.StockfishTrace) {
    throw new Error('window.StockfishTrace not set after script load');
  }
  return window.StockfishTrace;
}

interface ProbeResult {
  fen: string;
  channel: Channel;
  startedAt: number;
  instanceMs: number | null;
  uciOkMs: number | null;
  evalMs: number | null;
  sfKeys: string[] | null;
  apiTypes: Record<string, string> | null;
  jsonRaw: unknown | null;
  error?: string;
}

async function runProbe(
  fen: string,
  channel: Channel,
  log: (s: string) => void,
): Promise<ProbeResult> {
  const startedAt = performance.now();
  const r: ProbeResult = {
    fen,
    channel,
    startedAt,
    instanceMs: null,
    uciOkMs: null,
    evalMs: null,
    sfKeys: null,
    apiTypes: null,
    jsonRaw: null,
  };
  const factory = await loadFactory(log);
  log('[probe] calling factory({ print, printErr })…');
  // KS-3676 v2: print/printErr приходят через опции фабрики
  // (INCOMING_MODULE_JS_API=['print','printErr']).
  const printSubscribers: Array<(line: string) => void> = [];
  const sf = await factory({
    print: (line: string) => {
      for (const cb of printSubscribers) cb(line);
    },
    printErr: (line: string) => {
      log(`stderr: ${line}`);
    },
  });
  r.instanceMs = Math.round(performance.now() - startedAt);
  log(`[probe] instance ready in ${r.instanceMs}ms`);
  // Adapter: эмулируем addMessageListener поверх print, чтобы остаток
  // кода (uciListener / jsonListener) не пришлось переписывать.
  const sfFx = sf as SfInstance & {
    addMessageListener: (cb: (line: unknown) => void) => void;
    removeMessageListener: (cb: (line: unknown) => void) => void;
  };
  if (typeof sf.addMessageListener !== 'function') {
    sfFx.addMessageListener = (cb) => {
      printSubscribers.push(cb as (line: string) => void);
    };
    sfFx.removeMessageListener = (cb) => {
      const i = printSubscribers.indexOf(cb as (line: string) => void);
      if (i >= 0) printSubscribers.splice(i, 1);
    };
  }
  try {
    r.sfKeys = Object.keys(sf as unknown as Record<string, unknown>);
    log(`[probe] sf keys: ${r.sfKeys.join(', ')}`);
  } catch {
    /* ignore */
  }
  r.apiTypes = {
    postMessage: typeof sf.postMessage,
    addMessageListener: typeof sf.addMessageListener,
    _uci_command: typeof sf._uci_command,
    ccall: typeof sf.ccall,
    cwrap: typeof sf.cwrap,
    terminate: typeof sf.terminate,
  };
  log(`[probe] api types: ${JSON.stringify(r.apiTypes)}`);

  let cwrapUciCommand: ((cmd: string) => void) | null = null;
  if (typeof sf.cwrap === 'function') {
    try {
      cwrapUciCommand = sf.cwrap('uci_command', null, ['string']) as (
        cmd: string,
      ) => void;
    } catch (err) {
      log(`[probe] cwrap prepare threw: ${String(err)}`);
    }
  }
  let cmdIdx = 0;
  const sendCmd = (cmd: string) => {
    cmdIdx++;
    const effective: Channel = (() => {
      if (channel === 'init-ccall+postMessage') {
        return cmdIdx === 1 ? 'ccall' : 'postMessage';
      }
      if (channel === 'init-ccall+_uci_command') {
        return cmdIdx === 1 ? 'ccall' : '_uci_command';
      }
      return channel;
    })();
    log(`→ ${cmd} (eff=${effective})`);
    try {
      if (
        (effective === 'postMessage' || effective === 'all') &&
        typeof sf.postMessage === 'function'
      ) {
        sf.postMessage(cmd);
        log(`  ✓ postMessage`);
      }
    } catch (err) {
      log(`  ! postMessage threw: ${String(err)}`);
    }
    try {
      if (
        (effective === '_uci_command' || effective === 'all') &&
        typeof sf._uci_command === 'function'
      ) {
        sf._uci_command(cmd);
        log(`  ✓ _uci_command`);
      }
    } catch (err) {
      log(`  ! _uci_command threw: ${String(err)}`);
    }
    try {
      if (
        (effective === 'ccall' || effective === 'all') &&
        typeof sf.ccall === 'function'
      ) {
        sf.ccall('uci_command', null, ['string'], [cmd]);
        log(`  ✓ ccall`);
      }
    } catch (err) {
      log(`  ! ccall threw: ${String(err)}`);
    }
    try {
      if (
        (effective === 'cwrap' || effective === 'all') &&
        cwrapUciCommand
      ) {
        cwrapUciCommand(cmd);
        log(`  ✓ cwrap`);
      }
    } catch (err) {
      log(`  ! cwrap threw: ${String(err)}`);
    }
  };

  const onLine = (raw: unknown) => {
    const s =
      typeof raw === 'string'
        ? raw
        : raw && typeof raw === 'object' && 'data' in raw
          ? String((raw as { data: unknown }).data)
          : `[obj] ${JSON.stringify(raw)}`;
    log(`← ${s}`);
  };
  sfFx.addMessageListener(onLine);

  let resolveUci: () => void = () => {};
  const uciOkPromise = new Promise<void>((res) => {
    resolveUci = res;
  });
  const uciListener = (raw: unknown) => {
    const s = typeof raw === 'string' ? raw : '';
    if (s.trim() === 'uciok') {
      sfFx.removeMessageListener(uciListener);
      resolveUci();
    }
  };
  sfFx.addMessageListener(uciListener);

  let resolveJson: (j: unknown) => void = () => {};
  const jsonPromise = new Promise<unknown>((res) => {
    resolveJson = res;
  });
  let collecting = false;
  let buf = '';
  let depth = 0;
  const jsonListener = (raw: unknown) => {
    const line = typeof raw === 'string' ? raw : '';
    if (!collecting) {
      if (line.trimStart().startsWith('{')) {
        collecting = true;
        buf = '';
        depth = 0;
      } else {
        return;
      }
    }
    buf += line + '\n';
    for (let i = 0; i < line.length; i++) {
      const ch = line.charCodeAt(i);
      if (ch === 0x7b) depth++;
      else if (ch === 0x7d) depth--;
    }
    if (collecting && depth <= 0) {
      collecting = false;
      sfFx.removeMessageListener(jsonListener);
      try {
        resolveJson(JSON.parse(buf));
      } catch (err) {
        log(`[probe] JSON parse failed: ${String(err)}`);
        resolveJson(null);
      }
    }
  };
  sfFx.addMessageListener(jsonListener);

  const uciStart = performance.now();
  sendCmd('uci');
  const uciResult = await Promise.race([
    uciOkPromise.then(() => 'ok' as const),
    new Promise<'timeout'>((res) => setTimeout(() => res('timeout'), 8000)),
  ]);
  r.uciOkMs = Math.round(performance.now() - uciStart);
  log(`[probe] uci → ${uciResult} in ${r.uciOkMs}ms`);
  if (uciResult === 'timeout') {
    try {
      sf.terminate?.();
    } catch {
      /* ignore */
    }
    r.error = 'uciok-timeout';
    return r;
  }

  const evalStart = performance.now();
  sendCmd(`position fen ${fen}`);
  sendCmd('eval json');
  const jsonResult = await Promise.race([
    jsonPromise,
    new Promise<unknown>((res) => setTimeout(() => res('__timeout'), 8000)),
  ]);
  r.evalMs = Math.round(performance.now() - evalStart);
  log(`[probe] eval finished in ${r.evalMs}ms`);
  try {
    sf.terminate?.();
  } catch {
    /* ignore */
  }
  if (jsonResult === '__timeout') {
    r.error = 'eval-json-timeout';
    return r;
  }
  r.jsonRaw = jsonResult;
  return r;
}

export function DevSfTraceTestPage() {
  const [fen, setFen] = useState(STARTPOS);
  const [channel, setChannel] = useState<Channel>('ccall');
  const [logs, setLogs] = useState<string[]>([]);
  const [result, setResult] = useState<ProbeResult | null>(null);
  const [running, setRunning] = useState(false);

  const log = (s: string) =>
    setLogs((prev) => [
      ...prev,
      `${(performance.now() / 1000).toFixed(2).padStart(7)}s  ${s}`,
    ]);

  const run = async () => {
    setRunning(true);
    setLogs([]);
    setResult(null);
    try {
      const r = await runProbe(fen, channel, log);
      setResult(r);
    } catch (err) {
      log(`[probe] FATAL: ${String(err)}`);
      setResult({
        fen,
        channel,
        startedAt: performance.now(),
        instanceMs: null,
        uciOkMs: null,
        evalMs: null,
        sfKeys: null,
        apiTypes: null,
        jsonRaw: null,
        error: String(err),
      });
    } finally {
      setRunning(false);
    }
  };

  return (
    <div
      data-testid="dev-sf-trace-test"
      style={{
        padding: 20,
        fontFamily: 'ui-monospace, monospace',
        color: '#222',
      }}
    >
      <h1>SF-Trace local test (KS-3684)</h1>
      <p style={{ color: '#666', fontSize: 13 }}>
        Прогон `evalTrace` через выбранный UCI-канал. Результат и поток
        сообщений видны прямо на странице (не в DevTools).
      </p>
      <div style={{ marginBottom: 8 }}>
        <label>
          FEN:{' '}
          <input
            data-testid="sf-trace-fen"
            value={fen}
            onChange={(e) => setFen(e.target.value)}
            style={{ width: 600, fontFamily: 'inherit' }}
          />
        </label>
      </div>
      <div style={{ marginBottom: 8 }}>
        <label>
          Channel:{' '}
          <select
            data-testid="sf-trace-channel"
            value={channel}
            onChange={(e) => setChannel(e.target.value as Channel)}
          >
            <option value="postMessage">postMessage</option>
            <option value="_uci_command">_uci_command</option>
            <option value="ccall">ccall</option>
            <option value="cwrap">cwrap</option>
            <option value="all">all (dup)</option>
            <option value="init-ccall+postMessage">
              init-ccall + postMessage
            </option>
            <option value="init-ccall+_uci_command">
              init-ccall + _uci_command
            </option>
          </select>
        </label>
      </div>
      <button
        data-testid="sf-trace-run"
        onClick={run}
        disabled={running}
        style={{ padding: '6px 14px' }}
      >
        {running ? 'Running…' : 'Run'}
      </button>
      <h2>Logs</h2>
      <pre
        data-testid="sf-trace-logs"
        style={{
          background: '#111',
          color: '#0f0',
          padding: 10,
          maxHeight: 360,
          overflow: 'auto',
          fontSize: 12,
        }}
      >
        {logs.join('\n')}
      </pre>
      <h2>Result</h2>
      <pre
        data-testid="sf-trace-result"
        style={{
          background: '#111',
          color: '#fff',
          padding: 10,
          maxHeight: 360,
          overflow: 'auto',
          fontSize: 12,
        }}
      >
        {result ? JSON.stringify(result, null, 2) : '(no result yet)'}
      </pre>
    </div>
  );
}
