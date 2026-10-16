import { test, expect } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/fixtures/app.html')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
})

async function edge(page: import('@playwright/test').Page): Promise<{ x: number; y: number }> {
  const size = page.viewportSize()!
  return { x: size.width - 2, y: Math.round(size.height / 2) }
}

test('right edge peeks the closed right panel and slides it out on leave', async ({ page }) => {
  const { x, y } = await edge(page)
  await page.mouse.move(x - 200, y)
  await page.mouse.move(x, y)
  await expect(page.getByRole('button', { name: 'Pin panel' }).first()).toBeVisible()
  // Preview cannot float (native webview) — it asks to be pinned instead.
  await expect(page.getByText('Pin the panel to use Preview.')).toBeVisible()

  await page.mouse.move(100, y)
  await expect(page.getByRole('button', { name: 'Pin panel' })).toHaveCount(0)
})

test('pin docks the peeking panel', async ({ page }) => {
  const { x, y } = await edge(page)
  await page.mouse.move(x - 200, y)
  await page.mouse.move(x, y)
  await page.getByRole('button', { name: 'Pin panel' }).first().click()
  await expect(page.getByRole('button', { name: 'Close panel' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Pin panel' })).toHaveCount(0)
})

test('the setting turns the right edge off', async ({ page }) => {
  await page.evaluate(() => localStorage.setItem('swarmterm.rightPanelPeek', 'false'))
  await page.reload()
  const { x, y } = await edge(page)
  await page.mouse.move(x - 200, y)
  await page.mouse.move(x, y)
  await page.waitForTimeout(400)
  await expect(page.getByRole('button', { name: 'Pin panel' })).toHaveCount(0)
})
