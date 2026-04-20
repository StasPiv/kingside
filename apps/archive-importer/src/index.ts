import { ArchiveImporter } from './importer.js';

export async function bootstrap(): Promise<void> {
  const worker = new ArchiveImporter();

  process.on('SIGINT', async () => {
    console.log('[archive-importer] SIGINT received, shutting down...');
    await worker.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('[archive-importer] SIGTERM received, shutting down...');
    await worker.stop();
    process.exit(0);
  });

  await worker.start();
}

bootstrap().catch((err) => {
  console.error('[archive-importer] Fatal error:', err);
  process.exit(1);
});
