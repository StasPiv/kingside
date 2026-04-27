import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.spec.ts'],
    environment: 'node',
    // Тесты импортируют JSON-файлы и AJV через require — Node режим.
    globals: false,
  },
});
