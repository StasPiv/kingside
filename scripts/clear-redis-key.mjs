#!/usr/bin/env node
// KS-2698: точечно удалить Redis-key из локального redis (порт 6380).
// Используется для очистки `archive:import:lock:twic` после OOM-падения
// importer'а — иначе demon ждёт TTL (30 мин), и tick всё это время
// логирует "lock held, skipping".
//
// Не зависит от `ioredis` (Node 22+ имеет встроенный `node:net`).
//
// Usage: node scripts/clear-redis-key.mjs <key>

import net from 'node:net';

const HOST = process.env.REDIS_HOST_LOCAL ?? '127.0.0.1';
const PORT = Number(process.env.REDIS_PORT_LOCAL ?? '6380');
const key = process.argv[2];

if (!key) {
  console.error('Usage: node scripts/clear-redis-key.mjs <key>');
  process.exit(2);
}

const cmd = `*2\r\n$3\r\nDEL\r\n$${Buffer.byteLength(key)}\r\n${key}\r\n`;

const sock = net.createConnection({ host: HOST, port: PORT }, () => {
  sock.write(cmd);
});

let buf = '';
sock.setTimeout(5000);
sock.on('data', (data) => {
  buf += data.toString('utf8');
  // RESP integer reply: ":<n>\r\n"
  if (buf.startsWith(':') && buf.includes('\r\n')) {
    const n = Number(buf.slice(1, buf.indexOf('\r\n')));
    console.log(`DEL ${key} → ${n} (deleted ${n} key${n === 1 ? '' : 's'})`);
    sock.end();
    process.exit(0);
  } else if (buf.startsWith('-')) {
    console.error(`Redis error: ${buf.trim()}`);
    sock.end();
    process.exit(1);
  }
});
sock.on('timeout', () => {
  console.error('Redis timeout');
  sock.destroy();
  process.exit(1);
});
sock.on('error', (e) => {
  console.error(`Redis connection error: ${e.message}`);
  process.exit(1);
});
