import { io } from 'socket.io-client';

const API_URL = 'http://localhost:3001';
const namespaces = ['/game', '/matchmaking', '/tournament', '/messages', '/broadcast'];

async function testNs(ns) {
  return new Promise((resolve) => {
    const s = io(`${API_URL}${ns}`, { transports: ['websocket'], timeout: 3000, autoConnect: true });
    const timer = setTimeout(() => { s.disconnect(); resolve({ ns, status: 'timeout' }); }, 4000);
    s.on('connect', () => { clearTimeout(timer); s.disconnect(); resolve({ ns, status: 'connected' }); });
    s.on('connect_error', (err) => { clearTimeout(timer); resolve({ ns, status: 'error', msg: err.message }); });
  });
}

(async () => {
  for (const ns of namespaces) {
    const res = await testNs(ns);
    console.log(JSON.stringify(res));
  }
  process.exit(0);
})();
