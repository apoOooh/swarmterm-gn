import { defineConfig } from '@playwright/test'
export default defineConfig({
  testDir: './tests/e2e', timeout: 30_000, fullyParallel: false,
  globalSetup: './tests/e2e/global-setup.ts',
  // Shared CI runners stall for seconds at a time; 5 s assertions flaked there.
  expect: { timeout: process.env.CI ? 15_000 : 5_000 },
  use: { baseURL: 'http://127.0.0.1:1420', headless: true, viewport: { width: 1440, height: 1000 }, trace: 'retain-on-failure' },
  webServer: { command: 'npm run dev -- --host 127.0.0.1', url: 'http://127.0.0.1:1420', reuseExistingServer: !process.env.CI, timeout: 60_000 },
  reporter: [['list']], outputDir: 'test-results'
})
