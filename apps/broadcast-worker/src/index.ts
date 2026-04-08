import { BroadcastWorker } from './worker.js';

const worker = new BroadcastWorker();

process.on('SIGINT', async () => {
  console.log('[broadcast-worker] SIGINT received, shutting down...');
  await worker.stop();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('[broadcast-worker] SIGTERM received, shutting down...');
  await worker.stop();
  process.exit(0);
});

worker.start().catch((err) => {
  console.error('[broadcast-worker] Fatal error:', err);
  process.exit(1);
});
