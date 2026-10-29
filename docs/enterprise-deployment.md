# Enterprise deployment

For IT and security teams rolling Swarmterm GN out to Windows x64 machines. Swarmterm GN is a volunteer open-source
project (GPL-3.0-only) without a vendor contract or paid support; this page collects the facts a deployment review
usually asks for and points to the authoritative documents. For a resubmission to a security review, see the review pack ([English](corp-review/review-pack.en.md), [Deutsch](corp-review/review-pack.de.md)).

## Editions

Which build to deploy (standard or the `corp` build with restricted defaults), and what differs between them: [editions.md](editions.md).

## Install

The release asset `Swarmterm.GN_<version>_x64-setup.exe` is a Tauri NSIS installer in **per-user** mode
(Tauri's default `installMode: currentUser`; `src-tauri/tauri.conf.json` sets no other mode). It needs no
administrator rights and installs for the user who runs it.

| Item | Value |
|---|---|
| Install directory | `%LOCALAPPDATA%\Swarmterm GN\` (`swarmterm.exe`, `swarmterm-host.exe`, `uninstall.exe`) |
| Start menu entry | per user |
| Uninstall registration | `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\` |
| Prerequisite | Microsoft WebView2 Runtime (preinstalled on Windows 11; the installer fetches Microsoft's bootstrapper if it is missing) |

Silent install, run in the user's context (for example an Intune Win32 app with install behaviour **User**):

```powershell
.\Swarmterm.GN_<version>_x64-setup.exe /S
```

NSIS's `/D=<path>` (last argument, no quotes) selects another directory. Installing a newer version over an older one
upgrades it in place; settings are kept. Deploy WebView2 beforehand (Evergreen Standalone installer) on machines
without internet access.

Silent uninstall:

```powershell
& "$env:LOCALAPPDATA\Swarmterm GN\uninstall.exe" /S
```

Uninstalling leaves the user data listed below; delete those folders for a full removal. Test both commands on a
reference machine before a wide rollout.

## Updates

The app contains **no updater** and never checks for or downloads updates of itself. New versions reach users only
when you deploy the new installer. Watch [GitHub Releases](https://github.com/apoOooh/swarmterm-gn/releases) (Watch →
Custom → Releases) for new versions and security fixes; only the latest release receives fixes
([SECURITY.md](../SECURITY.md)).

## Data locations

All data belongs to the Windows user; nothing is written machine-wide. The full table with sources is in
[PRIVACY.md](../PRIVACY.md#data-stored-on-your-computer):

- `%APPDATA%\com.apooooh.swarmterm.gn\`: settings files, account profiles (no credentials), local deletion history.
- `%LOCALAPPDATA%\com.apooooh.swarmterm.gn\`: WebView2 storage (layouts, preferences), downloaded speech models,
  local endpoint descriptions.
- `%TEMP%\swarmterm-paste\`, `swarmterm-marked\`, `swarmterm-clipboard\`: pasted and annotated images.
- Entries the app adds to agent CLI configuration (`~/.claude.json`, `~/.claude/settings.json`, `~/.codex/…`) for its
  MCP server, status line and hooks.

No log files are written by release builds. Terminal output and prompts are not stored.

## Network endpoints

The complete list is in [PRIVACY.md](../PRIVACY.md#network-connections-made-by-the-application). In short:

| Endpoint | When |
|---|---|
| `127.0.0.1` (random port), local MCP server with per-pane tokens | always while running; not reachable from other machines |
| `api.github.com`, `github.com`, `objects.githubusercontent.com`, `release-assets.githubusercontent.com` | buzzkey voice companion check/install, user-initiated (update check only when buzzkey is connected) |
| `huggingface.co` and its download hosts | speech model download, user-initiated |
| any site the user or an agent opens in the web preview; `www.google.com` for search text | web preview, when opened |
| `https:` images referenced by Markdown files the user previews | Markdown preview |

There is no telemetry, crash reporting, licence check or update service. Agent CLIs that users run in panes make
their own connections; those are outside the app (see their vendors' documentation). The administrator policy can
switch off downloads, the web preview and other features (next section).

## Administrator policy

Group Policy / Intune registry values under `HKLM\Software\Policies\SwarmtermGN` lock features such as bypass launch
modes, War Room execute, MCP, downloads, routines, the web preview and the environment filter. They are enforced in
the backend, not only greyed out. ADMX/ADML templates and all values: [admin-policy.md](admin-policy.md).

## Verify a download

Every release has `SHA256SUMS.txt`, CycloneDX SBOMs (`sbom-rust.cdx.json`, `sbom-rust-host.cdx.json`,
`sbom-npm.cdx.json`) and Sigstore-signed SLSA build provenance created by the
[release workflow](../.github/workflows/release.yml) for every installer, SBOM and the checksum file.

```powershell
# 1. Checksum: must equal the installer's line in SHA256SUMS.txt.
Get-FileHash -Algorithm SHA256 .\Swarmterm.GN_<version>_x64-setup.exe

# 2. Provenance (GitHub CLI 2.49 or newer): proves the file was built by
#    apoOooh/swarmterm-gn's release workflow from the tagged commit.
gh attestation verify .\Swarmterm.GN_<version>_x64-setup.exe --repo apoOooh/swarmterm-gn

# Optional: also pin the workflow that produced it.
gh attestation verify .\Swarmterm.GN_<version>_x64-setup.exe --repo apoOooh/swarmterm-gn `
  --signer-workflow apoOooh/swarmterm-gn/.github/workflows/release.yml
```

The same `gh attestation verify` works for `SHA256SUMS.txt` and each SBOM. The installer is **not Authenticode-signed**
(decision 2026-10-29), so SmartScreen may warn about an unknown publisher; checksums and provenance replace the
signature as proof of origin. If your policy only allows signed executables, sign the verified installer with your
organisation's certificate or allow it by hash.

## Security questionnaire

| Question | Answer |
|---|---|
| What data does the app process? | Local files in the project folders the user opens, terminal input/output of local shells and agent CLIs. It is processed on the device only. |
| Does it send data to the vendor or third parties? | No. No telemetry, analytics, crash reports or accounts ([PRIVACY.md](../PRIVACY.md)). Agent CLIs run in panes talk to their own providers under the user's own accounts. |
| Personal data / GDPR | The project receives no personal data, so it acts as neither controller nor processor for app usage. |
| Updates | No self-update. IT deploys new installers; security fixes ship only in the latest release. |
| Authentication | No accounts or logins in the app. The local MCP server accepts only per-pane random tokens and binds to `127.0.0.1`. Agent CLI credentials stay in the CLIs' own files; the app reads login state in memory and never stores or shows tokens. |
| Encryption | No data leaves the device through the app except the listed HTTPS downloads (TLS). Data at rest relies on Windows (BitLocker, user profile ACLs); the app adds no encryption of its own. |
| Code integrity | Open source (GPL-3.0-only); releases built only by GitHub Actions from tagged commits on `main`, with SHA-256 checksums, SBOMs and signed provenance. No Authenticode signature. |
| Secure development | CI: types, unit and browser tests, clippy, `cargo deny` (advisories, licences, sources), `npm audit` and registry signatures, gitleaks secret scan, CodeQL, OpenSSF Scorecard, REUSE licence lint. Actions pinned to commit SHAs; Dependabot updates. Threat model: [security-model.md](security-model.md). |
| Vulnerability handling | Private reports via GitHub Security Advisories; targets: acknowledge in 5 working days, fix critical/high in 30 days ([SECURITY.md](../SECURITY.md)). Advisories are published with the fixed release. |
| Third-party components | Listed in the release SBOMs; copied code and bundled assets in [THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md). Dependency licences are checked against an allow list in CI. |
| Privileges | Runs as the user; no service, driver, elevation or machine-wide change. |
| Central control | Registry policy (HKLM) through Group Policy or Intune ([admin-policy.md](admin-policy.md)). |
| Support | Community support through GitHub issues; no SLA. |
