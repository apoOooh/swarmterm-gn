/**
 * Builds the one-line command a worker pane runs at spawn: the agent CLI plus
 * the task brief as a single quoted argument. Quoting is per shell family
 * because the line is typed into the pane's shell (initialCommand), not
 * exec'd directly — PowerShell, POSIX and cmd disagree on quote rules.
 */
import type { ShellId } from '@/lib/terminal-pref'

export type ShellFlavor = 'posix' | 'powershell' | 'cmd'

export function shellFlavor(shellId: ShellId | undefined, windows: boolean): ShellFlavor {
  switch (shellId) {
    case 'git-bash':
    case 'wsl':
    case 'zsh':
    case 'bash':
    case 'fish':
      return 'posix'
    case 'powershell':
    case 'pwsh':
      return 'powershell'
    case 'cmd':
      return 'cmd'
    default:
      // 'default' and undefined follow the platform default shell
      // (pty.rs::default_shell): PowerShell on Windows, $SHELL elsewhere.
      return windows ? 'powershell' : 'posix'
  }
}

/** Every character PowerShell's tokenizer accepts as a single-quote
 *  delimiter: ASCII ' plus U+2018, U+2019, U+201A and U+201B. Doubling any
 *  of them inside a single-quoted string yields that one character. */
const PS_SINGLE_QUOTES = /['‘’‚‛]/g

export function quoteForShell(text: string, flavor: ShellFlavor): string {
  switch (flavor) {
    case 'posix':
      // ' and \ leave the quotes and come back escaped: bash/zsh read a \
      // inside '...' literally, but fish treats \\ and \' there as escapes,
      // so a trailing \ would otherwise swallow the closing quote in fish.
      return `'${text.replace(/[\\']/g, (c) => `'\\${c}'`)}'`
    case 'powershell':
      // Single quotes are fully literal in PowerShell; doubling is the only
      // escape, and it must cover the typographic quotes too.
      return `'${text.replace(PS_SINGLE_QUOTES, (c) => c + c)}'`
    case 'cmd':
      return cmdQuote(text)
  }
}

/**
 * cmd has no inner-quote escape: " is downgraded to ' (fidelity loss, fine
 * for a brief or a Windows path, which cannot contain "). cmd expands %NAME%
 * before it looks at quotes, so each % goes outside the quotes as ^%: any
 * would-be variable name then contains " or ^, is never defined and stays
 * literal (interactive cmd keeps an undefined %...% as typed). Trailing
 * backslashes of a quoted part stay outside it: the program's argv parser
 * would read \" as an escaped quote. Delayed expansion (!) is off in an
 * interactive cmd and not handled.
 */
function cmdQuote(text: string): string {
  return text
    .replace(/"/g, `'`)
    .split('%')
    .map((part) => {
      const body = part.replace(/\\+$/, '')
      return (body === '' ? '' : `"${body}"`) + part.slice(body.length)
    })
    .join('^%')
}

export function buildAgentSpawnCommand(
  baseCommand: string,
  prompt: string | undefined,
  flavor: ShellFlavor,
  promptFlag?: string
): string {
  // The pty writes initialCommand as a single line + CR; embedded newlines
  // would submit the command early, so collapse them to spaces.
  // Other control bytes (Ctrl-U, Esc, ...) would drive the shell's line
  // editor and could replace the typed line; drop them (C0, DEL, C1).
  const singleLine = (prompt ?? '')
    .replace(/\s*[\r\n]+\s*/g, ' ')
    .replace(/\t/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .trim()
  if (singleLine === '') return baseCommand
  // Windows shells hand the brief to a native program (often an npm .cmd
  // shim run through cmd.exe) with their own argv encoding: a " inside it
  // could split it into extra arguments (flags), and a brief without
  // an ASCII space is passed unquoted (other whitespace does not count), so cmd metacharacters (&, |) would act.
  // So " becomes ' and a one-word brief gets a trailing space (the agent
  // sees that changed text; only quote style and whitespace differ). Quoting (not
  // a temp file or env var) stays: those would hit the same argv encoding.
  // That cmd.exe also expands %NAME% inside quotes, so a brief such as
  // `%CMDCMDLINE:~-1%& calc` would close the quote and run a command
  // (BatBadBut); ! does the same where delayed expansion is switched on
  // (off by default, but a registry value turns it on for every cmd). Both
  // become their full-width forms (U+FF05, U+FF01), which no shell treats
  // specially and which still read as the same sign. The cmd flavor's own
  // ^% escape only works on a typed cmd line, not inside a shim's %*.
  const windowsSafe = (text: string) =>
    text.replace(/"/g, `'`).replace(/%/g, '\uFF05').replace(/!/g, '\uFF01')
  const encoded =
    flavor === 'posix' ? singleLine : windowsSafe(singleLine) + (/[ ]/.test(singleLine) ? '' : ' ')
  // A brief starting with - would be parsed as a flag by the agent (and
  // Rust's admin check never skips one, pty::launch_line_to_check): a
  // leading space inside the quotes keeps it a positional prompt.
  const brief = encoded.startsWith('-') ? ` ${encoded}` : encoded
  // Gemini-heritage CLIs run a positional prompt one-shot and exit; their
  // template carries the stay-interactive flag (templates.ts spawnPromptFlag).
  const flag = promptFlag !== undefined ? `${promptFlag} ` : ''
  return `${baseCommand} ${flag}${quoteForShell(brief, flavor)}`
}
