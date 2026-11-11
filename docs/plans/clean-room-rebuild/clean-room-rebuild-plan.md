# Plan: own product by clean-room rebuild (SWA-59)

Date 2026-11-11. Status: plan, not started. **Not legal advice**; a lawyer reviews the result before the first public or sold release.
Replaces the earlier note `swarmterm/plans/mit-neubau-2026-10-17.md` named in SWA-59 (that file no longer exists in the workspace).

**Goal (user, 2026-11-11):** leave the GPL of the original Swarmterm. Our own app with the same features, own name and icon,
published under MIT or sold as a closed product. Approach: rebuild in a fresh repo by a clean-room process, migrate the code
we wrote ourselves, rewrite the rest from specs.

**User decisions recorded here (2026-11-11):** code we wrote in the fork is ours (authors apoOooh, Pawel Grzesik, SesioN).
AI-authorship copyright questions are out of scope for this plan.

**Kept from the card (2026-10-17):** architecture redesign in the new repo; specs come from our own material (user guide,
testlab/smoke-test scenarios, ADRs), never from fork code. Start when the user declares the feature set mature, then a
cross-examination of the specs with the user, then ADR 0001 (architecture) in the new repo. Lawyer before selling.
The provenance audit below can run before that start.

## 1. Why a rebuild, and the licence choice

- Swarmterm GN is GPL-3.0-only. Upstream (duongducnguyen/swarmterm) added GPL-3.0 on 2026-08-07, last upstream commit
  2026-08-28 (`89f9bb7`, v1.0.4). Commits: upstream 774 of 1,512 (51 %; the "~85 %" in the card description is outdated).
  Surviving code lines (`git blame -w -M -C`, 123k lines): upstream ~31 %, us ~69 %.
- Our code splits into two kinds. **Our own files** (written by us, no upstream code in them) belong to us and can be
  relicensed by us. **Our edits inside upstream files** are ours too, but they only exist as changes to upstream's code;
  the combined file stays GPL. Those parts are rebuilt from specs.
- Licence options (decision D1, before M0):

| Option | What it needs | Notes |
|---|---|---|
| **MIT, public** | MIT LICENSE, all code ours or permissive; notices for Apache/OFL parts | Anyone may fork and sell it; DCO for outside contributors |
| **Proprietary, sold** | "All rights reserved" + EULA, CLA from every outside contributor, private repo | Third-party notices still ship; no copyleft deps at all |
| **Open core** | MIT core + closed paid edition (e.g. Corp) | Two repos or a closed plugin crate; decide edition split early |
| Fallback: **sell GN under GPL** | nothing new | Allowed today; buyers get source and may redistribute |

## 2. No request to upstream (user, 2026-11-11)

Upstream is not asked for a relicence, permission or assignment. The rebuild goes straight to the clean room
below; nothing in this plan contacts upstream.

## 3. Provenance audit (which files may move)

Classes per file:
- **(a) ours, independent** -> may migrate verbatim (then adapted in the new repo).
- **(b) derived from upstream** -> spec input only, never copied.
- **(c) third-party** (herdr, Astera, fonts; listed in REUSE.toml) -> re-taken from the original repo under its licence.

Method (read-only, sequential, from `repo\`; scripts and the 2026-11-11 results are in `swarmterm-gn\plans\`):
1. File list: `git ls-files '*.rs' '*.ts' '*.tsx' '*.js' '*.css'` (plus docs, assets, scripts as separate lists).
2. Upstream path check: `git ls-tree -r --name-only 89f9bb7` -> was the path present at the last upstream commit?
3. First author: `git log --follow --diff-filter=A --format=%an -- <file>` (last line).
4. Line share: `git blame --line-porcelain -w -M -C HEAD -- <file>` -> count `author duongducnguyen` lines.
5. Deep copy check for (a) candidates: same with `-C -C -C` (finds code copied from any upstream file).
6. Coupling: does the file import/call (b) modules? (TS imports, Rust `use crate::...`).
7. Rule: (c) if REUSE-annotated; else (b) if path existed upstream, first author upstream, or upstream share >= 20 %;
   else (a) if deep share < 5 % **and** a reviewer confirms the upstream lines are trivial (imports, braces, idioms) and the
   file was not split out of an upstream file (`git show` of the adding commit: no matching removal elsewhere);
   everything between -> borderline. **Borderline and unsure = (b).**

Output: `provenance.csv` with `path, lines, upstream_lines, upstream_pct, upstream_pct_deep, at_upstream_path,
first_author, imports_b, class, reviewer, decision_note`. Final table is signed off by the lead and kept as evidence.

**Sample result (2026-11-11, all 766 code files, 123,166 lines):**

| Class | Files | Lines | Share |
|---|---|---|---|
| (a) strict: new path, own first author, deep upstream share < 5 % | 399 | 59,546 | 48 % |
| borderline: deep share 5-20 %, or upstream lines already in pass 1 | 49 | 8,347 | 7 % |
| (b) derived (path upstream, upstream first author, or >= 20 % in either pass) | 293 | 53,369 | 43 % |
| (c) third-party ports (herdr, Astera) | 25 | 1,904 | 2 % |

Of the strict (a) lines, 12.6k are tests. Largest independent blocks: voice/speech/TTS (9.6k, 100 %), terminal host crate
`host/` (5.5k + 1.4k tests), Rust file tools (3.4k), policy (1.6k), terminal env filter, MCP stdio bridge, setup assistant,
clipboard media, e2e and perf harnesses. Fully (b): pty, commands, war room backend, git, status line, App shell.
Caveat: 70 of 183 strict-(a) TS source files (7.0k of 14.0k lines) import (b) modules. They move, but their interfaces
are rebound to the new architecture. Docs are mixed (user guide 27 % upstream lines) -> spec input, rewritten.

## 4. Clean-room process for AI agents

**Roles** (two separate sides; nobody moves from the dirty to the clean side):

| Side | Role | Sees | Produces |
|---|---|---|---|
| Dirty | Spec lead (session in `G:\ai\claude\swarmterm-gn`) | GN repo, docs, running app | spec batches, migration list |
| Dirty | Spec writers (Sonnet/Opus) | GN docs and running app first, code only for behaviour not otherwise observable | specs |
| Dirty | Spec sanitizer (Sonnet, read-only) | specs + identifier list from (b) files | pass/fail report per spec |
| Dirty | Migrator | (a) files, provenance.csv | migration commits + records |
| Dirty | Auditor | both repos | similarity/licence scan results (pass/fail + region ids only) |
| Clean | Clean lead, developers, reviewers, test writers | specs, new repo, public vendor docs | the new product |
| Human | User (product owner) | everything | approves spec batches, decisions; does not write clean-repo code from GN memory |

**Information barrier** (enforced, not only briefed):
- Clean workspace root outside the current one: `G:\ai\cleanroom\` with its own CLAUDE.md chain, settings, Kaneo project
  and Claude project memory (sessions started in `G:\ai\claude` load memory entries about Swarmterm internals).
- Strongest control: a separate Windows user for clean sessions, with an NTFS deny ACL on `G:\ai\claude\swarmterm-gn\`,
  the dirty session transcripts/memory (`~\.claude\projects\G--ai-claude*`) and GN app data/install dirs.
- In addition: clean `settings.json` `permissions.deny` for Read/Edit/Glob/Grep on those paths, a path-guard PreToolUse
  hook that denies any tool input naming them (Bash/PowerShell included) and logs attempts; WebFetch/WebSearch deny for
  `github.com/duongducnguyen/swarmterm*`, `github.com/apoOooh/swarmterm-gn*` and upstream's website; no `gh` token with
  access to those repos; no Swarmterm MCP server and no War Room with dirty agents; no access to the SWA board.
- Allowed shared items: `G:\ai\claude\scripts\heavy.ps1` and its `locks\` (one build queue for the machine), public
  herdr/Astera/vendor repos, crates.io/npm.
- One-way drop: `G:\ai\cleanroom-handoff\specs\<batch>\` (written by the dirty side, read-only for the clean side);
  `...\feedback\` the other way (questions, scan region ids; never GPL text).

**Spec format** (Markdown, one file per spec, IDs stable):
- `F-nnn` feature spec: purpose, user stories, behaviour and states, settings and defaults, edge cases, errors, non-goals,
  acceptance tests in plain language (Given/When/Then).
- `P-nnn` interface/format spec: external interfaces described from public vendor docs with links (Claude Code hooks and
  status line, Codex notify, MCP, ConPTY, OSC sequences); own formats only where import of GN data is wanted (fields and
  meaning, new key names allowed).
- `UX-nnn`: layouts, interactions, shortcuts, short labels; long texts are rewritten, never copied.
- `NFR-nnn`: performance targets (from perf-baseline numbers), security and privacy rules, Windows-only scope.
- Forbidden in specs: code or pseudo-code, file/module/function/type/IPC/store names from GN, directory structure,
  copied doc paragraphs, constant tables copied from code (facts restated in prose are fine). Header per spec: id,
  version, writer, sanitizer verdict, approval date. The GN source paths a writer used go into the dirty-side evidence
  log, not into the spec.
- Sanitizer check: automated grep against an identifier list extracted from (b) files (minus public API and domain terms),
  n-gram overlap against GN docs (flag >= 12 identical words), then a read-through. User approves each batch.

**Evidence log** (`G:\ai\cleanroom-evidence\`, append-only, zipped per milestone with SHA-256 list): every agent brief
(name, model, date, side), spec batches with hashes and sanitizer reports, approvals, barrier config snapshots (ACL,
settings, hook) and the hook's deny log, clean-side session transcripts, scan reports, migration records,
provenance.csv.

**Migrating (a) files:** by the Migrator, at the milestone that owns them, after the clean side has defined the
receiving interfaces in the new repo. Each file: copy verbatim, then rebind imports/names to the new interfaces in the
same commit, `chore(migrate): <area> from own prior work`. Record per file in `MIGRATION.csv` (new repo): source path,
source commit, source SHA-256, class, upstream share, reviewer, new path, new commit. After migration the file is normal
clean-side code. Borderline files never migrate; their behaviour goes into a spec.

**Brief templates** (kept in the evidence log):
- Spec writer: "You are on the dirty side. Read <features/docs>, run the app if needed, write specs F-/UX-/P- in the
  format of `specs/README.md`. No code, no internal names, no structure, no copied paragraphs. Record your sources in the
  evidence log."
- Clean developer: "You work only in `G:\ai\cleanroom\<name>\`. Inputs: specs batch <id>, the new repo, public vendor
  docs. Never open, search or fetch Swarmterm or Swarmterm GN code, sites or boards; if a spec is unclear, write a
  question to `feedback\`. Builds/tests through heavy.ps1 (`-Kind`, `-MaxRunMinutes` required). No real AI providers in
  tests."

## 5. Feature inventory and milestones

From user-guide.md, README, decisions.md, docs/adr and the module layout. Sizes S/M/L; order top to bottom.
New architecture is designed by the clean side from specs (not a 1:1 module map).

| # | Milestone | Size | Contents | Migrates (a) | Done when |
|---|---|---|---|---|---|
| M0 | Foundations | S | name, repo, licence files, CI, licence gate, barrier, spec pipeline, evidence log | - | CI green on an empty app; barrier test (denied read is blocked and logged) |
| M1 | Terminal + panes MVP | L | window, ConPTY shells, xterm.js WebGL, split/drag/zoom/float panes, search, links, clipboard/OSC 52, Unicode, shell integration marks, detached terminal host with reattach, job-object priority, workspaces composer, tabs, saved workspaces, templates, folder picker, settings, tray, quit flow, shortcuts, setup assistant | host crate + tests, priority, terminal env filter, setup, perf harness | daily use with plain shells; spec acceptance tests pass; perf >= GN baseline |
| M2 | Agents | L | detection and launch modes for the 10 CLIs, agent state dots (rules re-taken from herdr), hooks install (Claude Code, Codex), notifications + center, attention jump, resume sessions, account profiles, status line, context/rate usage, prompt library, resubmit, broadcast input, routines, handoff, data-shield prompts | agent sessions, accounts, policy parts | each agent starts, shows state, resumes; synthetic hook payloads only |
| M3 | MCP + worktrees + Git | M | in-app MCP server (preview, worktree, peers), MCP catalogue, worktree isolation/naming/cleanup, merge readiness, Git panel | MCP stdio bridge | agent spawns a worktree via MCP and the Git panel shows it |
| M4 | War Room | M | peers, probe/execute, inbox, wait, mentions, transcript, composer | - | two synthetic agents exchange and execute messages |
| M5 | Files, media, preview | L | explorer, CodeMirror editor, Markdown/SVG/HTML/media views, deletion history, media detection in output, gallery/annotate/zoom, image paste, drag and drop, web preview column, themes (re-taken from Astera) | Rust file tools, clipboard media, media libs | GN user-guide file/media scenarios pass |
| M6 | Speech | M | dictation (buzzkey companion, built-in whisper), TTS announcements, reading agent output | voice/speech/TTS (9.6k) | dictation and announcements work with a local model |
| M7 | Editions, policy, security | M | HKLM admin policy, Corp edition, env filter, dangerous-mode dialog, launch-mode safety, no telemetry, privacy | policy | security-model spec checks pass; Corp locks tested |
| M8 | Release, docs, legal | M | installer, updater (new minisign key), code signing, SBOM, user guide written from specs, scans, legal review | - | gates in section 7 passed; v1.0 tagged |

Security parts of M7 (env filter, launch safety) are specified together with M2. GN keeps running meanwhile: new GN
features enter as new specs; spec freeze per milestone.

## 6. New repo setup

- **Name and icon:** shortlist 3-5 names; check EUIPO/TMview, DPMA, USPTO (if sold in the US), GitHub org, npm, crates.io,
  winget id, domains; nothing confusable with "Swarmterm". New icon designed from scratch (not from `icon-source.svg`).
  File a trademark (EU) before a sold release.
- **Repo:** new GitHub repo, private until the legal gate, fresh history (no fork, no history import).
- **Licence files:** MIT: `LICENSE` (MIT, holders = decision D2), `REUSE.toml` default MIT, `LICENSES/` (MIT, Apache-2.0,
  OFL-1.1), `THIRD-PARTY-NOTICES.md`, NOTICE texts of herdr/Astera if they ship one, DCO. Proprietary: EULA, CLA, same
  notices.
- **Third-party re-take:** herdr and Astera from their original repos at a recorded commit, under Apache-2.0, adapted by
  the clean side from the original (not from GN's port); fonts from the font projects' releases (OFL).
- **Dependency gate:** cargo-deny allow-list MIT, Apache-2.0, BSD-2/3, ISC, Zlib, Unicode-3.0, BSL-1.0, CC0-1.0, 0BSD,
  Unlicense, MPL-2.0 (unmodified only); deny GPL/LGPL/AGPL/SSPL/BUSL/non-commercial. npm: licence checker with
  `--onlyAllow` in CI. `reuse lint`. Whisper model download keeps its own licence note.
- **CI** (GitHub Actions, Windows): typecheck, lint, vitest, cargo test, cargo deny, npm licence check, reuse lint,
  CycloneDX SBOM. The similarity scan runs on the dirty side (section 7), not in the clean CI.
- **Release:** new code-signing certificate under the new name, new updater key, winget manifest, release process doc.
- **Workspace rules** in the clean CLAUDE.md: repo + worktrees per feature, heavy.ps1 queue for every build/test with
  `-MaxRunMinutes`, no synthetic CPU load, no real AI providers in tests, semantic commits, no AI attribution, local
  commits and push only after approval, decisions in `docs/decisions.md`, own Kaneo project.

## 7. Verification gates

- **Similarity scan** (Auditor, dirty side, per milestone and before release) of the new repo against upstream `89f9bb7`
  and GN `dev`: jscpd (cross-tree duplicates, min 50 tokens), JPlag and/or Dolos (token-based pair similarity; confirm
  Rust/TS support of the installed version), identifier-set overlap per module, UI string overlap.
  Flag: any shared fragment >= 50 tokens or >= 10 lines not listed in MIGRATION.csv or a library/boilerplate allow-list;
  file pair similarity >= 30 %; module identifier overlap >= 25 %. Flagged regions go to the clean side as
  "reimplement region <id> from spec <F-n>", without GPL text. Gate: zero open flags.
- **Licence scan:** ScanCode toolkit over the whole tree (GPL texts/headers, foreign copyright lines, "Swarmterm",
  upstream author names), cargo-deny, npm check, `reuse lint`, SBOM review. Gate: clean.
- **Evidence review:** barrier logs show no successful access to denied paths; every spec batch sanitized and approved;
  every migrated file recorded.
- **Legal review gate** before the first public MIT release or first sale: counsel with OSS experience (DE/EU) gets the
  evidence package, provenance.csv, MIGRATION.csv, scan reports, trademark search, licence/EULA texts.

## 8. Risks and open questions

Risks:
- A copyleft claim can still argue copied structure/organisation or UI look; mitigations: new architecture from specs,
  new UI design, behaviour-level specs, scans. AI clean-room rewrites are untested in court; the 2026 chardet relicensing
  dispute shows they get challenged (sources below).
- Models may have seen the public upstream repo in training; the scans are the control for that.
- Barrier leaks through shared memory, boards, MCP/War Room, clipboard or a human pasting GN code; mitigated by the
  separate user/root and the hook log.
- Size: ~64k lines are rebuilt from specs (plus ~60k migrated and adapted).
- Feature drift while GN keeps evolving; mitigated by spec batches and per-milestone freeze.

Open questions for the user:
1. D1: MIT public, proprietary, or open core (MIT core + paid Corp)?
2. D2: who holds the copyright and sells: a person, apoOooh and Pawel jointly, or a company? (apoOooh, Pawel Grzesik and
   SesioN count as "us"; is SesioN the same person as Pawel Grzesik?) Both owners confirm the relicence in writing.
3. Name and icon: shortlist, and trademark territories (EU only, EU + US)?
4. Should the new app import GN settings, saved workspaces and accounts (needs P- format specs)?
5. Clean sessions under a separate Windows user (recommended), or settings/hook barrier only?
6. Scope at v1: Windows only again; Corp edition at v1 or later?
7. GN during the rebuild: keep developing (features flow as specs) or freeze to fixes?

Sources: Simon Willison on coding agents and clean-room relicensing (chardet, 2026-03),
https://simonwillison.net/2026/Mar/5/chardet ; Heather Meeker on the chardet controversy,
https://heathermeeker.com/tag/copyleft/ ; Taylor Wessing, AI and assisted programming in open source (2026-06),
https://www.taylorwessing.com/fr/insights-and-events/insights/2026/06/ai-and-assisted-programming-in-open-source ;
Marks & Clerk via Mondaq on "clean room as a service",
https://www.mondaq.com/uk/copyright/1772672/can-ai-legally-clone-open-source-unpacking-clean-room-as-a-service

Files: this plan, `provenance-classify.py` (pass 1, `python -I provenance-classify.py out.csv`),
`provenance-deep-blame.py` (pass 2, `python -I provenance-deep-blame.py deep.csv 0 out.csv`),
`provenance-sample-2026-11-11.csv`, `provenance-sample-deep-2026-11-11.csv`, all in this folder (`docs/plans/clean-room-rebuild/`).
