import { describe, expect, it } from 'vitest'
import { buildAgentSpawnCommand, quoteForShell, shellFlavor } from '@/lib/agent-spawn-command'

describe('shellFlavor', () => {
  it('maps posix-family shells', () => {
    expect(shellFlavor('git-bash', true)).toBe('posix')
    expect(shellFlavor('wsl', true)).toBe('posix')
  })
  it('maps powershell family', () => {
    expect(shellFlavor('powershell', true)).toBe('powershell')
    expect(shellFlavor('pwsh', false)).toBe('powershell')
  })
  it('maps the unix-native shells to posix', () => {
    expect(shellFlavor('zsh', false)).toBe('posix')
    expect(shellFlavor('bash', false)).toBe('posix')
    expect(shellFlavor('fish', false)).toBe('posix')
  })
  it('maps cmd', () => {
    expect(shellFlavor('cmd', true)).toBe('cmd')
  })
  it('default shell follows the platform', () => {
    expect(shellFlavor('default', true)).toBe('powershell')
    expect(shellFlavor('default', false)).toBe('posix')
    expect(shellFlavor(undefined, false)).toBe('posix')
  })
})

describe('quoteForShell', () => {
  it('posix single-quotes and escapes embedded quotes', () => {
    expect(quoteForShell("don't stop", 'posix')).toBe("'don'\\''t stop'")
  })
  it('powershell doubles embedded single quotes', () => {
    expect(quoteForShell("don't stop", 'powershell')).toBe("'don''t stop'")
  })
  it('cmd double-quotes and downgrades embedded double quotes', () => {
    expect(quoteForShell('say "hi"', 'cmd')).toBe(`"say 'hi'"`)
  })
})

describe('buildAgentSpawnCommand', () => {
  it('appends the quoted prompt', () => {
    expect(buildAgentSpawnCommand('claude --permission-mode default', 'Fix login', 'powershell'))
      .toBe("claude --permission-mode default 'Fix login'")
  })
  it('collapses newlines so the pty write stays one line', () => {
    expect(buildAgentSpawnCommand('codex', 'a\nb\r\nc', 'posix')).toBe("codex 'a b c'")
  })
  it('returns the base command for an empty prompt', () => {
    expect(buildAgentSpawnCommand('codex', '', 'posix')).toBe('codex')
    expect(buildAgentSpawnCommand('codex', undefined, 'posix')).toBe('codex')
  })
  it('inserts the stay-interactive flag when the template carries one', () => {
    expect(buildAgentSpawnCommand('qwen', 'Fix login', 'posix', '-i')).toBe("qwen -i 'Fix login'")
    // Empty prompt: no flag either — the bare CLI starts interactive anyway.
    expect(buildAgentSpawnCommand('qwen', '', 'posix', '-i')).toBe('qwen')
  })
})

describe('quoting hostile briefs', () => {
  it('doubles every PowerShell single-quote character', () => {
    for (const q of ["'", '\u2018', '\u2019', '\u201A', '\u201B']) {
      expect(quoteForShell(`a${q}; calc; ${q}b`, 'powershell')).toBe(`'a${q}${q}; calc; ${q}${q}b'`)
    }
    expect(buildAgentSpawnCommand('claude', '\u2019; Remove-Item x; \u2019', 'powershell')).toBe(
      "claude '\u2019\u2019; Remove-Item x; \u2019\u2019'"
    )
  })

  it('keeps a trailing backslash inside the quotes for bash and fish', () => {
    expect(quoteForShell('a\\', 'posix')).toBe("'a'\\\\''")
    expect(quoteForShell("it's", 'posix')).toBe("'it'\\''s'")
  })

  it('keeps cmd variables and trailing backslashes out of the quotes', () => {
    expect(quoteForShell('use %PATH% now', 'cmd')).toBe('"use "^%"PATH"^%" now"')
    expect(quoteForShell('C:\\dir\\', 'cmd')).toBe('"C:\\dir"\\')
  })

  it('never lets a brief add arguments on Windows shells', () => {
    expect(buildAgentSpawnCommand('claude', 'x" --dangerously-skip-permissions "y', 'powershell')).toBe(
      "claude 'x'' --dangerously-skip-permissions ''y'"
    )
    expect(buildAgentSpawnCommand('claude', 'a&calc', 'powershell')).toBe("claude 'a&calc '")
    expect(buildAgentSpawnCommand('claude', 'say "hi"', 'posix')).toBe(`claude 'say "hi"'`)
  })

  it('takes % and ! out of reach of cmd.exe behind npm shims', () => {
    const breakout = 'x %CMDCMDLINE:~-1%& calc %CMDCMDLINE:~-1%'
    const ps = buildAgentSpawnCommand('codex', breakout, 'powershell')
    expect(ps).toBe("codex 'x ％CMDCMDLINE:~-1％& calc ％CMDCMDLINE:~-1％'")
    expect(ps).not.toMatch(/[%!]/)
    expect(buildAgentSpawnCommand('codex', '100% done!', 'cmd')).toBe('codex "100％ done！"')
    expect(buildAgentSpawnCommand('codex', '100% done!', 'posix')).toBe("codex '100% done!'")
  })

  it('drops control bytes that would edit the shell line', () => {
    expect(buildAgentSpawnCommand('claude', '\u0015claude --yolo #\u001b\u0003\u0085', 'posix')).toBe(
      "claude 'claude --yolo #'"
    )
    expect(buildAgentSpawnCommand('claude', 'a\u00a0&calc', 'powershell')).toBe("claude 'a\u00a0&calc '")
  })

  it('never lets a brief start with a flag', () => {
    expect(buildAgentSpawnCommand('claude', '--dangerously-skip-permissions', 'posix')).toBe(
      "claude ' --dangerously-skip-permissions'"
    )
    expect(buildAgentSpawnCommand('claude', '--yolo', 'powershell')).toBe("claude ' --yolo '")
    expect(buildAgentSpawnCommand('gemini', '-y now', 'cmd', '-i')).toBe('gemini -i " -y now"')
    expect(buildAgentSpawnCommand('claude', 'use --yolo', 'posix')).toBe("claude 'use --yolo'")
  })
})
