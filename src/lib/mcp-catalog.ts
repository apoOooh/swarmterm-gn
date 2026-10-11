export const MCP_CATALOG_VERSION = 1
export interface McpCatalogEntry {
  id: string
  name: string
  description: string
  documentationUrl: string
  requirement: string
  directories?: boolean
}

/** Reviewed definitions; credentials stay with the agent CLI, never this app. */
export const MCP_CATALOG: readonly McpCatalogEntry[] = [
  { id: 'playwright', name: 'Playwright', description: 'Browser automation in headless mode.', documentationUrl: 'https://github.com/microsoft/playwright-mcp', requirement: 'Node.js and browser binaries. The CLI may download the package on first use.' },
  { id: 'github', name: 'GitHub', description: 'GitHub repositories, issues and pull requests.', documentationUrl: 'https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md', requirement: 'Authenticate separately with the agent CLI. Swarmterm stores no GitHub token.' },
  { id: 'context7', name: 'Context7', description: 'Current library documentation.', documentationUrl: 'https://github.com/upstash/context7', requirement: 'Authenticate the OAuth connection separately with the agent CLI. Swarmterm stores no Context7 token.' },
  { id: 'filesystem', name: 'Filesystem', description: 'Read and write files within selected directories.', documentationUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem', requirement: 'Node.js. Choose existing absolute directories; the CLI may download the package on first use.', directories: true },
  { id: 'memory', name: 'Memory', description: 'Persistent knowledge graph.', documentationUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/memory', requirement: 'Node.js. The CLI may download the package on first use.' },
  { id: 'sequential-thinking', name: 'Sequential Thinking', description: 'Structured, iterative reasoning.', documentationUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking', requirement: 'Node.js. The CLI may download the package on first use.' },
  { id: 'fetch', name: 'Fetch', description: 'Fetch web content and convert it to text.', documentationUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/fetch', requirement: 'uv / uvx. The CLI may download the package on first use.' },
]
