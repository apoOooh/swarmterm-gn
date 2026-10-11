import { test, expect, type Page } from '@playwright/test'

const key = 'swarmterm-saved-workspaces'
const sessionIds = [1, 2, 3, 4].map(n => `${String(n).repeat(8)}-2222-4333-8444-555555555555`)
const fixtureUrl = '/tests/fixtures/app.html?welcome=1'

async function createFour(page: Page) {
  await page.evaluate(() => {
    const app = (window as any).fixture.useAppStore.getState()
    app.createWorkspace({ cwd: '/project', terminalCount: 4, agentIds: ['claude-code', 'claude-code', 'codex', 'codex'], worktreeMode: true, paneWorktrees: [null, { path: '/worktree', branch: 'feature' }, null, null] })
    const ws = (window as any).fixture.useAppStore.getState().workspaces[0]
    app.renameWorkspace(ws.id, 'My swarm')
    app.resizeSplitNode(ws.layout.id, [33, 67])
  })
  await expect.poll(() => page.evaluate(() => (window as any).fixture.counters.created)).toBe(4)
  await page.evaluate(async ids => {
    const f = (window as any).fixture
    const leaves = (n: any): any[] => n.type === 'leaf' ? [n] : n.children.flatMap(leaves)
    const panes = leaves(f.useAppStore.getState().workspaces[0].layout)
    for (let i = 0; i < panes.length; i++) await f.emit('agent:session', { terminalId: panes[i].terminalId, agentId: panes[i].agentId, sessionId: ids[i], atMs: Date.now() })
  }, sessionIds)
  await expect.poll(() => page.evaluate(() => (window as any).fixture.useAppStore.getState().workspaces[0].layout.children.flatMap((n: any) => n.children).filter((n: any) => n.sessionId).length)).toBe(4)
}

test.beforeEach(async ({ page }) => { await page.goto(fixtureUrl); await expect(page.getByRole('heading', { name: 'Compose' })).toBeVisible() })

test('reload restores four exact conversations, layout and worktree without hook respawns', async ({ page }) => {
  await createFour(page)
  const original = await page.evaluate(() => (window as any).fixture.useAppStore.getState().workspaces[0])
  expect(await page.evaluate(() => (window as any).fixture.counters.created)).toBe(4)
  await page.evaluate(() => { const s = (window as any).fixture.useAppStore.getState(); s.closeWorkspace(s.workspaces[0].id) })
  await expect(page.getByRole('button', { name: 'Open saved workspace My swarm' })).toBeVisible()
  expect(await page.evaluate(k => JSON.parse(localStorage.getItem(k)!).workspaces[0].layout.sizes, key)).toEqual(original.layout.sizes)
  await page.reload()
  await page.getByRole('button', { name: 'Open saved workspace My swarm' }).click()
  await expect.poll(() => page.evaluate(() => (window as any).fixture.counters.created)).toBe(4)
  const spawns = await page.evaluate(() => (window as any).fixture.counters.spawns)
  expect(spawns.map((s: any) => s.initialCommand)).toEqual(sessionIds.map((id, i) => i < 2 ? `claude --resume ${id} --permission-mode default` : `codex resume ${id} -s workspace-write -a on-request`))
  expect(spawns.map((s: any) => s.cwd)).toEqual(['/project', '/worktree', '/project', '/project'])
  const restored = await page.evaluate(() => (window as any).fixture.useAppStore.getState().workspaces[0])
  expect(restored.savedId).toBe(original.savedId)
  expect(restored.id).not.toBe(original.id)
  expect(restored.layout.id).not.toBe(original.layout.id)
  expect(restored.layout.sizes).toEqual(original.layout.sizes)
  expect(restored.worktreeMode).toBe(true)
  await page.evaluate(() => (window as any).fixture.useAppStore.getState().openWelcome())
  await page.getByRole('button', { name: 'Open saved workspace My swarm' }).click()
  expect(await page.evaluate(() => (window as any).fixture.useAppStore.getState().workspaces.length)).toBe(1)
  expect(await page.evaluate(() => (window as any).fixture.counters.created)).toBe(4)
})

test('rename and forget leave the live terminals running and prevent re-saving', async ({ page }) => {
  await createFour(page)
  await expect.poll(() => page.evaluate(k => JSON.parse(localStorage.getItem(k) ?? '{"workspaces":[]}').workspaces.length, key)).toBe(1)
  await page.evaluate(() => (window as any).fixture.useAppStore.getState().openWelcome())
  await page.getByRole('button', { name: 'Rename saved workspace My swarm' }).click()
  await page.getByRole('textbox', { name: 'Rename My swarm' }).fill('Renamed swarm')
  await page.getByRole('textbox', { name: 'Rename My swarm' }).press('Enter')
  await page.getByRole('button', { name: 'Rename saved workspace Renamed swarm' }).click()
  await page.getByRole('textbox', { name: 'Rename Renamed swarm' }).fill('Cancelled name')
  await page.getByRole('textbox', { name: 'Rename Renamed swarm' }).press('Escape')
  await expect(page.getByRole('button', { name: 'Open saved workspace Renamed swarm' })).toBeVisible()
  await page.getByRole('button', { name: 'Forget saved workspace Renamed swarm' }).click()
  await expect(page.getByRole('region', { name: 'Saved workspaces' })).toHaveCount(0)
  expect(await page.evaluate(() => (window as any).fixture.counters.killed)).toBe(0)
  await page.evaluate(() => { const app = (window as any).fixture.useAppStore.getState(); app.renameWorkspace(app.workspaces[0].id, 'Still live'); app.closeWorkspace(app.workspaces[0].id) })
  expect(await page.evaluate(k => JSON.parse(localStorage.getItem(k)!).workspaces, key)).toEqual([])
  await page.reload()
  await expect(page.getByRole('region', { name: 'Saved workspaces' })).toHaveCount(0)
})

test('missing root aborts; missing worktree, session and CLI degrade with visible warnings', async ({ page }) => {
  await createFour(page)
  await page.evaluate(() => { const app = (window as any).fixture.useAppStore.getState(); app.closeWorkspace(app.workspaces[0].id) })
  await page.reload()
  await expect(page.getByRole('button', { name: 'Open saved workspace My swarm' })).toBeVisible()
  await page.evaluate(() => { delete (window as any).fixture.files['/project'] })
  await page.getByRole('button', { name: 'Open saved workspace My swarm' }).click()
  await expect(page.getByRole('alert')).toContainText('Working folder is unavailable')
  expect(await page.evaluate(() => (window as any).fixture.counters.created)).toBe(0)
  await page.reload()
  await expect(page.getByRole('button', { name: 'Open saved workspace My swarm' })).toBeVisible()
  await page.evaluate(id => { const f = (window as any).fixture; delete f.files['/worktree']; f.missingSessions.add(id); f.unavailableAgents.add('codex') }, sessionIds[0])
  await page.getByRole('button', { name: 'Open saved workspace My swarm' }).click()
  await expect.poll(() => page.evaluate(() => (window as any).fixture.counters.created)).toBe(4)
  await expect(page.getByRole('alert')).toContainText('missing pane folder')
  await expect(page.getByRole('alert')).toContainText('session is no longer available')
  await expect(page.getByRole('alert')).toContainText('unavailable agent')
  const spawns = await page.evaluate(() => (window as any).fixture.counters.spawns)
  expect(spawns.map((s: any) => s.cwd)).toEqual(Array(4).fill('/project'))
  expect(spawns.map((s: any) => s.initialCommand)).toEqual(['claude --permission-mode default', 'claude --permission-mode default', undefined, undefined])
})
