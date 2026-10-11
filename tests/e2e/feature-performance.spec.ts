import { expect, test } from '@playwright/test'

test('folder typing starts only the settled project scans and unchanged profile refreshes do not rescan', async ({ page }) => {
  await page.goto('/tests/fixtures/app.html?welcome=1')
  await expect(page.getByRole('heading', { name: 'Compose' })).toBeVisible()
  await expect.poll(() => page.evaluate(() => (window as any).fixture.counters.sessionFolders.length)).toBe(1)
  await page.evaluate(() => {
    const counters = (window as any).fixture.counters
    counters.sessionFolders.length = 0; counters.gitFolders.length = 0
  })
  const folder = page.getByPlaceholder('Choose a folder…')
  await folder.fill('')
  await folder.pressSequentially('/project/src', { delay: 20 })
  expect(await page.evaluate(() => (window as any).fixture.counters.sessionFolders)).toEqual([])
  await expect.poll(() => page.evaluate(() => (window as any).fixture.counters.sessionFolders)).toEqual(['/project/src'])
  expect(await page.evaluate(() => (window as any).fixture.counters.gitFolders)).toEqual(['/project/src'])
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  for (let i = 0; i < 3; i++) {
    await page.getByRole('button', { name: 'Accounts', exact: true }).click()
    await page.getByRole('button', { name: 'MCP', exact: true }).click()
  }
  await page.getByRole('button', { name: 'Close settings', exact: true }).click()
  // Give any accidental scan timer time to fire after repeated tab refreshes.
  await page.waitForTimeout(400)
  expect(await page.evaluate(() => (window as any).fixture.counters.sessionFolders)).toEqual(['/project/src'])
})

test('a multi-workspace macro probes profile and agent metadata once', async ({ page }) => {
  await page.goto('/tests/fixtures/app.html?welcome=1')
  await expect(page.getByRole('heading', { name: 'Compose' })).toBeVisible()
  await expect.poll(() => page.evaluate(() => (window as any).fixture.counters.sessionFolders.length)).toBe(1)
  await page.evaluate(async () => {
    const { useShortcutStore } = await import('/src/store/shortcut-store.ts' as string)
    const { requestAppAction } = await import('/src/lib/app-actions.ts' as string)
    const counters = (window as any).fixture.counters
    counters.accountReads = 0; counters.agentReads = 0
    const id = 'macro:11111111-2222-4333-8444-555555555555'
    useShortcutStore.getState().saveMacro({ id, name: 'Four workspaces', steps: Array.from({ length: 4 }, () => ({ type: 'workspace', agentIds: ['terminal'], cwd: '/project', accounts: 'default' })) })
    requestAppAction(id)
  })
  await expect.poll(() => page.evaluate(() => (window as any).fixture.counters.created)).toBe(4)
  expect(await page.evaluate(() => ({ accounts: (window as any).fixture.counters.accountReads, agents: (window as any).fixture.counters.agentReads }))).toEqual({ accounts: 1, agents: 1 })
})
