import { beforeEach, expect, it, vi } from 'vitest'
import { useExplorerStore } from './explorer-store'
import { listFiles, openFileContext, watchFiles } from '@/tauri/files'
vi.mock('@/tauri/files', () => ({ listFiles: vi.fn(() => Promise.resolve([])), getFileGitStatus: vi.fn(() => Promise.resolve([])), openFileContext: vi.fn(), watchFiles: vi.fn(() => Promise.resolve()), unwatchFiles: vi.fn(() => Promise.resolve()) }))
beforeEach(async () => {
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
