import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const setDropTarget = vi.fn()
vi.mock('@/store/app-store', () => ({ useAppStore: { getState: () => ({ setDropTarget }) } }))
vi.mock('@/lib/dev-log', () => ({ devLog: () => {} }))

import { mediaDragOptions, mediaDropPane, mediaDropText, mediaGhost, type MediaDragDeps } from './media-drag'
import { startPointerDrag } from './pointer-drag-session'
import { useExplorerDragStore } from '@/store/explorer-drag-store'

const paneEl = (dataset: Record<string, string | undefined>) => ({ closest: (sel: string) => (sel === '[data-terminal-id]' ? { dataset } : null) })
const nowhere = { closest: () => null }
const claude = paneEl({ terminalId: 't1', shellFlavor: 'powershell', agentId: 'claude-code' })
const shell = paneEl({ terminalId: 't2', shellFlavor: 'powershell' })
const PATH = 'C:\\shots\\a b.png'

function deps(over: Partial<MediaDragDeps> = {}): MediaDragDeps & { insert: ReturnType<typeof vi.fn>; onTap: ReturnType<typeof vi.fn> } {
  return { elementAt: () => claude, isKnown: () => true, insert: vi.fn(), onTap: vi.fn(), ...over } as never
}

describe('mediaDropText', () => {
  it('pastes the image reference for claude-code and codex', () => {
    expect(mediaDropText(PATH, { agentId: 'claude-code', flavor: 'powershell' })).toBe(`"${PATH}" `)
    expect(mediaDropText('C:\\a.png', { agentId: 'codex', flavor: 'powershell' })).toBe('C:\\a.png ')
  })
  it('types the shell-quoted path for other panes', () => {
    expect(mediaDropText(PATH, { flavor: 'powershell' })).toBe("'C:\\shots\\a b.png' ")
    expect(mediaDropText('/tmp/a.png', { agentId: 'opencode', flavor: 'posix' })).toBe('/tmp/a.png ')
  })
  it('refuses paths imagePasteText rejects, for every pane', () => {
    for (const bad of ['', 'C:\\a"b.png', 'C:\\a\nb.png']) {
      expect(mediaDropText(bad, { agentId: 'claude-code', flavor: 'powershell' })).toBe('')
      expect(mediaDropText(bad, { flavor: 'posix' })).toBe('')
    }
  })
})

describe('mediaDropPane', () => {
  it('resolves a pane from its data attributes', () => {
    expect(mediaDropPane(claude)).toEqual({ terminalId: 't1', flavor: 'powershell', agentId: 'claude-code' })
    expect(mediaDropPane(shell)).toEqual({ terminalId: 't2', flavor: 'powershell', agentId: undefined })
  })
  it('ignores anything that is not a pane (preview column, overlay, chrome)', () => {
    expect(mediaDropPane(null)).toBeNull()
    expect(mediaDropPane(nowhere)).toBeNull()
    expect(mediaDropPane(paneEl({ terminalId: 't3' }))).toBeNull()
  })
})

describe('mediaGhost', () => {
  it('shows a thumbnail only for opened images', () => {
    expect(mediaGhost({ opened: true, kind: 'image' })).toBe('thumb')
    expect(mediaGhost({ opened: true, kind: 'video' })).toBe('film')
    expect(mediaGhost({ opened: false, kind: 'image' })).toBe('placeholder')
  })
})

describe('mediaDragOptions', () => {
  it('drops into the pane under the pointer', () => {
    const d = deps()
    const o = mediaDragOptions(PATH, d)
    expect(o.hit(1, 1, false)).toEqual({ effect: 'copy', terminalId: 't1' })
    o.drop(1, 1, false, o.hit(1, 1, false))
    expect(d.insert).toHaveBeenCalledWith('t1', `"${PATH}" `)
  })
  it('does nothing outside a pane', () => {
    const d = deps({ elementAt: () => nowhere })
    const o = mediaDragOptions(PATH, d)
    expect(o.hit(1, 1, false)).toEqual({ effect: 'none' })
    o.drop(1, 1, false, { effect: 'copy', terminalId: 't1' })
    expect(d.insert).not.toHaveBeenCalled()
  })
  it('refuses a path that is no longer in the media store', () => {
    const d = deps({ isKnown: () => false })
    const o = mediaDragOptions(PATH, d)
    expect(o.hit(1, 1, false).effect).toBe('none')
    o.drop(1, 1, false, { effect: 'copy', terminalId: 't1' })
    expect(d.insert).not.toHaveBeenCalled()
  })
})

describe('media drag gesture (startPointerDrag)', () => {
  let win: EventTarget
  beforeEach(() => {
    win = new EventTarget()
    vi.stubGlobal('window', win)
    vi.stubGlobal('document', { documentElement: { dataset: {} as Record<string, string>, style: { cursor: '' } } })
  })
  afterEach(() => vi.unstubAllGlobals())
  const fire = (type: string, props: Record<string, unknown>): void => { win.dispatchEvent(Object.assign(new Event(type), props)) }

  it('a release under the threshold is a click (opens, inserts nothing)', () => {
    const d = deps()
    startPointerDrag({ button: 0, clientX: 10, clientY: 10 }, mediaDragOptions(PATH, d))
    fire('pointermove', { clientX: 13, clientY: 12 })
    expect(useExplorerDragStore.getState().drag).toBeNull()
    fire('pointerup', { clientX: 13, clientY: 12 })
    expect(d.onTap).toHaveBeenCalledOnce()
    expect(d.insert).not.toHaveBeenCalled()
  })
  it('moving past the threshold drags; release over a pane inserts', () => {
    const d = deps()
    startPointerDrag({ button: 0, clientX: 10, clientY: 10 }, { ...mediaDragOptions(PATH, d), ghost: { icon: 'image' } })
    fire('pointermove', { clientX: 30, clientY: 10 })
    expect(useExplorerDragStore.getState().drag).toMatchObject({ effect: 'copy', ghost: { icon: 'image' } })
    expect(setDropTarget).toHaveBeenLastCalledWith('t1')
    fire('pointerup', { clientX: 30, clientY: 10 })
    expect(d.insert).toHaveBeenCalledWith('t1', `"${PATH}" `)
    expect(d.onTap).not.toHaveBeenCalled()
    expect(useExplorerDragStore.getState().drag).toBeNull()
  })
  it('pointercancel ends the drag without inserting', () => {
    const d = deps()
    startPointerDrag({ button: 0, clientX: 10, clientY: 10 }, mediaDragOptions(PATH, d))
    fire('pointermove', { clientX: 30, clientY: 10 })
    fire('pointercancel', {})
    expect(useExplorerDragStore.getState().drag).toBeNull()
    fire('pointerup', { clientX: 30, clientY: 10 })
    expect(d.insert).not.toHaveBeenCalled()
    expect(d.onTap).not.toHaveBeenCalled()
  })
  it('Esc cancels: the later release neither inserts nor opens', () => {
    const d = deps()
    startPointerDrag({ button: 0, clientX: 10, clientY: 10 }, mediaDragOptions(PATH, d))
    fire('pointermove', { clientX: 30, clientY: 10 })
    fire('keydown', { key: 'Escape', stopPropagation: () => {} })
    expect(useExplorerDragStore.getState().drag).toBeNull()
    expect(setDropTarget).toHaveBeenLastCalledWith(null)
    fire('pointerup', { clientX: 30, clientY: 10 })
    expect(d.insert).not.toHaveBeenCalled()
    expect(d.onTap).not.toHaveBeenCalled()
  })
})
