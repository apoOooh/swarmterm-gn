import { beforeEach, expect, it, vi } from 'vitest'
import { FileWatchLease } from './watch-lease'
import { unwatchFiles, watchFiles } from '@/tauri/files'
vi.mock('@/tauri/files', () => ({ watchFiles: vi.fn(), unwatchFiles: vi.fn(() => Promise.resolve()) }))
beforeEach(() => vi.clearAllMocks())
it('releases a watcher that completed after its pane was already closed', async () => {
  let ready!: () => void
  vi.mocked(watchFiles).mockReturnValue(new Promise<void>((r) => { ready = r }))
  const lease = new FileWatchLease('root'); lease.release(); lease.release()
  expect(unwatchFiles).not.toHaveBeenCalled()
  ready(); await lease.ready
  expect(unwatchFiles).toHaveBeenCalledExactlyOnceWith('root')
})
it('releases an established watcher once', async () => {
  vi.mocked(watchFiles).mockResolvedValue()
  const lease = new FileWatchLease('root'); await lease.ready
  lease.release(); lease.release()
  expect(unwatchFiles).toHaveBeenCalledExactlyOnceWith('root')
})
