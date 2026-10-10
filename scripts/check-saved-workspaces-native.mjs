// Against a user-started Dev app. Connects to its existing WebView2 only.
// Usage: node scripts/check-saved-workspaces-native.mjs <existing folder>
import { chromium } from 'playwright'
import assert from 'node:assert/strict'

const cwd = process.argv[2]
if (!cwd) throw new Error('Pass an existing folder for the native workspace test.')
const browser = await chromium.connectOverCDP('http://127.0.0.1:9333').catch(() => {
  throw new Error('Dev app unavailable on port 9333. Start it before running this check.')
})
const page = browser.contexts()[0].pages().find(p => /https?:\/\/(localhost|127\.0\.0\.1):1420/.test(p.url()))
assert(page, 'Swarmterm Dev page not found')
await page.waitForFunction(() => window.__swarmtermDev)
const workspaces = () => page.evaluate(() => window.__swarmtermDev.workspaces())
const name = `Saved workspace check ${Date.now()}`
const before = new Set((await workspaces()).map(w => w.id))
const key = 'swarmterm-saved-workspaces'
const savedCard = id => page.locator(`[data-saved-workspace-id="${id}"]`)

async function welcome() {
  const tab = page.getByText('Welcome', { exact: true }).first()
  if (await tab.isVisible().catch(() => false)) await tab.click()
  else await page.getByRole('button', { name: 'New workspace' }).first().click()
  await page.getByPlaceholder('Choose a folder…').waitFor()
}

try {
  await welcome()
  await page.getByPlaceholder('Choose a folder…').fill(cwd)
  await page.getByPlaceholder('Choose a folder…').press('Tab')
  for (const field of await page.locator('input[type="number"]:enabled').all()) await field.fill('0')
  await page.getByRole('button', { name: '2', exact: true }).click()
  await page.getByRole('button', { name: 'Create workspace', exact: true }).click()
  await page.waitForFunction(ids => window.__swarmtermDev.workspaces().some(w => !ids.includes(w.id)), [...before])
  const original = (await workspaces()).find(w => !before.has(w.id))
  assert(original.savedId)
  await page.waitForFunction(id => JSON.parse(localStorage.getItem('swarmterm-saved-workspaces') ?? '{"workspaces":[]}').workspaces.some(w => w.id === id), original.savedId)
  await welcome()
  await savedCard(original.savedId).getByRole('button', { name: `Rename saved workspace ${original.name}`, exact: true }).click()
  const input = page.getByRole('textbox', { name: `Rename ${original.name}`, exact: true })
  await input.fill(name); await input.press('Enter')
  await page.evaluate(id => window.__swarmtermDev.closeWorkspace(id), original.id)
  await page.waitForFunction(id => !window.__swarmtermDev.workspaces().some(w => w.id === id), original.id)
  const saved = await page.evaluate(([key, id]) => JSON.parse(localStorage.getItem(key)).workspaces.find(w => w.id === id), [key, original.savedId])
  await page.getByRole('button', { name: `Open saved workspace ${name}`, exact: true }).click()
  await page.waitForFunction(id => window.__swarmtermDev.workspaces().some(w => w.savedId === id), original.savedId)
  const restored = (await workspaces()).find(w => w.savedId === original.savedId)
  assert.notEqual(restored.id, original.id)
  assert.equal(restored.cwd, original.cwd)
  assert.deepEqual(restored.layout.sizes, saved.layout.sizes)
  assert.notEqual(restored.layout.children[0].terminalId, original.layout.children[0].terminalId)
  await welcome()
  await page.getByRole('button', { name: `Open saved workspace ${name}`, exact: true }).click()
  assert.equal((await workspaces()).filter(w => w.savedId === original.savedId).length, 1)
  await welcome()
  await page.getByRole('button', { name: `Forget saved workspace ${name}`, exact: true }).click()
  assert((await workspaces()).some(w => w.id === restored.id), 'Forget must leave the workspace alive')
  await page.evaluate(id => window.__swarmtermDev.closeWorkspace(id), restored.id)
  assert(!(await page.evaluate(key => JSON.parse(localStorage.getItem(key)).workspaces, key)).some(w => w.id === original.savedId))
  console.log('Native saved-workspace checks passed: real PTYs, restore, rename, focus, forget.')
} finally {
  // Remove only workspaces created by this check; leave the user's app running.
  for (const ws of await workspaces()) {
    if (!before.has(ws.id)) {
      await welcome()
      const card = savedCard(ws.savedId).getByRole('button', { name: `Forget saved workspace ${ws.name}`, exact: true })
      if (await card.isVisible()) await card.click()
      await page.evaluate(id => window.__swarmtermDev.closeWorkspace(id), ws.id)
    }
  }
  await browser.close()
}
