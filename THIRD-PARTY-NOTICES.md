# Third-party notices

This file lists components whose code or data was copied or ported into this
repository, and bundled assets with their own notices. The complete list of
Rust and npm dependencies with their licences ships with every release as
CycloneDX SBOMs (`sbom-rust.cdx.json`, `sbom-rust-host.cdx.json`, `sbom-npm.cdx.json`, covered by
`SHA256SUMS.txt`). CI enforces the dependency licence allow list in
`src-tauri/deny.toml`.

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
## whisper.cpp / ggml (MIT License)

The built-in speech recognition (`src-tauri/src/voice/speech/`) statically
links [whisper.cpp](https://github.com/ggml-org/whisper.cpp) and ggml through
the `whisper-rs` / `whisper-rs-sys` crates (Unlicense).

```
MIT License

Copyright (c) 2023-2024 The ggml authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

Audio capture uses [cpal](https://github.com/RustAudio/cpal) (Apache License
2.0, [`licenses/Apache-2.0.txt`](licenses/Apache-2.0.txt)). Speech models are
not shipped; they are downloaded on request from
`huggingface.co/ggerganov/whisper.cpp` (MIT).

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
