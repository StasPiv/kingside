/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@kingside/shared': path.resolve(__dirname, '../../packages/shared/src'),
    },
  },
  test: {
    globals: true,
    environment: 'happy-dom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    css: false,
    env: {
      // Archive-service base URL for tests. Production value is injected via
      // VITE_ARCHIVE_URL in scripts/deploy-aws.sh; dev uses .env. See ADR-018 §2.7.
      VITE_ARCHIVE_URL: 'http://archive.test',
    },
  },
});
