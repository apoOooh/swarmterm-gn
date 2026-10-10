/**
 * Dev-mode diagnostics: renderer warnings, errors and explicit `devLog`
 * events become JSON lines in the file named by SWARMTERM_DEV_LOG (see
 * src-tauri/src/devlog.rs). Only installed when `import.meta.env.DEV`;
 * in a release `devLog` stays a no-op and nothing is patched.
 */
export type DevLogLevel = 'debug' | 'warn' | 'error'

export interface DevLogRecord {
  t: string
  level: DevLogLevel
  event: string
  data?: unknown
}

const MAX_FIELD = 2000

/** Safe, bounded JSON for one record — never throws on cycles, Errors or huge values. */
export function formatRecord(record: DevLogRecord): string {
  const seen = new WeakSet<object>()
  const json = JSON.stringify(record, (_key, value: unknown) => {
    if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack?.split('\n').slice(0, 6).join(' | ') }
    if (typeof value === 'string' && value.length > MAX_FIELD) return `${value.slice(0, MAX_FIELD)}…(${value.length})`
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) return '[circular]'
      seen.add(value)
    }
    return value
  })
  return json ?? '{}'
}

let sink: ((lines: string[]) => Promise<void>) | null = null
let queue: string[] = []
let timer: ReturnType<typeof setTimeout> | undefined

function flush(): void {
  timer = undefined
  const lines = queue
  queue = []
  if (sink && lines.length) void sink(lines).catch(() => {})
}

/** Record a diagnostic event. Cheap no-op until `installDevLog` ran (dev only). */
export function devLog(event: string, data?: unknown, level: DevLogLevel = 'debug'): void {
  if (!sink) return
  queue.push(formatRecord({ t: new Date().toISOString(), level, event, ...(data === undefined ? {} : { data }) }))
  timer ??= setTimeout(flush, 300)
}

/** Mirror console.warn/error and uncaught failures into the dev log. */
export function installDevLog(write: (lines: string[]) => Promise<void>): void {
  if (sink) return
  sink = write
  for (const level of ['warn', 'error'] as const) {
    const original = console[level].bind(console)
    console[level] = (...args: unknown[]) => {
      original(...args)
      devLog(`console.${level}`, args, level)
    }
  }
  window.addEventListener('error', (e) => devLog('window.error', { message: e.message, source: e.filename, line: e.lineno, error: e.error }, 'error'))
  window.addEventListener('unhandledrejection', (e) => devLog('unhandledrejection', { reason: e.reason }, 'error'))
  devLog('dev-log.start', { userAgent: navigator.userAgent })
}
