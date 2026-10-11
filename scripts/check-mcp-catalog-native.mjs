// Uses an existing Dev WebView2; no CLI server starts, downloads or login.
import { chromium } from 'playwright'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const temporaryRoot = path.join(workspace, 'tmp')
await fs.mkdir(temporaryRoot, { recursive: true })
const testRoot = await fs.mkdtemp(path.join(temporaryRoot, 'swa11-catalog-'))
assert(testRoot.startsWith(temporaryRoot + path.sep))
const browser = await chromium.connectOverCDP('http://127.0.0.1:9333')
const page = browser.contexts()[0].pages().find(page => /https?:\/\/(localhost|127\.0\.0\.1):1420/.test(page.url()))
assert(page, 'Dev page unavailable')
const accounts = []
const foreign = 'catalogue-private-test-value'
const ipc = (command, args) => page.evaluate(async ({ command, args }) => {
  const { invoke } = await import('/node_modules/@tauri-apps/api/core.js')
  return invoke(command, args)
}, { command, args })

try {
  for (const agentId of ['claude-code', 'codex']) {
    const configDir = path.join(testRoot, agentId)
    await fs.mkdir(configDir)
    const account = await ipc('save_agent_account', { account: { agentId, name: `SWA-11 catalogue ${agentId}`, configDir } })
    accounts.push(account)
    const configPath = path.join(configDir, agentId === 'codex' ? 'config.toml' : '.claude.json')
    // Own isolated fixtures only; enrollment created files in this directory.
    const existing = await fs.readFile(configPath, 'utf8')
    if (agentId === 'codex') await fs.writeFile(configPath, existing + `\n# foreign preserved\n[mcp_servers.foreign]\ncommand = "foreign"\nsecret = "${foreign}"\n`)
    else {
      const config = JSON.parse(existing)
      config.mcpServers.foreign = { command: 'foreign', env: { TOKEN: foreign } }
      await fs.writeFile(configPath, JSON.stringify(config, null, 2))
    }
    const args = { agentId, accountId: account.id }
    await assert.rejects(() => ipc('configure_account_mcp', { agentId: agentId === 'codex' ? 'claude-code' : 'codex', accountId: account.id, entryId: 'github', directories: [] }))
    await ipc('configure_account_mcp', { ...args, entryId: 'github', directories: [] })
    const first = await fs.readFile(configPath, 'utf8')
    assert(first.includes('https://api.githubcopilot.com/mcp/'))
    assert(first.includes(foreign), 'Foreign config must survive')
    await ipc('configure_account_mcp', { ...args, entryId: 'github', directories: [] })
    assert.equal(await fs.readFile(configPath, 'utf8'), first, 'Idempotent writes preserve bytes')
    const status = await ipc('inspect_account_mcp', args)
    assert.equal(status.entries.find(entry => entry.id === 'github').status, 'configured')
    assert(!JSON.stringify(status).includes(foreign))
    await assert.rejects(() => ipc('configure_account_mcp', { ...args, entryId: 'filesystem', directories: [path.join(testRoot, 'missing')] }))
    assert.equal(await fs.readFile(configPath, 'utf8'), first)
    await ipc('configure_account_mcp', { ...args, entryId: 'filesystem', directories: [testRoot] })
    const filesystemStatus = await ipc('inspect_account_mcp', args)
    assert.equal(filesystemStatus.entries.find(entry => entry.id === 'filesystem').status, 'configured')
    // Same name belongs to user now: typed command must refuse overwriting.
    const installed = await fs.readFile(configPath, 'utf8')
    await fs.writeFile(configPath, installed.replace('https://api.githubcopilot.com/mcp/', 'https://example.invalid/owned'))
    const collision = await fs.readFile(configPath, 'utf8')
    await assert.rejects(() => ipc('configure_account_mcp', { ...args, entryId: 'github', directories: [] }))
    assert.equal(await fs.readFile(configPath, 'utf8'), collision)
    assert.equal((await ipc('inspect_account_mcp', args)).entries.find(entry => entry.id === 'github').status, 'conflict')
  }
  if (await page.getByRole('button', { name: 'Close settings', exact: true }).isVisible()) await page.getByRole('button', { name: 'Close settings', exact: true }).click()
  const settings = page.getByRole('button', { name: 'Settings', exact: true })
  if (await settings.isVisible()) await settings.click()
  else await page.evaluate(() => window.dispatchEvent(new CustomEvent('swarmterm:run-action', { detail: 'open-settings' })))
  await page.getByRole('button', { name: 'MCP', exact: true }).click()
  for (const account of accounts) {
    await page.getByRole('combobox', { name: 'MCP account' }).selectOption(`${account.agentId}:${account.id}`)
    await page.locator('[data-mcp-entry="github"]').getByRole('button', { name: 'Existing configuration' }).waitFor()
    assert(await page.locator('[data-mcp-entry="filesystem"]').getByRole('button', { name: 'Configured' }).isDisabled())
    assert(!(await page.locator('body').innerText()).includes(foreign))
  }
  console.log('Native MCP catalogue passed: both profiles, atomic additive merge, idempotence, conflicts, directory validation, secret-free statuses and UI. No CLI server started.')
} finally {
  for (const account of accounts) await ipc('delete_agent_account', { id: account.id })
  if (await page.getByRole('button', { name: 'Close settings', exact: true }).isVisible()) await page.getByRole('button', { name: 'Close settings', exact: true }).click()
  await browser.close()
  console.log(`Isolated native test fixtures retained at ${testRoot}`)
}
