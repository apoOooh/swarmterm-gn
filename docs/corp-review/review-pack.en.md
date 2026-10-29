# Swarmterm GN: corporate security review pack (v1.26.0)

Answers to the six findings of the previous security review, for Swarmterm GN **1.26.0**. Every statement links to the
file in this repository that implements or documents it. German version: [review-pack.de.md](review-pack.de.md).

**Scope.** Swarmterm GN is an independent project. It started as a fork of
[duongducnguyen/swarmterm](https://github.com/duongducnguyen/swarmterm) and is no longer based on or synced with
upstream; upstream's website, policies and releases do not apply ([decisions](../decisions.md),
[README](../../README.md#origin-and-status)). There is no project website: the authoritative documents are in this
repository.

## The findings

| # | Finding | Status in Swarmterm GN 1.26.0 | Evidence |
|---|---|---|---|
| 1 | Privacy policy and terms of use were placeholder templates. | **Fixed in v1.26.0.** Project-specific privacy policy, terms of use and security policy, with every stored file and network connection listed with its source file. They must be updated in the same change as the behaviour they describe. | [PRIVACY.md](../../PRIVACY.md), [TERMS.md](../../TERMS.md), [SECURITY.md](../../SECURITY.md), [decisions](../decisions.md) |
| 2 | The Claude Code template disabled permission prompts by default. | Agent panes start in the agent's confirming mode (Claude Code `--permission-mode default`, Codex `-s workspace-write -a on-request`). **New in v1.26.0:** bypass modes ("Bypass permissions", "YOLO") need a confirmation dialog, carry a red badge, are not inherited by spawned workers by default, can be locked with the policy `DisableBypassModes`, and are locked in the Corp edition. | [templates.ts](../../src/lib/templates.ts), [DangerousModeDialog.tsx](../../src/components/DangerousModeDialog.tsx), [launch-mode-safety.ts](../../src/lib/launch-mode-safety.ts), [security model](../security-model.md#launch-modes), [admin policy](../admin-policy.md) |
| 3 | Google Analytics telemetry in official releases contradicted "no telemetry". | **Fixed in v1.26.0.** The analytics code is removed; the app sends no telemetry, analytics, crash reports or identifiers. The release workflow fails if `google-analytics` appears in either edition's executable. | [release.yml](../../.github/workflows/release.yml), [PRIVACY.md](../../PRIVACY.md#summary), [decisions](../decisions.md) |
| 4 | Child processes inherit the app's environment, including secrets. | **Fixed in v1.26.0.** Panes and command routines do not receive secret-looking variables (`*_TOKEN`, `*_API_KEY`, `*_SECRET`, `*_PASSWORD`, `DATABASE_URL`, `AWS_*`, `ANTHROPIC_*`, `OPENAI_*`, …); a strict mode passes only Windows system variables. Administrators force the filter with `EnvPolicy` and allow names with `EnvAllow`; in Corp it cannot be switched off. | [terminal_env.rs](../../src-tauri/src/terminal_env.rs), [security model](../security-model.md#environment-filtering), [admin policy](../admin-policy.md) |
| 5 | In-app updates bypass internal software review. | **Fixed in v1.26.0.** The (disabled) updater plugin is removed; the app never checks for or downloads updates of itself. New versions arrive only when IT deploys the installer. The optional buzzkey voice companion installer/updater and the speech-model download are lockable (`DisableCompanion`, `DisableModelDownload`) and compiled out of the Corp edition; the release workflow fails if their endpoints appear in the Corp executable. | [enterprise deployment](../enterprise-deployment.md#updates), [editions](../editions.md), [release.yml](../../.github/workflows/release.yml) |
| 6 | Internal software-development guidelines (dependency audit, SBOM, licences, security contact). | CI runs `cargo deny` (RustSec advisories, licence allow list, sources), `npm audit` and `npm audit signatures`, a gitleaks secret scan, CodeQL, OpenSSF Scorecard and REUSE licence lint; actions are pinned to commit SHAs. Each release ships CycloneDX SBOMs, `SHA256SUMS.txt` and Sigstore-signed build provenance. Private vulnerability reports via GitHub Security Advisories with response targets. | [ci.yml](../../.github/workflows/ci.yml), [codeql.yml](../../.github/workflows/codeql.yml), [scorecard.yml](../../.github/workflows/scorecard.yml), [deny.toml](../../src-tauri/deny.toml), [REUSE.toml](../../REUSE.toml), [SECURITY.md](../../SECURITY.md), [THIRD-PARTY-NOTICES.md](../../THIRD-PARTY-NOTICES.md) |

**Not provided:** the installers are **not Authenticode-signed** (decision 2026-10-29), so SmartScreen may warn about
an unknown publisher. Checksums and signed build provenance replace the signature as proof of origin; organisations
that only allow signed executables can sign the verified installer with their own certificate or allow it by hash.
Swarmterm GN is a volunteer project (GPL-3.0-only) without a support contract or SLA.

## How to verify a download

```powershell
# 1. Checksum: must equal the installer's line in SHA256SUMS.txt from the release.
Get-FileHash -Algorithm SHA256 .\Swarmterm.GN.Corp_1.26.0_x64-setup.exe
# 2. Build provenance (GitHub CLI 2.49+): built by the release workflow of apoOooh/swarmterm-gn.
gh attestation verify .\Swarmterm.GN.Corp_1.26.0_x64-setup.exe --repo apoOooh/swarmterm-gn `
  --signer-workflow apoOooh/swarmterm-gn/.github/workflows/release.yml
```

The same works for `SHA256SUMS.txt` and each SBOM. Details: [enterprise deployment](../enterprise-deployment.md#verify-a-download).

## Recommended deployment for companies

1. Deploy **Swarmterm GN Corp** (`Swarmterm.GN.Corp_<version>_x64-setup.exe`, per-user, silent with `/S`). Bypass
   modes, War Room execute by agents, the buzzkey installer and model downloads are locked or compiled out, and the
   environment filter is always on; no setting or registry value lifts these ([editions](../editions.md)).
2. Add the **HKLM policy** `HKLM\Software\Policies\SwarmtermGN` through Group Policy (ADMX in
   [docs/admin/](../admin/)) or Intune for anything else your rules require, for example `EnvPolicy=strict`,
   `DisableMcp`, `DisableRoutineCommands`, `DisablePreviewBrowser` ([admin policy](../admin-policy.md)).
3. Uninstall the Standard edition where present (both can be installed side by side), and pair the policy with the
   agents' own managed settings (for example Claude Code's `permissions.disableBypassPermissionsMode`), because
   Swarmterm does not sandbox the agents or the shell ([security model](../security-model.md)).
4. Roll out new versions through your software distribution after review; watch GitHub Releases for security fixes.
