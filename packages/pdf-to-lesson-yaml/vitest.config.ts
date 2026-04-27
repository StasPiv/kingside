import { defineConfig } from 'vitest/config';

export default defineConfig({
  // node_modules в контейнере агента смонтирован read-only — vite по
  // умолчанию пытается писать в `<workspace>/node_modules/.vite-temp`.
  cacheDir: '/tmp/.vite-cache-pdf-to-lesson-yaml',
  test: {
    include: ['test/**/*.spec.ts'],
    environment: 'node',
    globals: false,
  },
});
