# Maintainer to-dos (repository admin)

Tasks that need **admin rights on `apoOooh/swarmterm-gn`**. Collaborator accounts with push access cannot
do them (the GitHub API answers 404). They come from the corporate-readiness work (2026-10-29); see
`docs/decisions.md` for the background. Tick them off here when done.

## GitHub settings

Done on 2026-11-09 (verified through the GitHub API):

- [x] **Private vulnerability reporting** (Settings → Code security → Private vulnerability reporting).
      `SECURITY.md` points reporters there. This was required before the corporate resubmission
      (review pack finding 6).
- [x] **Secret scanning and push protection** (Settings → Code security). CI keeps gitleaks in addition.
- [x] **Ruleset `protect main and dev`**: no deletion, no force-push. Pull requests and required status checks
      are deliberately not enforced: the release process pushes merge commits to `dev` and `main` directly
      (`docs/release-process.md`). Enforce them only together with a switch to PR-based merges.
- [x] **Ruleset `protect release tags`** (`refs/tags/v*`): no deletion, no update, no force-push. The release
      workflow already refuses moved tags; this makes it a server-side rule.
- [x] **Dependabot alerts and security updates** (Settings → Code security); `.github/dependabot.yml` is on `main`.
- [x] **CodeQL / code scanning**: the CodeQL workflow uploads results for `main` and `dev` (Security → Code
      scanning); default setup stays off because the workflow is used.
- [x] **Actions policy** (Settings → Actions → General): actions must be pinned to a full-length commit SHA,
      default workflow permissions "Read repository contents".
- [x] **First attested release**: `gh attestation verify` succeeds for both 1.27.0 installers, and the
      Scorecard badge resolves.

Open, only when the condition applies:

- [ ] **Require code owner review** (Settings → Rules) once PR-based merges are used; `.github/CODEOWNERS`
      names the maintainer for workflows, capabilities, Tauri config, `deny.toml`, `policy.rs`, ADMX and the
      policy documents. Without such a rule CODEOWNERS only requests reviews.
- [ ] **Release environment approval** (optional): create the environment `release` with required reviewers,
      reference it from the publish job in `release.yml`, if a second person should approve each publish.

## Not planned

- OpenSSF Best Practices badge (bestpractices.dev): not submitted, by decision (2026-10-29).

- Authenticode signing of the installer (SignPath Foundation, Azure Trusted Signing): skipped by decision
  (2026-10-29). Downloads are verified by `SHA256SUMS.txt`, SBOMs and build provenance instead.
