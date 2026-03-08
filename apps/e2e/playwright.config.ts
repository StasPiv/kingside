import { defineConfig, devices } from '@playwright/test';

const API_URL = process.env.E2E_API_URL || 'http://localhost:3001';

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? 'github' : 'html',
  timeout: 30_000,

  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://localhost:5173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
    },
  ],

  webServer: process.env.CI
    ? undefined
    : [
        {
          command: 'npx turbo run dev',
          cwd: '../../',
          url: 'http://localhost:5173',
          reuseExistingServer: true,
          timeout: 120_000,
        },
        {
          command: `echo "Waiting for API at ${API_URL}"`,
          url: `${API_URL}/api/auth/me`,
          reuseExistingServer: true,
          timeout: 120_000,
        },
      ],
});
