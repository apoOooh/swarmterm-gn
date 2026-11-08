import { expect, test } from '@playwright/test'

test('profile management drives account-aware composition and isolated login', async ({ page }) => {
  await page.goto('/tests/fixtures/app.html?welcome=1')
  await expect(page.getByRole('heading', { name: 'Compose' })).toBeVisible()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: 'Accounts', exact: true }).click()
  await page.getByRole('button', { name: 'Add account', exact: true }).click()
  await page.getByRole('button', { name: /^Claude Code/ }).click()
  await page.getByRole('textbox', { name: 'Account name', exact: true }).fill('Team account')
  await page.getByRole('button', { name: 'Continue & log in', exact: true }).click()
  // The wizard saves the profile and opens its login pane in one step.
  await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => (window as any).fixture.counters.created)).toBe(1)
  const profile = await page.evaluate(() => (window as any).fixture.accounts[0])
  expect(Object.keys(profile).sort()).toEqual(['agentId', 'configDir', 'id', 'name'])
  expect(await page.evaluate(() => (window as any).fixture.counters.spawns.at(-1))).toMatchObject({ accountId: profile.id, agentId: 'claude-code', initialCommand: 'claude auth login' })
  await page.getByRole('button', { name: 'New workspace', exact: true }).first().click()
  await page.getByRole('button', { name: '4', exact: true }).click()
  await page.getByRole('spinbutton', { name: 'Claude Code count', exact: true }).fill('4')
  await page.getByRole('combobox', { name: 'Claude Code account', exact: true }).selectOption('__round-robin__')
  await page.getByRole('button', { name: /^Create workspace/ }).click()
  await expect.poll(() => page.evaluate(() => (window as any).fixture.counters.created)).toBe(5)
  expect(await page.evaluate(() => (window as any).fixture.counters.spawns.slice(1).map((spawn: any) => spawn.accountId))).toEqual([undefined, profile.id, undefined, profile.id])
})

test('a split pane follows the workspace account and can switch before its first turn', async ({ page }) => {
  await page.goto('/tests/fixtures/app.html?welcome=1')
  await expect(page.getByRole('heading', { name: 'Compose' })).toBeVisible()
  await page.evaluate(async () => {
    const f = (window as any).fixture
    f.accounts.push({ id: 'claude-a', name: 'Alpha', agentId: 'claude-code', configDir: '/accounts/a' }, { id: 'claude-b', name: 'Beta', agentId: 'claude-code', configDir: '/accounts/b' })
    await f.useAgentAccountsStore.getState().refresh()
    const app = f.useAppStore.getState()
    app.createWorkspace({ cwd: '/project', terminalCount: 1, agentIds: ['claude-code'], accountIds: ['claude-b'], accountSelections: { 'claude-code': { mode: 'fixed', accountId: 'claude-b' } } })
    const ws = f.useAppStore.getState().workspaces[0]
    app.splitPane(ws.focusedLeafId, 'horizontal', 'claude-code')
  })
  await expect.poll(() => page.evaluate(() => (window as any).fixture.counters.spawns.map((s: any) => s.accountId))).toEqual(['claude-b', 'claude-b'])
  // Claude reports its session id at startup, before any transcript exists.
  const terminalId = await page.evaluate(() => {
    const ws = (window as any).fixture.useAppStore.getState().workspaces[0]
    const walk = (n: any): any[] => n.type === 'leaf' ? [n] : n.children.flatMap(walk)
    const leaf = walk(ws.layout).find((l: any) => l.id === ws.focusedLeafId)
    ;(window as any).fixture.useAppStore.getState().recordPaneSession(leaf.terminalId, 'claude-code', '11111111-2222-4333-8444-555555555555')
    return leaf.terminalId
  })
  await page.getByRole('button', { name: 'Account: Beta', exact: true }).last().click()
  await page.getByRole('menuitem', { name: 'Alpha', exact: true }).click()
  // Nothing to carry, so the pane restarts fresh on the new account (the
  // fixture never reports the old pty's exit, so the restart stops at the kill).
  await expect.poll(() => page.evaluate(() => (window as any).fixture.counters.killed)).toBe(1)
  const switched = await page.evaluate((id) => {
    const ws = (window as any).fixture.useAppStore.getState().workspaces[0]
    const walk = (n: any): any[] => n.type === 'leaf' ? [n] : n.children.flatMap(walk)
    return walk(ws.layout).find((l: any) => l.terminalId === id)
  }, terminalId)
  expect(switched).toMatchObject({ accountId: 'claude-a' })
  expect(switched.resumeSessionId).toBeUndefined()
  expect(await page.evaluate(() => (window as any).fixture.counters.transfers)).toEqual(['11111111-2222-4333-8444-555555555555:claude-b->claude-a'])
})

test('removed account restores fresh with warning and retains no wrong-account session', async ({ page }) => {
  await page.goto('/tests/fixtures/app.html?welcome=1')
  await expect(page.getByRole('heading', { name: 'Compose' })).toBeVisible()
  await page.evaluate(async () => {
    const account = { id: 'profile-test', name: 'Test', agentId: 'codex', configDir: '/accounts/test' }
    ;(window as any).fixture.accounts.push(account)
    const app = (window as any).fixture.useAppStore.getState()
    app.createWorkspace({ cwd: '/project', terminalCount: 1, agentIds: ['codex'], accountIds: [account.id] })
    const workspace = (window as any).fixture.useAppStore.getState().workspaces[0]
    app.renameWorkspace(workspace.id, 'Account conversation')
    app.recordPaneSession(workspace.layout.terminalId, 'codex', '11111111-2222-4333-8444-555555555555')
    app.closeWorkspace(workspace.id)
    ;(window as any).fixture.accounts.splice(0)
  })
  await page.getByRole('button', { name: 'Open saved workspace Account conversation', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('saved account is no longer available')
  const spawn = await page.evaluate(() => (window as any).fixture.counters.spawns.at(-1))
  expect(spawn.accountId).toBeUndefined()
  expect(spawn.initialCommand).not.toContain('resume')
})
