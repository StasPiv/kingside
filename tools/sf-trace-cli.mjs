#!/usr/bin/env node
/**
 * KS-4941: CLI над инструментированным Stockfish-16-trace (63 позиционных
 * субтерма). Тот же движок, что в браузере (apps/web/public/stockfish/
 * stockfish-16-trace.{js,wasm}) — команда `eval json` отдаёт JSON-разбивку.
 *
 *   node sf-trace-cli.mjs --fen "<FEN>"
 *
 * Выводит как есть JSON от движка (positional_subterms и пр.).
 * Протокол повторяет apps/web/src/lib/review/stockfishTrace.ts (evalTrace):
 *   setoption name Use NNUE value false → position fen X → eval json → quit.
 *
 * Emscripten-модуль грузится через require (в сборке есть node-ветка).
 * WASM берётся из SF_TRACE_DIR (env) или из папки рядом со скриптом.
 */
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const dir = process.env.SF_TRACE_DIR || here;

const args = process.argv.slice(2);
function opt(name, def) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}
const fen = opt('fen', null);
if (!fen) {
  console.error('Использование: sf-trace-cli --fen "<FEN>"');
  process.exit(2);
}

async function run() {
const factory = require(resolve(dir, 'stockfish-16-trace.js'));

// Канал команд — Module.ccall('uci_command', ...): в этой сборке stdin
// не пробуждает исполнитель (см. stockfishTrace.ts:322). JSON от `eval json`
// собираем из print-строк начиная с `{` до баланса скобок.
let collecting = false;
let braceDepth = 0;
const buf = [];
let resolveJson = () => {};
const jsonPromise = new Promise((r) => {
  resolveJson = r;
});

const print = (line) => {
  if (!collecting) {
    if (line.trimStart().startsWith('{')) {
      collecting = true;
      buf.length = 0;
      braceDepth = 0;
    } else {
      return;
    }
  }
  buf.push(line);
  for (let i = 0; i < line.length; i++) {
    const ch = line.charCodeAt(i);
    if (ch === 0x7b) braceDepth++;
    else if (ch === 0x7d) braceDepth--;
  }
  if (collecting && braceDepth <= 0 && buf.length > 0) {
    collecting = false;
    try {
      resolveJson(JSON.parse(buf.join('\n')));
    } catch {
      resolveJson(null);
    }
  }
};

const timeout = new Promise((_, rej) =>
  setTimeout(() => rej(new Error('sf-trace timeout')), 15000),
);

try {
  const mod = await Promise.race([
    factory({ print, printErr: () => {}, locateFile: (name) => resolve(dir, name) }),
    timeout,
  ]);
  for (const cmd of [
    'uci',
    'setoption name Use NNUE value false',
    `position fen ${fen}`,
    'eval json',
  ]) {
    mod.ccall('uci_command', null, ['string'], [cmd]);
  }
  const json = await Promise.race([jsonPromise, timeout]);
  if (json == null) {
    console.error('sf-trace: движок не вернул JSON');
    process.exit(1);
  }
  console.log(JSON.stringify(json));
  process.exit(0);
} catch (e) {
  console.error('sf-trace error:', e.message);
  process.exit(1);
}
}

run();
