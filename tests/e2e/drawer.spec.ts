import { test, expect } from '@playwright/test'
test.beforeEach(async ({ page }) => { await page.goto('/tests/fixtures/app.html'); await expect(page.locator('[data-workbench-leaf]').first()).toBeVisible() })

test('drawer hides a pane without killing its pty and one sidebar click restores it', async ({ page }) => {
  const panes = page.locator('[data-workbench-leaf]')
  const before = await panes.count()
  expect(before).toBeGreaterThan(1)
  const created = await page.evaluate(() => (window as any).fixture.counters.created)
  const terminals = page.getByText('Terminals', { exact: true }).locator('..')

  await panes.nth(1).getByRole('button', { name: 'Move to drawer', exact: true }).click()
  await expect(panes).toHaveCount(before - 1)
  await expect(terminals.getByText(/^Drawer \(1\)$/)).toBeVisible()
  await page.screenshot({ path: 'test-results/drawer-parked.png' })

  await terminals.locator('div[title$="in drawer, click to restore"]').click()
  await expect(panes).toHaveCount(before)
  await expect(terminals.getByText(/^Drawer/)).toHaveCount(0)
  expect(await page.evaluate(() => (window as any).fixture.counters.killed)).toBe(0)
  expect(await page.evaluate(() => (window as any).fixture.counters.created)).toBe(created)
})

test('parking every pane shows the empty drawer state', async ({ page }) => {
  const panes = page.locator('[data-workbench-leaf]')
  while (await panes.count() > 0) await panes.first().getByRole('button', { name: 'Move to drawer', exact: true }).click()
  await expect(page.getByText(/in the drawer\./)).toBeVisible()
  expect(await page.evaluate(() => (window as any).fixture.counters.killed)).toBe(0)
})
