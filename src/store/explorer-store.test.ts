import { beforeEach, expect, it, vi } from 'vitest'
import { useExplorerStore } from './explorer-store'
import { listFiles, openFileContext, watchFiles } from '@/tauri/files'
vi.mock('@/tauri/files', () => ({ listFiles: vi.fn(() => Promise.resolve([])), getFileGitStatus: vi.fn(() => Promise.resolve([])), openFileContext: vi.fn(), watchFiles: vi.fn(() => Promise.resolve()), unwatchFiles: vi.fn(() => Promise.resolve()) }))
// Every folder lists the children the tests expand, so pruning of vanished folders leaves them alone.
const dir = (path: string) => ({ name: path.split('/').pop()!, path, isDir: true, isSymlink: false })
const children: Record<string, string[]> = { '/one': ['/one/src'], '/p': ['/p/a', '/p/b'] }
beforeEach(async () => {
  vi.mocked(listFiles).mockImplementation((_, path) => Promise.resolve((children[path] ?? []).map(dir)))
  await useExplorerStore.getState().follow(null)
  useExplorerStore.setState({ roots: {}, current: null, error: null, clipboard: null, undo: [] }); vi.clearAllMocks()
})
it('ignores stale root requests when the user clicks another terminal first', async () => {
  let first!: (context: { id: string; root: string }) => void
  vi.mocked(openFileContext).mockImplementation((id) => id === 'old' ? new Promise((r) => { first = r }) : Promise.resolve({ id: 'new-root', root: '/new' }))
  const old = useExplorerStore.getState().follow('old')
  await useExplorerStore.getState().follow('new'); first({ id: 'old-root', root: '/old' }); await old
  expect(useExplorerStore.getState().current).toBe('new-root'); expect(watchFiles).not.toHaveBeenCalledWith('old-root', [])
})
it('preserves expansion state per root while roots change', async () => {
  vi.mocked(openFileContext).mockImplementation((id) => Promise.resolve({ id, root: `/${id}` }))
  await useExplorerStore.getState().follow('one'); useExplorerStore.getState().toggle('one', '/one/src')
  await useExplorerStore.getState().follow('two'); await useExplorerStore.getState().follow('one')
  expect(useExplorerStore.getState().roots.one.expanded).toEqual(['/one/src']); expect(listFiles).toHaveBeenCalledWith('one', '/one/src')
})
it('reloads only folders on a changed path, but every loaded folder on a rescan', async () => {
  vi.mocked(openFileContext).mockResolvedValue({ id: 'p', root: '/p' })
  await useExplorerStore.getState().follow('t')
  useExplorerStore.getState().toggle('p', '/p/a'); useExplorerStore.getState().toggle('p', '/p/b')
  await vi.waitFor(() => expect(useExplorerStore.getState().roots.p.dirs['/p/b']?.entries).toBeDefined())
  vi.mocked(listFiles).mockClear()
  await useExplorerStore.getState().changed({ contextId: 'p', paths: ['/p/a/x.txt'], gitChanged: false, rescan: false })
  expect(vi.mocked(listFiles).mock.calls.map(([, path]) => path).sort()).toEqual(['/p', '/p/a'])
  vi.mocked(listFiles).mockClear()
  await useExplorerStore.getState().changed({ contextId: 'p', paths: [], gitChanged: false, rescan: true })
  expect(vi.mocked(listFiles).mock.calls.map(([, path]) => path).sort()).toEqual(['/p', '/p/a', '/p/b'])
})
it('forgets expanded folders that vanished from disk instead of showing a retry error', async () => {
  vi.mocked(openFileContext).mockResolvedValue({ id: 'g', root: '/g' })
  await useExplorerStore.getState().follow('t')
  useExplorerStore.getState().toggle('g', '/g/wt'); useExplorerStore.getState().toggle('g', '/g/wt/src'); useExplorerStore.getState().toggle('g', '/g/keep')
  await vi.waitFor(() => expect(useExplorerStore.getState().roots.g.dirs['/g/keep']?.entries).toBeDefined())
  // The worktree folder was removed: its own listings fail, the parent no longer lists it.
  vi.mocked(listFiles).mockImplementation((_, path) => path === '/g'
    ? Promise.resolve([{ name: 'keep', path: '/g/keep', isDir: true, isSymlink: false }])
    : path.startsWith('/g/wt') ? Promise.reject('os error 3') : Promise.resolve([]))
  await useExplorerStore.getState().refresh('g')
  const root = useExplorerStore.getState().roots.g
  expect(root.expanded).toEqual(['/g/keep'])
  expect(Object.keys(root.dirs).sort()).toEqual(['/g', '/g/keep'])
})
