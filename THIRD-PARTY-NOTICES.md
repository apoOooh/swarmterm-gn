# Third-party notices

## herdr (Apache License 2.0)

The agent-state detection rule data and engine semantics under
`src/lib/agent-state/` are ported (with modifications) from
[herdr](https://github.com/herdr-sh/herdr) — engine
`src/detect/manifest.rs`, rule manifests
`src/detect/manifests/{claude,codex,opencode,github-copilot,qwen,amp,gemini,cursor,antigravity}.toml`.
The per-CLI resume flags and binary names in `src/lib/templates.ts` follow
herdr's `src/agent_resume.rs` and `src/detect/mod.rs` tables (facts, not
copied code).

herdr is licensed under the Apache License, Version 2.0
(http://www.apache.org/licenses/LICENSE-2.0); the full license text is
shipped in this repository at [`licenses/Apache-2.0.txt`](licenses/Apache-2.0.txt).
The ported files are distributed as part of Swarmterm under GPL-3.0
(Apache-2.0 → GPL-3.0 is a one-way compatible combination); each derived
file carries a header noting its origin and that it has been modified.

The rule data and engine semantics above are a **port snapshot** taken at a
point in time, not a live mirror of herdr. Future re-syncs must diff against
the current herdr repository (rules, priorities, region semantics) rather
than assuming this port is still current — herdr's manifests can change
upstream without any signal reaching this repo.
## Astera port (Apache License 2.0)

The theme definitions and pure file-management/editor rules adapted in this fork
come from [parsingk/Astera](https://github.com/parsingk/Astera), commit
`debc3098acd5098299ca956fe024763b2decaf3b`, copyright its original contributors,
under Apache-2.0. The original license is in `licenses/Astera/Apache-2.0.txt`.
Adapted code is identified in `src/lib/theme/` and `src/lib/files/`; the Rust
filesystem backend and Swarmterm integration are new implementations.

Unmodified Geist, IBM Plex Sans/Mono, Public Sans and JetBrains Mono font files
were bundled from Astera. Their SIL Open Font License texts are in `licenses/fonts/`.
Their original copyright and reserved-font-name notices are retained there.
