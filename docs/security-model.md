# Security model

Last updated: 2026-10-29 (version 1.25.4). For reporting vulnerabilities see
[SECURITY.md](../SECURITY.md); for data and network use see
[PRIVACY.md](../PRIVACY.md).

## What Swarmterm GN protects, and what it does not

Swarmterm GN is a terminal application. Everything it starts runs as the
signed-in Windows user with that user's rights. It is not a sandbox: an agent
or command in a pane can do whatever the user could do in any other terminal.

The application's own job is to:

- not add ways in from outside (no listening ports beyond loopback, no
  self-update, no telemetry);
- keep its control surfaces (MCP server, voice pipe) limited to the panes and
  programs that are meant to use them;
- avoid handing more to panes than they need (environment filtering);
- keep agents' work separable and reviewable (worktrees);
- keep the machine usable under load (job objects and priority).

Threats considered: other local users and other processes of the same user
reaching the app's control surfaces; web pages (including the web preview)
reaching the loopback server; a compromised download of the companion; a pane
leaking secrets from the app's environment; a release pipeline that ships
unexpected code or dependencies. Not considered: a malicious agent CLI or a
user who chooses to run untrusted code; an attacker who already controls the
user account.

## Controls

### No self-update, no telemetry

The application contains no updater and makes no update checks for itself;
new versions are installed by the user or by IT software distribution from
signed-checksum release assets. It sends no telemetry; the release workflow
fails if the built executable contains an analytics endpoint
(`.github/workflows/release.yml`).

### Process containment and priority

Each pane's process tree runs in a kill-on-close Windows Job Object, so
closing a pane, a workspace or the app ends everything started in it
(`src-tauri/host/src/job.rs`, `src-tauri/src/pty.rs`). Settings → Terminal can
limit the priority class from process birth and add a CPU cap
([ADR 0005](adr/0005-job-object-priority.md)). The optional terminal host
(`swarmterm-host.exe`, [ADR 0001](adr/0001-terminal-host-process.md)) spawns
only what the app sends it, with the environment cleared first.

### Local MCP server

The MCP server binds only `127.0.0.1` on a random port
(`src-tauri/src/mcp/mod.rs`). Each pane gets its own bearer token in its environment
(`SWARMTERM_SESSION`): a random 256-bit secret minted for every spawn and
rotated on respawn, separate from the pane id that War Room peers can see
(`src-tauri/src/mcp/session_tokens.rs`). A request without an
`Authorization: Bearer` header carrying the token of a live pane is refused,
and the token stops working when the pane ends (`src-tauri/src/mcp/server.rs`).
The same check guards `/hook` and `/status`, so one pane cannot act as another.
Exception: a pane that survived in the terminal host from a build before
per-pane secrets keeps its id as bearer until it is respawned (logged as
`no session secret in meta`).
Tools: open a web preview (http/https URLs only), list/spawn/remove worktrees
(only in workspaces with worktree isolation on; removal refuses uncommitted
changes and paths outside `<repo>.worktrees`), and the War Room tools.
Settings → MCP removes the server entry from an agent profile's configuration.

### War Room

War Room tools work only for panes the user dragged into a room; removing a
pane revokes access at once. "Probe" messages wait in an inbox; "execute"
pastes and runs a prompt in another agent pane and is refused toward plain
shells and toward a pane waiting on a prompt. Agents may use "execute" only
when Settings → Terminal → Agent safety → "Allow agents to run prompts in
other panes" is on (off by default); otherwise the server refuses it and tells
the agent to use a probe. The user's own Moderator messages are not gated.
Deliveries are held while the user types in the target pane.

### Worktrees

With worktree isolation on, each agent pane works in its own Git worktree and
branch, so each agent's changes are a separate, reviewable diff. Closing panes
never deletes worktrees.

### Launch modes

Agent panes start in the mode chosen in the composer. The default is the
agent's normal confirming mode (Claude Code `--permission-mode default`, Codex
workspace-write with on-request approval). Bypass modes ("Bypass
permissions", "YOLO") are explicit choices; they disable the agent's own
confirmations and are the user's responsibility. Choosing one asks for
confirmation first, and a pane running one carries a red badge in its header.
Worker panes an agent starts with `worktree.spawn` do not inherit a bypass mode
by default; they start in the agent's confirming mode. The user can opt in
(Settings → Terminal → Agent safety, "Spawned workers inherit Bypass/YOLO",
default off) to let a worker of the same agent inherit the requester's bypass
mode; the administrator policy `DisableBypassModes` forces this off.

### Environment filtering

By default panes and command routines do not inherit secret-looking variables
from the application's environment: names ending in `_TOKEN`, `_API_KEY`,
`_SECRET`, `_PASSWORD`, `_PASS`, `_PWD`, `_KEY`, `_PRIVATE_KEY`,
`_CREDENTIAL(S)`, `_AUTHTOKEN`, `_ACCESSTOKEN`, `_AUTH_CONFIG` and similar,
names with a `TOKEN`, `SECRET`, `PASSWORD`, `CREDENTIAL`, `AUTHTOKEN` or
`ACCESSTOKEN` segment anywhere (`AWS_BEARER_TOKEN_BEDROCK`), the `SECRET_`
prefix, and `DATABASE_URL`, `PGPASSWORD`, `MYSQL_PWD`. Names that only say
where or how a secret is kept pass: the segment rule skips names ending
`_STORE`, `_PROVIDER(S)`, `_HELPER`, `_MANAGER` (`GCM_CREDENTIAL_STORE`,
`CARGO_REGISTRY_CREDENTIAL_PROVIDER`), and public keys (`*_PUBLIC_KEY`, and
`GPG_KEY`, which holds a key id) are not secrets. Any variable whose value
is a URL with credentials (`http://user:pw@proxy`, `redis://:pw@host`,
`https://token@host`) or an `Authorization:`/`Bearer ` header
(`ANTHROPIC_CUSTOM_HEADERS`, any `*_HEADERS`) is dropped whole rather than
redacted, since a URL without its password fails anyway. A bare user name
counts as a credential except for SSH URLs: `DOCKER_HOST=ssh://user@host`
names the login, while SSH authenticates with keys or the agent. Paths to secrets
(`AWS_SHARED_CREDENTIALS_FILE`, `AWS_WEB_IDENTITY_TOKEN_FILE`,
`AWS_CONTAINER_CREDENTIALS_RELATIVE_URI`; names ending `_FILE`, `_PATH`, `_DIR`,
`_URI`, `_URL`) pass unless their value embeds credentials. Other
config blobs, such as an inherited `OPENCODE_CONFIG_CONTENT`, pass Default
mode even if they embed keys; Strict drops them. Provider configuration such as
`AWS_REGION`, `AWS_PROFILE`, `ANTHROPIC_BASE_URL` and `OPENAI_BASE_URL` passes
(Bedrock and corporate LLM gateways need it), as do `PATH`, system variables,
proxies without credentials and certificate variables (`SSL_CERT_FILE`,
`NODE_EXTRA_CA_CERTS`, `REQUESTS_CA_BUNDLE`). A strict mode keeps only system
variables plus what corporate networks and lockdowns rely on:
`__PSLockdownPolicy` (dropping it would lift a PowerShell constrained-language
lockdown set by that variable), `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` (any
case; still dropped when the URL carries credentials) and the CA variables
`SSL_CERT_FILE`, `SSL_CERT_DIR`, `NODE_EXTRA_CA_CERTS`, `REQUESTS_CA_BUNDLE`,
`CURL_CA_BUNDLE`, `GIT_SSL_CAINFO`. An allow list passes named variables
(`src-tauri/src/terminal_env.rs`, Settings → Terminal → Environment).

The same filter applies to every child process Swarmterm starts, through one
helper (`terminal_env::command`, environment cleared, then the filtered copy):

| Child process | Where |
|---|---|
| Panes (in-process and terminal host) | `pty::plan_spawn` |
| Command routines | `routine_cmd.rs` |
| git (status, diff, worktree add/list/remove) | `git.rs`, `files/git.rs` |
| Editors ("Open in editor"), MarkText | `commands.rs::open_in_editor`, `files/marktext.rs` |
| Reveal in Explorer, WSL probe | `links.rs`, `shell.rs` |
| Codex `--help` probe, `opencode session list` | `hook/codex.rs`, `sessions/opencode.rs` |
| Voice companion (buzzkey) launch and hardware probe | `voice/companion/system.rs` |

Exceptions: the terminal host process (`swarmterm-host.exe`) is Swarmterm's own
binary and clears its environment before each pane; images, videos and HTML
opened "in the default application", and web links opened in the default
browser (the Tauri opener's `open_url`), go through the Windows shell
(`ShellExecute`), whose handler may receive the app's environment, because the
shell offers no way to pass a filtered one.

Git run by Swarmterm itself always passes `-c core.fsmonitor=`, so a repository
config written by an agent cannot make Swarmterm run a program on every status.
Only fsmonitor is overridden: Swarmterm's calls are local, non-interactive and
read porcelain output, so they do not reach `core.pager`, `core.sshCommand`,
`credential.helper`, `diff.external` or textconv; a repo config can still set
`core.hooksPath` for the hooks below.
Hooks still run where git runs them (`worktree add` → `post-checkout`), since
users rely on LFS or setup hooks there; they get the filtered environment.

The user's setting is also persisted on the Rust side (`env-policy.json` in the
app data folder) and loaded at start, so panes restored at boot and early
routines use it before the renderer's push arrives. Only the very first start
after an upgrade, before the setting was ever pushed, uses the built-in default.

The filter is hygiene, not isolation: user-scope variables in
`HKCU\Environment` and files in the user profile are readable by any process
in a pane anyway. It keeps secrets that were only exported into Swarmterm's own
launch environment away from agents. For corporate use set `EnvPolicy=strict`
(`docs/admin-policy.md`) and allow-list what the agents need.

### Voice pipe

The voice companion talks to the app over a named pipe restricted to the
current user, with a per-launch token, and can only insert text into a pane (the
focused one, or one the user names by number or name); it cannot run
commands (`src-tauri/src/voice/`).

### Companion installer

buzzkey is downloaded only from an HTTPS host allowlist (GitHub), enforced on
every redirect. The release's `SHA256SUMS.txt` must carry a valid minisign
signature from the key compiled into the app, then every file's size and
SHA-256 must match before a staged install with rollback
(`src-tauri/src/voice/companion/`). Speech models are checked against fixed
SHA-256 hashes (`src-tauri/src/voice/speech/model.rs`).

### Supply chain

CI runs `cargo deny` (RustSec advisories, licence allow list, crate sources)
and `npm audit` for production dependencies on every push and pull request,
plus a secret scan of the history. Each release attaches CycloneDX SBOMs for
the Rust and npm dependencies with SHA-256 checksums.

### Administrator policy

Organisations can lock features through `HKLM\Software\Policies\SwarmtermGN`
(GPO/Intune; ADMX in `docs/admin/`) and, weaker, the same key under HKCU; HKLM
wins per value. The policy is read once at start and cannot be changed while
the app runs. Each lock is enforced in the backend at the point of action
(`src-tauri/src/policy.rs`): bypass launch lines, War Room execute,
`worktree.spawn`, the MCP server and its enrollment, companion install and
updates, speech-model downloads, command routines, the web preview, and a
forced environment filter with an admin allow list. The renderer only greys out
locked controls. Details: [admin-policy.md](admin-policy.md).

### Corp edition

The Swarmterm GN Corp build (Cargo feature `corp`, own identifier
`com.apooooh.swarmterm.gn.corp`) compiles the locks `DisableBypassModes`,
`DisableWarRoomExecute`, `DisableCompanion`, `DisableModelDownload` and
`EnvPolicy=default` into the binary (`policy::Edition::locks`). They are
combined with the registry policy, which can add locks but not lift these. The
buzzkey download/installer and the speech-model download are compiled out, not
only locked; the release workflow fails if their endpoints appear in the Corp
executable. Details: [editions.md](editions.md).

**Limits.** The bypass lock (Corp, or `DisableBypassModes`) is a guard against
mistakes: it refuses the launch flags it recognises for known agents. It is not
a security boundary, because a user can type any flag into a shell pane or run
an agent outside the app. Corporate deployments need the HKLM policy, the
agents' own managed settings (Claude Code `permissions.disableBypassPermissionsMode:
"disable"`, Codex managed `requirements.toml`) and AppLocker/WDAC rules that
allow only the Corp installer's hash or path
([enterprise-deployment.md](enterprise-deployment.md#recommended-deployment)).

### Web preview isolation

Preview pages run in native child webviews (`preview-<terminalId>`) inside the
main window. The app's capability (`src-tauri/capabilities/default.json`) is
scoped to the `main` webview by label (`webviews`, not `windows`), so preview
webviews, which share the main window, get no IPC permissions; commands that
must never be reached from a preview also check the caller's label.

## The user's responsibility

Which agents and launch modes you use, which panes join a War Room, which MCP
servers you add, which folders and commands you open, and reviewing agents'
changes before use. See [TERMS.md](../TERMS.md).
