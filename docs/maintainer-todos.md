# Maintainer to-dos (repository admin)

Open tasks that need **admin rights on `apoOooh/swarmterm-gn`**. Collaborator accounts with push access cannot
do them (the GitHub API answers 404). They come from the corporate-readiness work (2026-10-29); see
`docs/decisions.md` for the background. Tick them off here when done.

## GitHub settings

- [ ] **Private vulnerability reporting** (Settings → Code security → Private vulnerability reporting → Enable).
      `SECURITY.md` points reporters there.

  ```powershell
  gh api -X PUT repos/apoOooh/swarmterm-gn/private-vulnerability-reporting
  ```

- [ ] **Secret scanning and push protection** (Settings → Code security). CI keeps gitleaks in addition.

  ```powershell
  '{"security_and_analysis":{"secret_scanning":{"status":"enabled"},"secret_scanning_push_protection":{"status":"enabled"}}}' |
    gh api -X PATCH repos/apoOooh/swarmterm-gn --input -
  ```

- [ ] **Ruleset: protect `main` and `dev`** against deletion and force-push. Pull requests and required
      status checks are deliberately not enforced: the release process pushes merge commits to `dev` and
      `main` directly (`docs/release-process.md`). Enforce them only together with a switch to PR-based merges.

  ```powershell
  '{"name":"protect main and dev","target":"branch","enforcement":"active","conditions":{"ref_name":{"include":["refs/heads/main","refs/heads/dev"],"exclude":[]}},"rules":[{"type":"deletion"},{"type":"non_fast_forward"}]}' |
    gh api -X POST repos/apoOooh/swarmterm-gn/rulesets --input -
  ```

- [ ] **Ruleset: protect release tags `v*`** (no deletion, no move). The release workflow already refuses
      moved tags; this makes it a server-side rule.

  ```powershell
  '{"name":"protect release tags","target":"tag","enforcement":"active","conditions":{"ref_name":{"include":["refs/tags/v*"],"exclude":[]}},"rules":[{"type":"deletion"},{"type":"update"},{"type":"non_fast_forward"}]}' |
    gh api -X POST repos/apoOooh/swarmterm-gn/rulesets --input -
  ```

- [ ] **Dependabot alerts and security updates** (Settings → Code security), once `.github/dependabot.yml` is
      on `main`.
- [ ] **CodeQL / code scanning**: confirm results arrive under Security → Code scanning after the CodeQL
      workflow lands; enable default setup if the workflow is not used.
- [ ] **Release environment approval** (optional): Settings → Environments → `release` → required reviewers, if a
      second person should approve each publish.

## Not planned

- OpenSSF Best Practices badge (bestpractices.dev): not submitted, by decision (2026-10-29).

- Authenticode signing of the installer (SignPath Foundation, Azure Trusted Signing): skipped by decision
  (2026-10-29). Downloads are verified by `SHA256SUMS.txt`, SBOMs and build provenance instead.
