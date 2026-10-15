import { test, expect, type Page } from '@playwright/test'
test.beforeEach(async ({ page }) => { await page.goto('/tests/fixtures/app.html'); await expect(page.locator('[data-leaf-id]')).toHaveCount(2) })

async function squeezeLeft(page: Page, pct: number): Promise<void> {
  await page.evaluate((p) => {
    const store = (window as any).fixture.useAppStore
    const ws = store.getState().workspaces.find((w: any) => w.id === store.getState().activeWorkspaceId)
    store.getState().resizeSplitNode(ws.layout.id, [p, 100 - p])
  }, pct)
}
async function titleBarSettings(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: 'Title bar', exact: true }).click()
}
const leftHeader = (page: Page) => page.locator('[data-leaf-id]').first().locator('.pane-header')
const closeSettings = (page: Page) => page.getByRole('button', { name: 'Close settings' }).click()
// A control is "in the row" when a copy exists outside the overflow panel.
const inRow = (page: Page, label: string) =>
  leftHeader(page).locator(`[aria-label="${label}"]:not([data-header-overflow] *)`)

test('making an item core keeps it in a narrow header, and it persists', async ({ page }) => {
  await squeezeLeft(page, 15)
  await expect(inRow(page, 'Split right')).toHaveCount(0)

  await titleBarSettings(page)
  await page.getByRole('radio', { name: 'Split right: Core' }).click()
  await expect(page.getByRole('radio', { name: 'Split right: Core' })).toHaveAttribute('aria-checked', 'true')
  await closeSettings(page)
  await expect(inRow(page, 'Split right')).toHaveCount(1)

  await page.reload()
  await expect(page.locator('[data-leaf-id]')).toHaveCount(2)
  await squeezeLeft(page, 15)
  await expect(inRow(page, 'Split right')).toHaveCount(1)
})

test('reordering moves the item in the header', async ({ page }) => {
  const header = leftHeader(page)
  const xOf = async (label: string) => (await header.locator(`[aria-label="${label}"]`).first().boundingBox())!.x
  expect(await xOf('Split down')).toBeGreaterThan(await xOf('Split right'))

  await titleBarSettings(page)
  await page.getByRole('button', { name: 'Move Split down up' }).click()
  const rows = page.locator('[data-title-bar-items] > li')
  const ids = await rows.evaluateAll(els => els.map(e => e.getAttribute('data-item-id')))
  expect(ids.indexOf('split-down')).toBeLessThan(ids.indexOf('split-right'))
  await closeSettings(page)
  expect(await xOf('Split down')).toBeLessThan(await xOf('Split right'))
})

test('the title cannot be made optional; reset restores defaults', async ({ page }) => {
  await titleBarSettings(page)
  await expect(page.getByRole('radio', { name: 'Title: Off' })).toBeDisabled()
  await page.getByRole('radio', { name: 'Shell: Off' }).click()
  await page.getByRole('button', { name: 'Move Move to drawer up' }).click()
  await page.getByRole('button', { name: 'Reset to defaults' }).click()
  await expect(page.getByRole('radio', { name: 'Shell: Can hide' })).toHaveAttribute('aria-checked', 'true')
  const ids = await page.locator('[data-title-bar-items] > li').evaluateAll(els => els.map(e => e.getAttribute('data-item-id')))
  expect(ids.slice(-2)).toEqual(['float', 'drawer'])
})

test('after reordering, the lower of two optional items collapses first', async ({ page }) => {
  await titleBarSettings(page)
  // Drawer to the very top: it now outranks every other optional control.
  for (let i = 0; i < 14; i++) await page.getByRole('button', { name: 'Move Move to drawer up' }).click()
  await closeSettings(page)
  // Wide enough for some optional controls, not all: the drawer must be among
  // the survivors while the shell (now below it) is already gone.
  await squeezeLeft(page, 25)
  await expect(leftHeader(page).getByLabel('Show hidden controls')).toBeVisible()
  await expect(inRow(page, 'Move to drawer')).toHaveCount(1)
  await expect(leftHeader(page).locator('[aria-label^="Shell:"]:not([data-header-overflow] *)')).toHaveCount(0)
})

test('dragging a row by its grip reorders it', async ({ page }) => {
  await titleBarSettings(page)
  const grip = page.getByRole('button', { name: 'Drag Move to drawer' })
  await grip.scrollIntoViewIfNeeded()
  const target = page.locator('[data-item-id="split-down"]')
  const g = (await grip.boundingBox())!
  const t = (await target.boundingBox())!
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2)
  await page.mouse.down()
  await page.mouse.move(t.x + 20, t.y + 4, { steps: 20 })
  await page.mouse.up()
  const ids = await page.locator('[data-title-bar-items] > li').evaluateAll(els => els.map(e => e.getAttribute('data-item-id')))
  expect(ids.indexOf('drawer')).toBeLessThan(ids.indexOf('split-down'))
})

test('"⋯ only" keeps an item out of a wide header but reachable in the second row', async ({ page }) => {
  await titleBarSettings(page)
  await page.getByRole('radio', { name: 'Split right: ⋯ only' }).click()
  await closeSettings(page)
  const header = leftHeader(page)
  await expect(inRow(page, 'Split right')).toHaveCount(0)
  await header.hover({ position: { x: 60, y: 10 } })
  const panel = header.locator('[data-header-overflow]')
  await expect(panel).toHaveCSS('opacity', '1')
  await panel.getByRole('button', { name: 'Split right' }).click()
  await expect(page.locator('[data-leaf-id]')).toHaveCount(3)
})

test('"Off" removes an item from the header entirely', async ({ page }) => {
  await titleBarSettings(page)
  await page.getByRole('radio', { name: 'Handoff brief: Off' }).click()
  await closeSettings(page)
  await expect(leftHeader(page).locator('[aria-label="Handoff brief"]')).toHaveCount(0)
  await squeezeLeft(page, 15)
  await expect(leftHeader(page).locator('[aria-label="Handoff brief"]')).toHaveCount(0)
})

test('the visibility group works with arrow keys (one Tab stop)', async ({ page }) => {
  await titleBarSettings(page)
  const auto = page.getByRole('radio', { name: 'Shell: Can hide' })
  await expect(page.getByRole('radio', { name: 'Shell: Core' })).toHaveAttribute('tabindex', '-1')
  await auto.focus()
  await page.keyboard.press('ArrowRight')
  const only = page.getByRole('radio', { name: 'Shell: ⋯ only' })
  await expect(only).toHaveAttribute('aria-checked', 'true')
  await expect(only).toBeFocused()
  await page.keyboard.press('ArrowLeft')
  await expect(auto).toHaveAttribute('aria-checked', 'true')
})
