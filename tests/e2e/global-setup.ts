import { chromium, type FullConfig } from '@playwright/test'

/**
 * Warm Vite's transform cache before the first test. The fixture app pulls
 * ~2,100 modules that the dev server compiles on first request; on a cold CI
 * runner that first load took ~9 s, so whichever test ran first in a worker
 * blew its 5 s expect timeouts (custom-shortcuts, drag-layouts, …). One
 * throwaway load here makes every test start from a warm server.
 */
export default async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL = config.projects[0]?.use.baseURL ?? 'http://127.0.0.1:1420'
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    await page.goto(`${baseURL}/tests/fixtures/app.html`)
    // The first terminal spawn means App has rendered past its lazy boot.
    await page.waitForFunction(() => ((window as any).fixture?.counters.created ?? 0) > 0, undefined, { timeout: 120_000 })
  } finally {
    await browser.close()
  }
}
