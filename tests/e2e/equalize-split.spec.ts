import { test, expect, type Page } from '@playwright/test'
test.beforeEach(async ({ page }) => { await page.goto('/tests/fixtures/app.html'); await expect(page.locator('[data-leaf-id]')).toHaveCount(2) })

// Fixture: two plain panes side by side, split by one vertical separator.
async function widths(page: Page): Promise<number[]> {
  const panes = page.locator('[data-leaf-id]')
  const n = await panes.count()
  const out: number[] = []
  for (let i = 0; i < n; i++) out.push((await panes.nth(i).boundingBox())!.width)
  return out
}

test('double-clicking a dragged separator evens the two panes out again', async ({ page }) => {
  const sep = page.locator('[data-separator]').first()
  const s = (await sep.boundingBox())!
  await page.mouse.move(s.x + s.width / 2, s.y + s.height / 2)
  await page.mouse.down()
  await page.mouse.move(s.x - 300, s.y + s.height / 2, { steps: 10 })
  await page.mouse.up()
  const [a, b] = await widths(page)
  expect(Math.abs(a - b)).toBeGreaterThan(200)

  await sep.dblclick()
  await expect.poll(async () => { const [x, y] = await widths(page); return Math.abs(x - y) }).toBeLessThan(3)
  expect(await page.evaluate(() => (window as any).fixture.counters.killed)).toBe(0)
})

test('double-clicking a corner handle evens out both directions of a 2x2 grid', async ({ page }) => {
  // Split each pane vertically → two columns of two, then skew every split.
  await page.evaluate(() => {
    const store = (window as any).fixture.useAppStore
    const ws = () => store.getState().workspaces.find((w: any) => w.id === store.getState().activeWorkspaceId)
    const leaves: string[] = []
    const walk = (n: any): void => { if (n.type === 'leaf') leaves.push(n.id); else n.children.forEach(walk) }
    walk(ws().layout)
    for (const id of leaves) store.getState().splitPane(id, 'vertical')
    const splits: string[] = []
    const walkS = (n: any): void => { if (n.type === 'split') { splits.push(n.id); n.children.forEach(walkS) } }
    walkS(ws().layout)
    for (const id of splits) store.getState().resizeSplitNode(id, [25, 75])
  })
  const panes = page.locator('[data-leaf-id]')
  await expect(panes).toHaveCount(4)

  const corner = page.locator('[data-corner-handle]').first()
  await expect(corner).toBeVisible()
  // Both columns' row splits sit at 25 %, so their handles overlap: click the
  // spot like a user would rather than one element.
  const c = (await corner.boundingBox())!
  await page.mouse.dblclick(c.x + c.width / 2, c.y + c.height / 2)

  // The corner touches the outer columns split and one column's rows split:
  // the columns end equal, and so do the two panes of that column.
  await expect.poll(async () => {
    const boxes = await Promise.all([0, 1, 2, 3].map(async (i) => (await panes.nth(i).boundingBox())!))
    const lefts = boxes.filter((b) => b.x < boxes[0].x + 2)
    const rights = boxes.filter((b) => b.x >= boxes[0].x + 2)
    const colDiff = Math.abs(lefts[0].width - rights[0].width)
    const rowDiffs = [lefts, rights].map((c) => Math.abs(c[0].height - c[1].height))
    return colDiff < 3 && Math.min(...rowDiffs) < 3
  }).toBe(true)
  expect(await page.evaluate(() => (window as any).fixture.counters.killed)).toBe(0)
})
