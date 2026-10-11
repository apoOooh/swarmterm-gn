// Attach only to an existing Dev WebView2. Test profiles and files remain isolated.
// Usage: node scripts/check-agent-accounts-native.mjs <existing test folder>
import { chromium } from 'playwright'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const cwd = process.argv[2]
assert(cwd && path.isAbsolute(cwd), 'Pass an existing absolute test folder.')
const testRoot = path.join(cwd, `account-check-${Date.now()}`)
await mkdir(testRoot, { recursive: true })
const browser = await chromium.connectOverCDP('http://127.0.0.1:9333')
const page = browser.contexts()[0].pages().find(page => /https?:\/\/(localhost|127\.0\.0\.1):1420/.test(page.url()))
assert(page, 'Dev page not found')
await page.waitForFunction(() => window.__swarmtermDev)
const accountIds = [], workspaceIds = [], savedIds = []
const before = await page.evaluate(async () => {
  const { useAppStore } = await import('/src/store/app-store.ts')
  return { active: useAppStore.getState().activeWorkspaceId, welcome: useAppStore.getState().welcomeFocused }
})
async function call(module, name, ...args) {
  return page.evaluate(async ({ module, name, args }) => (await import(module))[name](...args), { module, name, args })
}
try {
  const accounts = []
  for (const agentId of ['claude-code', 'codex']) {
    const configDir = path.join(testRoot, agentId).replaceAll('\\', '/')
    await mkdir(configDir, { recursive: true })
    const account = await call('/src/tauri/accounts.ts', 'saveAgentAccount', { agentId, name: `Native test ${agentId}`, configDir })
    assert.equal(account.agentId, agentId)
    assert.equal(account.configDir.toLowerCase().replaceAll('\\', '/'), configDir.toLowerCase())
    accountIds.push(account.id); accounts.push(account)
  }
  const renamed = await call('/src/tauri/accounts.ts', 'saveAgentAccount', { ...accounts[0], name: 'Native renamed profile' })
  assert.equal(renamed.id, accounts[0].id)
  assert((await call('/src/tauri/accounts.ts', 'listAgentAccounts')).some(account => account.id === renamed.id && account.name === renamed.name))
  await page.evaluate(async () => (await import('/src/store/agent-accounts-store.ts')).useAgentAccountsStore.getState().refresh())
  // Print only the profile path, never credential files or unrelated environment.
  for (const account of accounts) {
    const envName = account.agentId === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR'
    const workspace = await page.evaluate(async ({ account, cwd, envName }) => {
      const { useAppStore } = await import('/src/store/app-store.ts')
      const app = useAppStore.getState()
      app.createWorkspace({ cwd, terminalCount: 1, agentIds: [account.agentId], accountIds: [account.id], startupCommands: [`Write-Output ('SWA9_PROFILE=' + $env:${envName})`] })
      return useAppStore.getState().workspaces.at(-1)
    }, { account, cwd: testRoot.replaceAll('\\', '/'), envName })
    workspaceIds.push(workspace.id); savedIds.push(workspace.savedId)
    await page.waitForFunction(({ id, configDir }) => window.__swarmtermDev.terminalText(id, 100).toLowerCase().replaceAll('\\', '/').includes(`swa9_profile=${configDir.toLowerCase().replaceAll('\\', '/')}`), { id: workspace.layout.terminalId, configDir: account.configDir })
    const snapshot = await page.evaluate(async id => {
      const { flushSavedWorkspaces, useSavedWorkspacesStore } = await import('/src/store/saved-workspaces-store.ts')
      flushSavedWorkspaces()
      return useSavedWorkspacesStore.getState().entries.find(entry => entry.id === id)
    }, workspace.savedId)
    assert.equal(snapshot.layout.accountId, account.id)
    assert(!('startupCommand' in snapshot.layout))
    const inspected = await call('/src/tauri/sessions.ts', 'inspectSavedWorkspace', snapshot.cwd, [snapshot.layout])
    assert.equal(inspected.panes[0].accountAvailable, true)
    await page.evaluate(async id => {
      const { useAppStore } = await import('/src/store/app-store.ts')
      useAppStore.getState().closeWorkspace(id)
    }, workspace.id)
    await page.waitForFunction(id => !window.__swarmtermDev.workspaces().some(workspace => workspace.id === id), workspace.id)
    await page.evaluate(async id => (await import('/src/store/saved-workspaces-store.ts')).useSavedWorkspacesStore.getState().open(id), workspace.savedId)
    const restored = await page.evaluate(id => window.__swarmtermDev.workspaces().find(workspace => workspace.savedId === id), workspace.savedId)
    assert(restored)
    workspaceIds.push(restored.id)
    assert.equal(restored.layout.accountId, account.id)
    assert.notEqual(restored.layout.terminalId, workspace.layout.terminalId)
    await page.evaluate(async id => (await import('/src/store/app-store.ts')).useAppStore.getState().closeWorkspace(id), restored.id)
    await page.waitForFunction(id => !window.__swarmtermDev.workspaces().some(workspace => workspace.id === id), restored.id)
  }
  await call('/src/tauri/accounts.ts', 'deleteAgentAccount', accounts[1].id)
  await page.evaluate(async id => (await import('/src/store/saved-workspaces-store.ts')).useSavedWorkspacesStore.getState().open(id), savedIds[1])
  const fallback = await page.evaluate(async id => ({ workspace: window.__swarmtermDev.workspaces().find(workspace => workspace.savedId === id), notice: (await import('/src/store/saved-workspaces-store.ts')).useSavedWorkspacesStore.getState().notice }), savedIds[1])
  assert(fallback.workspace)
  workspaceIds.push(fallback.workspace.id)
  assert.equal(fallback.workspace.layout.accountId, undefined)
  assert.equal(fallback.workspace.layout.resumeSessionId, undefined)
  assert.match(fallback.notice, /saved account is no longer available/)
  console.log('Native accounts checks passed: profile CRUD, isolated PTY environment, profile-bound saved restore, deleted-profile fallback.')
  await writeFile(path.join(testRoot, 'result.json'), JSON.stringify({ passed: true, checks: ['CRUD', 'PTY environment', 'saved restore', 'deleted profile fallback'] }, null, 2))
} finally {
  for (const id of savedIds) await page.evaluate(async id => (await import('/src/store/saved-workspaces-store.ts')).useSavedWorkspacesStore.getState().forget(id), id)
  for (const id of workspaceIds) await page.evaluate(async id => (await import('/src/store/app-store.ts')).useAppStore.getState().closeWorkspace(id), id)
  for (const id of accountIds) await call('/src/tauri/accounts.ts', 'deleteAgentAccount', id)
  await page.evaluate(async before => {
    const { useAppStore } = await import('/src/store/app-store.ts')
    if (before.welcome) useAppStore.getState().openWelcome()
    else if (before.active) useAppStore.getState().setActiveWorkspace(before.active)
    await (await import('/src/store/agent-accounts-store.ts')).useAgentAccountsStore.getState().refresh()
  }, before)
  await browser.close()
}
