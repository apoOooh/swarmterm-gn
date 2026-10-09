import { useEffect, useState, type ReactNode } from 'react'
import { highlightCode, classHighlighter } from '@lezer/highlight'
import { LanguageSupport } from '@codemirror/language'
import { language } from './CodeEditor'
import { writeClipboard } from '@/tauri/clipboard'
const aliases: Record<string, string> = { javascript: 'js', typescript: 'ts', python: 'py', rust: 'rs', markdown: 'md', cpp: 'cpp', java: 'java', go: 'go', bash: 'sh', yaml: 'yml', sql: 'sql', json: 'json', html: 'html', css: 'css', xml: 'xml', php: 'php' }
export function CodeFence({ code, lang }: { code: string; lang: string }): React.ReactElement {
  const [nodes, setNodes] = useState<ReactNode>(code)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    let live = true; setNodes(code)
    if (code.length <= 20_000) void language(`snippet.${aliases[lang.toLowerCase()] ?? lang}`).then((extension) => {
      if (!live || !(extension instanceof LanguageSupport)) return
      const out: ReactNode[] = []; let key = 0
      highlightCode(code, extension.language.parser.parse(code), classHighlighter, (text, classes) => { out.push(classes ? <span key={key++} className={classes}>{text}</span> : text) }, () => out.push('\n'))
      setNodes(out)
    })
    return () => { live = false }
  }, [code, lang])
  useEffect(() => { if (!copied) return; const timer = setTimeout(() => setCopied(false), 1500); return () => clearTimeout(timer) }, [copied])
  return <><button className="absolute right-2 top-1 rounded px-2 py-0.5 text-[10px] text-muted-foreground hover:bg-accent" aria-label="Copy code block" onClick={() => { void writeClipboard(code).then(() => setCopied(true)).catch(() => {}) }}>{copied ? 'Copied' : 'Copy'}</button><code>{nodes}</code></>
}
