# Security policy

## Supported versions

Only the latest release on
[GitHub Releases](https://github.com/apoOooh/swarmterm-gn/releases) receives
security fixes. Fixes ship as a new release; older versions are not patched.
Swarmterm GN supports Windows x64 only.

## Reporting a vulnerability

Report vulnerabilities privately through GitHub Security Advisories:
<https://github.com/apoOooh/swarmterm-gn/security/advisories/new>.
Do not open a public issue for a vulnerability.

If that page is not available (private vulnerability reporting is not yet
enabled for this repository), open a
[GitHub issue](https://github.com/apoOooh/swarmterm-gn/issues/new) that only
asks for a private contact, without any details of the vulnerability. A
maintainer will reply with a private channel.

Please include the affected version, steps to reproduce, the impact you
expect, and any proof of concept.

## Response targets

These are targets of a volunteer project, not guarantees:

| Step | Target |
|---|---|
| Acknowledge the report | 5 working days |
| First assessment (accepted or declined, severity) | 14 days |
| Fix released for critical or high severity | 30 days |
| Fix for medium or low severity | next regular release |

We credit reporters in the advisory unless you ask us not to. We publish an
advisory once a fixed release is available.

## Scope

In scope:

- the Swarmterm GN application and its terminal host (`swarmterm-host.exe`);
- the local MCP server, its per-pane authentication and the MCP tools
  (War Room, worktrees, web preview);
- the voice pipe, hook and status line commands;
- the buzzkey companion installer (signature and hash checks);
- environment filtering for panes, and the release build and publishing
  workflows in this repository.

Out of scope:

- agent CLIs, MCP servers and other programs you run in panes, and what they
  do with the rights you give them (report those to their vendors);
- risks you accept by choosing a permission-bypassing launch mode;
- the Microsoft WebView2 runtime and Windows;
- websites you open in the web preview;
- the original upstream Swarmterm project.

## Verifying releases

Each release ships `SHA256SUMS.txt`, CycloneDX SBOMs and Sigstore-signed build
provenance created by the release workflow. Check a download with
`Get-FileHash -Algorithm SHA256 <file>` against `SHA256SUMS.txt` and
`gh attestation verify <file> --repo apoOooh/swarmterm-gn`; details in
[docs/enterprise-deployment.md](docs/enterprise-deployment.md#verify-a-download).
The installer is not Authenticode-signed (decision 2026-10-29).

The security design is described in
[docs/security-model.md](docs/security-model.md).
