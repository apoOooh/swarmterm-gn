import { test, expect, type Page, type Locator } from '@playwright/test'
test.beforeEach(async ({ page }) => { await page.goto('/tests/fixtures/app.html'); await expect(page.locator('[data-leaf-id]')).toHaveCount(2) })

// Fixture: two plain panes side by side. dnd-kit needs a real pointer gesture
// (activation distance), so drags are driven step by step with the mouse.
// Grab the title span: it is the header's bare, draggable space. The header
// centre can land on a `data-no-dnd` chip (folder/shell) as buttons are added.
async function startDrag(page: Page, from: Locator): Promise<void> {
  const h = (await from.locator('.pane-header > span.flex-1').boundingBox())!
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2)
  await page.mouse.down()
  await page.mouse.move(h.x + h.width / 2 + 20, h.y + h.height / 2 + 20, { steps: 5 })
}

async function moveTo(page: Page, target: Locator): Promise<void> {
  const b = (await target.boundingBox())!
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 15 })
}

async function box(l: Locator) { return (await l.boundingBox())! }

test('dropping a pane on a dock tile of another pane splits that slot', async ({ page }) => {
  const [a, b] = [page.locator('[data-leaf-id]').nth(0), page.locator('[data-leaf-id]').nth(1)]
  const aId = await a.getAttribute('data-leaf-id')
  const bId = await b.getAttribute('data-leaf-id')
  await startDrag(page, a)
  await moveTo(page, b)
  const tile = b.locator('[title="Split: dragged pane bottom"]')
  await expect(tile).toBeVisible()
  await moveTo(page, tile)
  await page.screenshot({ path: 'test-results/dock-picker.png' })
  await page.mouse.up()

  const top = page.locator(`[data-leaf-id="${bId}"]`)
  const bottom = page.locator(`[data-leaf-id="${aId}"]`)
  const [t, u] = [await box(top), await box(bottom)]
  expect(Math.abs(t.x - u.x)).toBeLessThan(2) // stacked, same column
  expect(u.y).toBeGreaterThan(t.y + t.height - 2) // dragged pane below
  expect(await page.evaluate(() => (window as any).fixture.counters.killed)).toBe(0)
})

test('dropping on a snap-bar slot rearranges the workspace', async ({ page }) => {
  const a = page.locator('[data-leaf-id]').nth(0)
  const aId = await a.getAttribute('data-leaf-id')
  await startDrag(page, a)
  const stacked = page.locator('[title="Stacked"] > div')
  await expect(stacked).toHaveCount(2)
  await moveTo(page, stacked.nth(0))
  await page.screenshot({ path: 'test-results/snap-bar.png' })
  await page.mouse.up()

  const panes = page.locator('[data-leaf-id]')
  const [p0, p1] = [await box(panes.nth(0)), await box(panes.nth(1))]
  expect(Math.abs(p0.x - p1.x)).toBeLessThan(2)
  // Slot 0 of "Stacked" is the top one: the dragged pane is now on top.
  const dragged = await box(page.locator(`[data-leaf-id="${aId}"]`))
  expect(dragged.y).toBeLessThanOrEqual(Math.min(p0.y, p1.y))
  expect(await page.evaluate(() => (window as any).fixture.counters.killed)).toBe(0)
})

test('dropping on the swap centre still reorders, and the snap bar goes away', async ({ page }) => {
  const [a, b] = [page.locator('[data-leaf-id]').nth(0), page.locator('[data-leaf-id]').nth(1)]
  const aId = await a.getAttribute('data-leaf-id')
  await startDrag(page, a)
  await moveTo(page, b.getByText('Swap', { exact: true }))
  await page.mouse.up()
  await expect(page.locator('[data-leaf-id]').nth(1)).toHaveAttribute('data-leaf-id', aId!)
  await expect(page.locator('[title="Stacked"]')).toHaveCount(0)
})
