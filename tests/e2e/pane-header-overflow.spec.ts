import { test, expect, type Page } from '@playwright/test'
test.beforeEach(async ({ page }) => { await page.goto('/tests/fixtures/app.html'); await expect(page.locator('[data-leaf-id]')).toHaveCount(2) })

// Fixture: two panes side by side. Squeeze the left one so its header overflows.
async function squeezeLeft(page: Page, pct: number): Promise<void> {
  await page.evaluate((p) => {
    const store = (window as any).fixture.useAppStore
    const ws = store.getState().workspaces.find((w: any) => w.id === store.getState().activeWorkspaceId)
    store.getState().resizeSplitNode(ws.layout.id, [p, 100 - p])
  }, pct)
}

test('a narrow pane keeps its critical controls and marks the rest with ⋯', async ({ page }) => {
  const header = page.locator('[data-leaf-id]').first().locator('.pane-header')
  await expect(header.getByLabel('Show hidden controls')).toHaveCount(0)

  await squeezeLeft(page, 15)
  const more = header.getByLabel('Show hidden controls')
  await expect(more).toBeVisible()
  const box = (await header.boundingBox())!
  for (const name of [/^Agent:/, /^Folder:/, 'Maximize pane', 'Close pane']) {
    const b = (await header.getByRole('button', { name }).first().boundingBox())!
    expect(b.x).toBeGreaterThanOrEqual(box.x - 1)
    expect(b.x + b.width).toBeLessThanOrEqual(box.x + box.width + 1)
  }
  // Split right is collapsed out of the row: only its copy in the panel exists.
  const panel = header.locator('[data-header-overflow]')
  await expect(panel).toHaveCSS('opacity', '0')
  await expect(panel.locator('[aria-label="Split right"]')).toHaveCount(1)
  await expect(header.locator('[aria-label="Split right"]')).toHaveCount(1)
})

test('hovering the header drops the hidden controls in a second row that works', async ({ page }) => {
  await squeezeLeft(page, 15)
  const header = page.locator('[data-leaf-id]').first().locator('.pane-header')
  const panel = header.locator('[data-header-overflow]')
  await header.hover({ position: { x: 60, y: 10 } })
  await expect(panel).toHaveCSS('opacity', '1')
  const h = (await header.boundingBox())!
  const p = (await panel.boundingBox())!
  expect(p.y).toBeGreaterThanOrEqual(h.y + h.height - 1)
  expect(p.width).toBeLessThanOrEqual(h.width + 1)

  await panel.getByRole('button', { name: 'Split right' }).click()
  await expect(page.locator('[data-leaf-id]')).toHaveCount(3)
})

test('clicking ⋯ pins the row open until Escape', async ({ page }) => {
  await squeezeLeft(page, 15)
  const header = page.locator('[data-leaf-id]').first().locator('.pane-header')
  const panel = header.locator('[data-header-overflow]')
  await header.getByLabel('Show hidden controls').click()
  await page.mouse.move(900, 500)
  await page.waitForTimeout(400)
  await expect(panel).toHaveCSS('opacity', '1')
  await page.keyboard.press('Escape')
  await expect(panel).toHaveCSS('opacity', '0')
})
