import { defineConfig } from 'vitest/config';

export default defineConfig({
  // node_modules в контейнере агента смонтирован read-only — vite по
  // умолчанию пытается писать в `<workspace>/node_modules/.vite-temp`.
  // Перенаправляем кэш в /tmp.
  cacheDir: '/tmp/.vite-cache-board-image-to-fen',
  test: {
    include: ['test/**/*.spec.ts'],
    environment: 'node',
    globals: false,
  },
});
