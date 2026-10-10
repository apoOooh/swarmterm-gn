import { defineConfig } from '@playwright/test'
export default defineConfig({
  testDir: './tests/e2e', timeout: 30_000, fullyParallel: false,
  use: { baseURL: 'http://127.0.0.1:1420', headless: true, viewport: { width: 1440, height: 1000 }, trace: 'retain-on-failure' },
  webServer: { command: 'npm run dev -- --host 127.0.0.1', url: 'http://127.0.0.1:1420', reuseExistingServer: !process.env.CI, timeout: 60_000 },
  reporter: [['list']], outputDir: 'test-results'
})
