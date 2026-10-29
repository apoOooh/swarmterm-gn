# Administrator policy

Swarmterm GN reads an administrator policy from the Windows registry. Organisations use it to switch off features
their security rules do not allow. Swarmterm enforces every policy in its backend at the point of action, not just
in the user interface, so neither the user nor an agent running in a pane can work around it from inside the app.
Locked controls are greyed out and marked "Managed by your administrator". Settings lists the active policies at the top.

## Where Swarmterm reads it

| Key | Who can usually write it |
|---|---|
| `HKLM\Software\Policies\SwarmtermGN` | Administrators, Group Policy, Intune. **This is the real lock.** |
| `HKCU\Software\Policies\SwarmtermGN` | User-class Group Policy. Windows normally gives users read-only access to `Software\Policies`, but anyone with admin rights on the machine (or a changed ACL) can write it. |

- Swarmterm reads both keys **once at start**. Changes apply after a restart (quit from the tray, then start again).
- **HKLM wins per value.** A value set under HKLM cannot be overridden from HKCU. HKCU can only add values that HKLM
  does not set. Lock settings under HKLM if users may have admin rights.
- Value names are case-insensitive. Unknown values, wrong types (for example a `REG_SZ` where a `REG_DWORD` is
  expected) and invalid data are ignored and logged to the app's stderr (`policy: …`), never treated as "on".
- With no key at all, Swarmterm behaves as before (unmanaged).

## Values

`REG_DWORD` `1` = on, `0` = off (same as not set).

| Value | Type | Effect | Enforced in |
|---|---|---|---|
| `DisableBypassModes` | DWORD | Refuses any pane whose launch line switches an agent's approval prompts or sandbox off: `--dangerously-skip-permissions`, `--dangerously-bypass-approvals-and-sandbox`, any other `--dangerously-*` / `--allow-dangerously-*` flag, `--permission-mode bypassPermissions`, `--yolo`. Red launch modes are greyed out, and spawned workers can never inherit them. | `pty.rs` (`spawn_terminal`), `agent_policy` override |
| `DisableWarRoomExecute` | DWORD | Agents cannot run prompts in other panes (War Room `execute`). Probes and the user's own War Room sends still work. | `mcp/tools/warroom.rs` |
| `DisableWorktreeSpawn` | DWORD | The `worktree.spawn` MCP tool is refused. | `mcp/tools/worktree.rs` |
| `DisableMcp` | DWORD | The local MCP server is not started, and Swarmterm removes its own entries from the agents' MCP configuration at start (entries it does not recognise as its own are never touched). The Settings → MCP switches stay off. | `lib.rs`, `mcp/toggle.rs` |
| `DisableCompanion` | DWORD | No install or update of the buzzkey voice companion, no update checks, and its Windows autostart cannot be turned on (turning it off still works). An installed buzzkey can still be started and quit. | `voice/companion/mod.rs` |
| `DisableModelDownload` | DWORD | No speech-model downloads for built-in dictation. Already downloaded models stay usable. | `voice/mod.rs` (`voice_model_download`) |
| `DisableRoutineCommands` | DWORD | Routines of kind "Shell command" are refused. Agent routines are not affected. | `commands.rs` (`run_routine_command`) |
| `DisablePreviewBrowser` | DWORD | The built-in web preview (embedded browser) cannot be opened by the user or by agents (`browser.open_preview`). | `preview.rs`, `mcp/tools/browser.rs` |
| `EnvPolicy` | SZ `default` \| `strict` | Forces the terminal environment filter on: panes and command routines never get secrets from Swarmterm's environment. `default` withholds secret-looking names; `strict` passes only the Windows variables a shell needs. A stricter user choice is kept. The user's own allow list is **ignored** while this is set. | `policy.rs` `apply_env` (via `env_policy_snapshot`) |
| `EnvAllow` | MULTI_SZ | Names that always pass the filter (case-insensitive, a trailing `*` matches a prefix). Merged with the user's list when `EnvPolicy` is not set, and the only allow list when it is. | same |

### Limits

- `DisableBypassModes` checks the command Swarmterm starts a pane with. A user can still type such a flag by hand
  into a plain shell pane. Pair the policy with the agents' own managed settings (for example Claude Code's
  managed setting `permissions.disableBypassPermissionsMode`) if that matters.
- The policy restricts Swarmterm. It does not sandbox the agents or the shell.

## Group Policy

1. Copy `docs/admin/SwarmtermGN.admx` to `C:\Windows\PolicyDefinitions\` (or the domain's Central Store,
   `\\<domain>\SYSVOL\<domain>\Policies\PolicyDefinitions\`), and `docs/admin/en-US/SwarmtermGN.adml` to the
   `en-US` subfolder.
2. In the Group Policy Management Editor, go to *Computer Configuration → Administrative Templates → Swarmterm GN*
   (machine policy, HKLM, recommended) or the same path under *User Configuration* (HKCU).
3. Enable the policies you need. `gpupdate /force`, then restart Swarmterm.

## Intune

Either import the ADMX (*Devices → Configuration → Import ADMX*, then a profile from the imported template), or deploy a
PowerShell script / `.reg` file that writes the values under `HKLM\Software\Policies\SwarmtermGN`.

## .reg example

```reg
Windows Registry Editor Version 5.00

[HKEY_LOCAL_MACHINE\Software\Policies\SwarmtermGN]
"DisableBypassModes"=dword:00000001
"DisableWarRoomExecute"=dword:00000001
"DisableWorktreeSpawn"=dword:00000001
"DisableCompanion"=dword:00000001
"DisableModelDownload"=dword:00000001
"DisableRoutineCommands"=dword:00000001
"DisablePreviewBrowser"=dword:00000001
"EnvPolicy"="strict"
; REG_MULTI_SZ "CORP_PROXY", "HTTPS_PROXY" (UTF-16LE, double-NUL terminated)
"EnvAllow"=hex(7):43,00,4f,00,52,00,50,00,5f,00,50,00,52,00,4f,00,58,00,59,00,00,00,48,00,54,00,54,00,50,00,\
  53,00,5f,00,50,00,52,00,4f,00,58,00,59,00,00,00,00,00
```

## PowerShell example

```powershell
$key = 'HKLM:\Software\Policies\SwarmtermGN'
New-Item -Path $key -Force | Out-Null
New-ItemProperty -Path $key -Name DisableBypassModes -PropertyType DWord -Value 1 -Force | Out-Null
New-ItemProperty -Path $key -Name DisableMcp -PropertyType DWord -Value 1 -Force | Out-Null
New-ItemProperty -Path $key -Name EnvPolicy -PropertyType String -Value 'strict' -Force | Out-Null
New-ItemProperty -Path $key -Name EnvAllow -PropertyType MultiString -Value @('CORP_PROXY', 'HTTPS_PROXY') -Force | Out-Null
```

Remove everything again with `Remove-Item -Path 'HKLM:\Software\Policies\SwarmtermGN' -Recurse`.
