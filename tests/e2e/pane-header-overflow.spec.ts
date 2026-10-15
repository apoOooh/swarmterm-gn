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

test('clicking ⋯ pins the row open until ⋯ is clicked again', async ({ page }) => {
  await squeezeLeft(page, 15)
  const header = page.locator('[data-leaf-id]').first().locator('.pane-header')
  const panel = header.locator('[data-header-overflow]')
  await header.getByLabel('Show hidden controls').click()
  await page.mouse.move(900, 500)
  await page.waitForTimeout(400)
  await expect(panel).toHaveCSS('opacity', '1')
  await header.getByLabel('Show hidden controls').click()
  await page.mouse.move(900, 500)
  await expect(panel).toHaveCSS('opacity', '0')
})

function leftHeader(page: Page) { return page.locator('[data-leaf-id]').first().locator('.pane-header') }

test('a click outside unpins the row', async ({ page }) => {
  await squeezeLeft(page, 15)
  const panel = leftHeader(page).locator('[data-header-overflow]')
  await leftHeader(page).getByLabel('Show hidden controls').click()
  await expect(panel).toHaveCSS('opacity', '1')
  await page.mouse.click(900, 500)
  await expect(panel).toHaveCSS('opacity', '0')
})

test('Esc typed into the terminal leaves a pinned row open', async ({ page }) => {
  await squeezeLeft(page, 15)
  const panel = leftHeader(page).locator('[data-header-overflow]')
  await leftHeader(page).getByLabel('Show hidden controls').click()
  await page.locator('[data-leaf-id]').first().locator('.xterm-helper-textarea').focus()
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  await expect(panel).toHaveCSS('opacity', '1')
})

test('keyboard: Enter on ⋯ moves focus into the row, Esc hands it back to ⋯', async ({ page }) => {
  await squeezeLeft(page, 15)
  const header = leftHeader(page)
  const more = header.getByLabel('Show hidden controls')
  await more.focus()
  await page.keyboard.press('Enter')
  await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('[data-header-overflow]'))).toBe(true)
  await page.keyboard.press('Escape')
  await expect(more).toBeFocused()
  await expect(header.locator('[data-header-overflow]')).toHaveCSS('opacity', '0')
})

test('a menu opened from the row keeps it up after the mouse leaves', async ({ page }) => {
  await squeezeLeft(page, 15)
  const header = leftHeader(page)
  const panel = header.locator('[data-header-overflow]')
  await header.hover({ position: { x: 60, y: 10 } })
  await expect(panel).toHaveCSS('opacity', '1')
  await panel.getByRole('button', { name: /^Shell:/ }).click()
  await expect(page.getByRole('menu')).toBeVisible()
  await page.getByRole('menu').hover()
  await page.waitForTimeout(400)
  await expect(panel).toHaveCSS('opacity', '1')
})

test('widening clears a pin, so re-narrowing does not reopen the row', async ({ page }) => {
  await squeezeLeft(page, 15)
  const header = leftHeader(page)
  await header.getByLabel('Show hidden controls').click()
  await squeezeLeft(page, 50)
  await expect(header.getByLabel('Show hidden controls')).toHaveCount(0)
  await page.mouse.move(900, 500)
  await squeezeLeft(page, 15)
  await page.waitForTimeout(400)
  await expect(header.locator('[data-header-overflow]')).toHaveCSS('opacity', '0')
})

test('dragging another pane across a header does not drop the row', async ({ page }) => {
  await squeezeLeft(page, 15)
  const header = leftHeader(page)
  const other = page.locator('[data-leaf-id]').nth(1).locator('.pane-header')
  const o = (await other.boundingBox())!
  const h = (await header.boundingBox())!
  await page.mouse.move(o.x + o.width / 2, o.y + o.height / 2)
  await page.mouse.down()
  await page.mouse.move(h.x + 60, h.y + h.height / 2, { steps: 12 })
  await page.waitForTimeout(400)
  await expect(header.locator('[data-header-overflow]')).toHaveCSS('opacity', '0')
  await page.mouse.up()
})
