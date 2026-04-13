import { PuzzleWorker } from './worker.js';

const worker = new PuzzleWorker();

process.on('SIGINT', async () => {
  console.log('[puzzle-worker] SIGINT received, shutting down...');
  await worker.stop();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('[puzzle-worker] SIGTERM received, shutting down...');
  await worker.stop();
  process.exit(0);
});

worker.start().catch((err) => {
  console.error('[puzzle-worker] Fatal error:', err);
  process.exit(1);
});
