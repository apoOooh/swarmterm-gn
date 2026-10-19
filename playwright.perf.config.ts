import { defineConfig } from '@playwright/test'
import base from './playwright.config'

// Perf harness config (scripts/perf/flood.ps1). Reuses the e2e config but
// attaches over CDP to a running isolated dev instance instead of serving the
// mock fixture, so there is no webServer and no globalSetup.
export default defineConfig({
  ...base,
  testDir: './tests/perf',
  testMatch: /.*\.perf\.ts/,
  timeout: 30 * 60_000,
  globalSetup: undefined,
  webServer: undefined,
  // Only the CDP-attached WebView is used: no baseURL, browser launch or traces.
  use: { trace: 'off' },
  retries: 0,
  workers: 1,
  outputDir: 'test-results/perf-pw'
})
