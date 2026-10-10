interface Node { type: string; value?: string; children?: Node[]; tagName?: string; properties?: Record<string, unknown> }
/** Rehype plugin: search only rendered text, then add generated marks after sanitization. */
export function markdownSearch(options: { query: string; active: number }): (root: Node) => void {
  return (root) => {
    const query = options.query.toLowerCase(); if (!query) return
    let index = 0
    const walk = (node: Node): void => {
      if (!node.children || node.tagName === 'script' || node.tagName === 'style') return
      const next: Node[] = []
      for (const child of node.children) {
        if (child.type !== 'text' || !child.value) { walk(child); next.push(child); continue }
        const text = child.value; const folded = text.toLowerCase(); let start = 0; let hit = folded.indexOf(query)
        while (hit >= 0) {
          if (hit > start) next.push({ type: 'text', value: text.slice(start, hit) })
          next.push({ type: 'element', tagName: 'mark', properties: { 'data-file-match': index, className: index === options.active ? ['file-match-active'] : [] }, children: [{ type: 'text', value: text.slice(hit, hit + query.length) }] })
          index++; start = hit + query.length; hit = folded.indexOf(query, start)
        }
        if (start < text.length) next.push({ type: 'text', value: text.slice(start) })
      }
      node.children = next
    }
    walk(root)
  }
}
