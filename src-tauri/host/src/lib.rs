//! Swarmterm terminal host (ADR 0001, `docs/adr/0001-terminal-host-process.md`).
//!
//! A sidecar process that owns every PTY so panes survive an app quit, crash
//! or update. The app talks to it over a current-user named pipe; see
//! `protocol` for the envelope and `frame` for the wire format. Phase 1
//! (SWA-54) ships the crate and protocol only — the app does not use it yet.

pub mod engine;
pub mod frame;
pub mod input;
#[cfg(windows)]
pub mod job;
pub mod output;
pub mod protocol;
pub mod ring;
#[cfg(windows)]
pub mod security;
#[cfg(windows)]
pub mod server;
