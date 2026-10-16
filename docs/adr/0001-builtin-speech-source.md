# ADR 0001: Built-in speech source

- Status: accepted
- Date: 2026-10-16
- Issue: SWA-38

## Context

Dictation into a pane needs an external app today (buzzkey), which talks to
Swarmterm over the voice pipe (`src-tauri/src/voice/`, SWA-12/SWA-40). That
layer was split so the source-independent logic (`voice::handle`: focus pin,
pill, draft rules, generation-checked write) could also serve an in-process
speech source. The aim here is to make Swarmterm dictate on its own while
buzzkey stays fully supported.

Open questions from SWA-12: engine and licence, model distribution, build
size, GPU in the Windows CI, and a hotkey collision with buzzkey.

## Decision

1. **Engine: whisper.cpp through `whisper-rs` (MIT), CPU only.** No Vulkan or
   CUDA backend, so CI and release runners need no GPU SDK. A GPU backend can
   later become a Cargo feature without touching the rest.
2. **Capture: `cpal` (WASAPI)** on its own thread. The callback only downmixes
   to mono; a linear resample to 16 kHz runs once on stop. Recording is capped
   at 120 s (= `PIN_TTL`).
3. **Models are downloaded, not bundled.** Settings → Voice offers a fixed
   catalog of multilingual ggml models (tiny, base, small, large-v3-turbo q5)
   from `huggingface.co/ggerganov/whisper.cpp`. URL and SHA-256 are compiled
   in; the download streams into a `.part` file, is hashed while writing and
   renamed only on a match. Stored under the local app data dir (`models/`).
4. **Trigger: an app shortcut (`Ctrl+Shift+Space`, toggle) and a microphone
   button in the pane header.** No global hotkey: it would collide with
   buzzkey and would record while Swarmterm is not in front, where there is no
   pane to type into anyway.
5. **Delivery through `voice::handle`.** The source registers an in-process
   connection with the `indicator` capability (`Conn::in_process`), so it gets
   exactly what buzzkey gets: focus pin, listening pill, draft rules,
   `write_terminal_checked`, and `cancelled` pushes for every server-side end
   (pill Stop, pane death, expiry, Voice off). Text is always a draft
   (`submit: false`). The pipe protocol is unchanged.
6. **Off by default.** Built-in speech needs Voice enabled, the built-in switch
   on and the selected model downloaded. Only one dictation runs at a time.

## Build notes

- `whisper-rs-sys` runs bindgen, which needs libclang. CI uses the runner's
  LLVM (`LIBCLANG_PATH`). Its bundled bindings are generated on Linux and fail
  the layout checks on Windows, so `WHISPER_DONT_GENERATE_BINDINGS` is not an
  option.
- The `cmake` crate replaces `CMAKE_<LANG>_FLAGS_RELEASE` with flags that
  carry no optimisation level for MSVC, so ggml would build at `/Od`.
  `src-tauri/.cargo/config.toml` sets `-O2` explicitly, plus a fixed AVX2/FMA/F16C
  baseline (`GGML_NATIVE=OFF`), so a release built on an AVX-512 runner still
  starts on older CPUs.

## Measurements

16-core desktop CPU, release build, 5.3 s English speech (SAPI), 15 threads:

| Build | Model | Time | Transcript |
|---|---|---|---|
| default flags (`/Od`) | base | 7.4–8.4 s | correct |
| `-O2` | base | 1.2 s | correct |
| `-O2` + AVX2 baseline | base | 0.9 s | correct |
| `-O2` + AVX2 baseline | small | 3.0 s | correct |

Release binary: 25.0 MB vs. 21.2 MB before (about +4 MB, statically linked
whisper.cpp). `base` is the default; `small` is the accuracy option.

## Consequences

- Dictation works without buzzkey; buzzkey keeps working unchanged and wins
  nothing from the built-in source (they share pins, so whichever begins last
  owns the pane's pill).
- The first transcription after start also loads the model (in the probe,
  the first run was 70–100 ms slower); the context stays cached until the
  model changes or is deleted.
- Rejected: `tauri-plugin-stt` (Vulkan by default, plugin owns UI flow),
  sherpa-onnx (extra ONNX runtime DLL), bundling models (+150–550 MB installer).
