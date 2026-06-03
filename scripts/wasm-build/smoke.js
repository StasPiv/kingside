// scripts/wasm-build/smoke.js
// KS-3653 — smoke-проверка собранного stockfish-trace.wasm через Node.
//
// Usage:
//   node scripts/wasm-build/smoke.js scripts/wasm-build/out/stockfish-trace.js
//
// Проверка:
//   1. `uci` → должен прийти `uciok`.
//   2. `position startpos` + `eval json` → корректный JSON (с trace-полями
//      от C1a, конкретный схему уточнить с backend по факту патча).

'use strict';

const path = require('path');

const jsPath = process.argv[2];
if (!jsPath) {
    console.error('Usage: node smoke.js <path-to-stockfish-trace.js>');
    process.exit(1);
}

const absJs = path.resolve(jsPath);
const Stockfish = require(absJs);

(async () => {
    const sf = await Stockfish();
    const lines = [];
    const pending = [];

    sf.addMessageListener((line) => {
        lines.push(line);
        for (const waiter of pending) waiter(line);
    });

    function waitFor(predicate, timeoutMs = 5000) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(
                () => reject(new Error(`Timeout waiting for ${predicate}`)),
                timeoutMs,
            );
            const check = (line) => {
                if (predicate(line)) {
                    clearTimeout(timer);
                    const idx = pending.indexOf(check);
                    if (idx >= 0) pending.splice(idx, 1);
                    resolve(line);
                }
            };
            // Проверим уже накопленные строки.
            for (const l of lines) {
                if (predicate(l)) {
                    clearTimeout(timer);
                    resolve(l);
                    return;
                }
            }
            pending.push(check);
        });
    }

    // 1. UCI handshake.
    sf.postMessage('uci');
    await waitFor((l) => l === 'uciok');
    console.log('[smoke] uciok OK');

    // 2. Startpos eval json.
    sf.postMessage('position startpos');
    sf.postMessage('eval json');
    // Ждём строку, которая парсится как JSON (точная схема — после C1a).
    const jsonLine = await waitFor((l) => {
        const t = l.trim();
        if (!t.startsWith('{')) return false;
        try { JSON.parse(t); return true; } catch { return false; }
    }, 8000);
    const parsed = JSON.parse(jsonLine.trim());
    console.log('[smoke] eval json OK; keys:', Object.keys(parsed));

    sf.postMessage('quit');
    process.exit(0);
})().catch((err) => {
    console.error('[smoke] FAILED:', err);
    process.exit(1);
});
