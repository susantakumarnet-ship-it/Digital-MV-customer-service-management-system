import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests (QA-02). Starts the API on a fresh `mv_e2e` database and the Vite dev server.
 * Run: npm run e2e
 */
export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  // Multi-step journeys (classify → create → assign) can exceed the 30 s default on slower machines.
  timeout: 60_000,
  // Assertions wait up to 10 s: sign-in (Argon2id) and page loads can be slow while the full suite runs.
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://localhost:5611',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'] }, grepInvert: /@mobile/ },
    { name: 'mobile-chromium', use: { ...devices['Pixel 7'] }, grep: /@mobile/ },
  ],
  webServer: [
    {
      command: 'node e2e/start-api.mjs',
      url: 'http://localhost:4610/api/v1/health/ready',
      timeout: 180_000,
      reuseExistingServer: false,
    },
    {
      // Production build, as shipped.
      command: 'npm run build -w @mv/web && npm run preview -w @mv/web',
      url: 'http://localhost:5611',
      timeout: 240_000,
      reuseExistingServer: false,
    },
  ],
});
