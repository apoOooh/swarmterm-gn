import { test, expect } from '@playwright/test'

const fixtureUrl = '/tests/fixtures/app.html?welcome=1'

test.beforeEach(async ({ page }) => {
  await page.goto(fixtureUrl)
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Compose' })).toBeVisible()
})

test('save as default prefills the next composer', async ({ page }) => {
  await page.getByPlaceholder('Choose a folder…').fill('/default/project')
  await page.getByRole('button', { name: '4', exact: true }).click()
  await page.getByRole('button', { name: 'Save as default' }).click()
  await expect(page.getByText('Saved as default')).toBeVisible()

  await page.reload()
  await expect(page.getByRole('heading', { name: 'Compose' })).toBeVisible()
  await expect(page.getByPlaceholder('Choose a folder…')).toHaveValue('/default/project')
  await expect(page.getByRole('button', { name: '4', exact: true })).toHaveAttribute('aria-pressed', 'true')
})

test('save as template, then pick it in a new composer', async ({ page }) => {
  await page.getByRole('button', { name: '6', exact: true }).click()
  await page.getByRole('button', { name: 'Save as template…' }).click()
  await page.getByRole('textbox', { name: 'Template name' }).fill('Six pack')
  await page.getByRole('button', { name: 'Save', exact: true }).click()

  await page.reload()
  await expect(page.getByRole('heading', { name: 'Compose' })).toBeVisible()
  await expect(page.getByRole('button', { name: '2', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await page.getByRole('combobox', { name: 'Workspace template' }).selectOption({ label: 'Six pack' })
  await expect(page.getByRole('button', { name: '6', exact: true })).toHaveAttribute('aria-pressed', 'true')

  // Same name again offers to overwrite instead of duplicating.
  await page.getByRole('button', { name: 'Save as template…' }).click()
  await page.getByRole('textbox', { name: 'Template name' }).fill('six PACK')
  await expect(page.getByRole('button', { name: 'Overwrite' })).toBeVisible()
})

test('overwrite replaces a template', async ({ page }) => {
  await page.getByRole('button', { name: 'Save as template…' }).click()
  await page.getByRole('textbox', { name: 'Template name' }).fill('Mine')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await page.getByRole('button', { name: '8', exact: true }).click()
  await page.getByRole('button', { name: 'Save as template…' }).click()
  await page.getByRole('textbox', { name: 'Template name' }).fill('MINE')
  await page.getByRole('button', { name: 'Overwrite' }).click()
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('swarmterm.workspaceTemplates')!).templates)
  expect(stored.map((t: any) => [t.name, t.terminalCount])).toEqual([['Mine', 8]])
})


test('Settings → Workspaces edits defaults and manages templates', async ({ page }) => {
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true })
  await dialog.getByRole('button', { name: 'Workspaces' }).click()

  // Spaces survive typing (the field saves on every keystroke).
  await dialog.getByRole('textbox', { name: 'Working folder' }).pressSequentially('C:/My Projects')
  await dialog.getByRole('button', { name: '6', exact: true }).first().click()
  let defaults = await page.evaluate(() => JSON.parse(localStorage.getItem('swarmterm.workspaceDefaults')!))
  expect([defaults.folder, defaults.terminalCount]).toEqual(['C:/My Projects', 6])
  await dialog.getByRole('button', { name: 'Reset to built-in' }).click()
  defaults = await page.evaluate(() => JSON.parse(localStorage.getItem('swarmterm.workspaceDefaults')!))
  expect([defaults.folder, defaults.terminalCount]).toEqual(['', 2])

  await dialog.getByRole('button', { name: 'Add template' }).click()
  await dialog.getByRole('textbox', { name: 'Template name' }).fill('Review')
  await dialog.getByRole('button', { name: 'Save template' }).click()
  await expect(dialog.getByText('Review', { exact: true })).toBeVisible()

  await dialog.getByRole('button', { name: 'Edit Review' }).click()
  await dialog.getByRole('textbox', { name: 'Template name' }).fill('Review 2')
  await dialog.getByRole('button', { name: 'Save template' }).click()
  await dialog.getByRole('button', { name: 'Duplicate Review 2' }).click()
  await expect(dialog.getByText('Review 2 copy', { exact: true })).toBeVisible()

  await dialog.getByRole('button', { name: 'Delete Review 2', exact: true }).click()
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click()
  const names = await page.evaluate(() => JSON.parse(localStorage.getItem('swarmterm.workspaceTemplates')!).templates.map((t: any) => t.name))
  expect(names).toEqual(['Review 2 copy'])
})

test('the composer lists only installed agents', async ({ page }) => {
  await expect(page.getByRole('button', { name: 'Add one Codex' })).toBeVisible()
  await page.evaluate(() => {
    const f = (window as any).fixture
    f.unavailableAgents.add('codex')
    // Remount the composer so it re-probes the installed CLIs.
    f.useAppStore.getState().createWorkspace({ cwd: '/project', terminalCount: 1, agentIds: ['terminal'] })
  })
  await expect(page.getByRole('heading', { name: 'Compose' })).toHaveCount(0)
  await page.evaluate(() => (window as any).fixture.useAppStore.getState().openWelcome())
  await expect(page.getByRole('button', { name: 'Add one Claude Code' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Add one Codex' })).toHaveCount(0)
  await expect(page.getByText('Not installed')).toHaveCount(0)
})

test('an agent found missing after the composer opens is neither counted nor spawned', async ({ page }) => {
  await page.evaluate(() => localStorage.setItem('swarmterm.workspaceDefaults', JSON.stringify({ folder: '/project', terminalCount: 2, agentCounts: { codex: 1 }, accountSelections: {}, isolateWorktrees: false, splitAgent: '' })))
  await page.reload()
  await expect(page.getByRole('button', { name: 'Add one Codex' })).toBeVisible()
  await page.evaluate(() => {
    const f = (window as any).fixture
    f.unavailableAgents.add('codex')
    f.useAppStore.getState().createWorkspace({ cwd: '/project', terminalCount: 1, agentIds: ['terminal'] })
  })
  await expect(page.getByRole('heading', { name: 'Compose' })).toHaveCount(0)
  // The composer mounts with the cached "codex installed" answer; the re-probe flips it.
  await page.evaluate(() => (window as any).fixture.useAppStore.getState().openWelcome())
  await expect(page.getByRole('button', { name: 'Add one Codex' })).toHaveCount(0)
  await expect(page.getByText('used 0 / 2')).toBeVisible()
  await page.getByRole('button', { name: 'Create workspace' }).click()
  const agents = await page.evaluate(() => {
    const ws = (window as any).fixture.useAppStore.getState().workspaces
    const leaves = (n: any): any[] => n.type === 'leaf' ? [n] : n.children.flatMap(leaves)
    return leaves(ws[ws.length - 1].layout).map((l: any) => l.agentId)
  })
  expect(agents).toEqual(['terminal', 'terminal'])
})

test('Settings editor drops counts of uninstalled agents instead of hiding them', async ({ page }) => {
  await page.evaluate(() => localStorage.setItem('swarmterm.workspaceDefaults', JSON.stringify({ folder: '', terminalCount: 2, agentCounts: { codex: 2 }, accountSelections: {}, isolateWorktrees: false, splitAgent: '' })))
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Compose' })).toBeVisible()
  await page.evaluate(() => {
    const f = (window as any).fixture
    f.unavailableAgents.add('codex')
    f.useAppStore.getState().createWorkspace({ cwd: '/project', terminalCount: 1, agentIds: ['terminal'] })
  })
  await expect(page.getByRole('heading', { name: 'Compose' })).toHaveCount(0)
  await page.evaluate(() => (window as any).fixture.useAppStore.getState().openWelcome())
  await expect(page.getByRole('button', { name: 'Add one Codex' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true })
  await dialog.getByRole('button', { name: 'Workspaces' }).click()
  await expect(dialog.getByText('used 0 / 2')).toBeVisible()
  await dialog.getByRole('button', { name: 'Add one Claude Code' }).click()
  const defaults = await page.evaluate(() => JSON.parse(localStorage.getItem('swarmterm.workspaceDefaults')!))
  expect(defaults.agentCounts).toEqual({ 'claude-code': 1 })
})
