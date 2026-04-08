import { MatchmakerWorker } from './worker.js';

const worker = new MatchmakerWorker();

process.on('SIGINT', async () => {
  console.log('[matchmaker] SIGINT received, shutting down...');
  await worker.stop();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('[matchmaker] SIGTERM received, shutting down...');
  await worker.stop();
  process.exit(0);
});

worker.start().catch((err) => {
  console.error('[matchmaker] Fatal error:', err);
  process.exit(1);
});
