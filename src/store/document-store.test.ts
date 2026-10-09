import { beforeEach, expect, it, vi } from 'vitest'
import { useDocumentStore } from './document-store'
import { fileDialog } from './file-dialog-store'
import { readFile, writeFile, watchFiles, unwatchFiles } from '@/tauri/files'
vi.mock('@/tauri/files', () => ({ readFile: vi.fn(), writeFile: vi.fn(), watchFiles: vi.fn(() => Promise.resolve()), unwatchFiles: vi.fn(() => Promise.resolve()) }))
vi.mock('./file-dialog-store', () => ({ fileDialog: vi.fn(() => Promise.resolve(null)) }))
const context = { id: 'project', root: '/p' }
const disk = (content = 'original\r\n', version = '1') => ({ content, version, binary: false, truncated: false, bom: false })
beforeEach(() => {
  useDocumentStore.getState().collect(new Set())
  useDocumentStore.setState({ documents: {}, panes: {}, error: null })
  useDocumentStore.getState().collect(new Set(['a', 'b']))
  vi.clearAllMocks(); vi.mocked(readFile).mockResolvedValue(disk()); vi.mocked(writeFile).mockResolvedValue({ version: '2' }); vi.mocked(fileDialog).mockResolvedValue(null)
})
it('shares one buffer and watch lease across panes and guards only the last close', async () => {
  await Promise.all([useDocumentStore.getState().open('a', context, '/p/file.txt'), useDocumentStore.getState().open('b', context, '/p/file.txt')])
  expect(readFile).toHaveBeenCalledTimes(1); expect(watchFiles).toHaveBeenCalledTimes(1)
  const key = useDocumentStore.getState().panes.a.active!
  useDocumentStore.getState().update(key, 'unsaved')
  await useDocumentStore.getState().close('a', key); expect(fileDialog).not.toHaveBeenCalled()
  await useDocumentStore.getState().close('b', key); expect(fileDialog).toHaveBeenCalledTimes(1)
  expect(useDocumentStore.getState().panes.b.active).toBe(key)
  vi.mocked(fileDialog).mockResolvedValue('discard'); await useDocumentStore.getState().close('b', key)
  expect(useDocumentStore.getState().documents[key]).toBeUndefined(); expect(unwatchFiles).toHaveBeenCalledTimes(1)
})
it('does not mark edits made during an asynchronous save as saved', async () => {
  await useDocumentStore.getState().open('a', context, '/p/file.txt')
  const key = useDocumentStore.getState().panes.a.active!; useDocumentStore.getState().update(key, 'before\n')
  let finish!: (r: { version: string }) => void
  vi.mocked(writeFile).mockReturnValue(new Promise((r) => { finish = r }))
  const saving = useDocumentStore.getState().save(key)
  useDocumentStore.getState().update(key, 'after\n'); finish({ version: '2' }); await saving
  expect(writeFile).toHaveBeenCalledWith('project', '/p/file.txt', 'before\r\n', '1', false)
  const doc = useDocumentStore.getState().documents[key]; expect(doc.saved).toBe('before\n'); expect(doc.content).toBe('after\n'); expect(doc.dirty).toBe(true)
})
it('renames a shared document without making a second buffer when reopened', async () => {
  await useDocumentStore.getState().open('a', context, '/p/file.txt')
  const key = useDocumentStore.getState().panes.a.active!; useDocumentStore.getState().update(key, 'mine')
  useDocumentStore.getState().remap('/p/file.txt', '/p/new.txt')
  await useDocumentStore.getState().open('b', context, '/p/new.txt')
  expect(useDocumentStore.getState().panes.b.active).toBe(key); expect(Object.keys(useDocumentStore.getState().documents)).toHaveLength(1)
  expect(useDocumentStore.getState().documents[key].content).toBe('mine')
})
it('does not resurrect tabs after their pane closed during a read', async () => {
  let finish!: (v: ReturnType<typeof disk>) => void
  vi.mocked(readFile).mockReturnValue(new Promise((r) => { finish = r }))
  const opening = useDocumentStore.getState().open('a', context, '/p/file.txt')
  useDocumentStore.getState().collect(new Set(['b'])); finish(disk()); await opening
  expect(useDocumentStore.getState().panes.a).toBeUndefined(); expect(watchFiles).not.toHaveBeenCalled()
})

it('does not resurrect documents after closing during an explicit reload', async () => {
  await useDocumentStore.getState().open('a', context, '/p/file.txt')
  const key = useDocumentStore.getState().panes.a.active!
  let finish!: (v: ReturnType<typeof disk>) => void
  vi.mocked(readFile).mockReturnValue(new Promise((r) => { finish = r }))
  const reloading = useDocumentStore.getState().reload(key)
  await useDocumentStore.getState().close('a', key); finish(disk('new', '2')); await reloading
  expect(useDocumentStore.getState().documents[key]).toBeUndefined()
})

it('does not resurrect a discarded document after an in-flight save fails', async () => {
  await useDocumentStore.getState().open('a', context, '/p/file.txt')
  const key = useDocumentStore.getState().panes.a.active!; useDocumentStore.getState().update(key, 'mine')
  let reject!: (e: Error) => void
  vi.mocked(writeFile).mockReturnValue(new Promise((_, r) => { reject = r }))
  const saving = useDocumentStore.getState().save(key)
  vi.mocked(fileDialog).mockResolvedValue('discard'); await useDocumentStore.getState().close('a', key)
  reject(new Error('Disk unavailable')); await saving
  expect(useDocumentStore.getState().documents[key]).toBeUndefined()
})
