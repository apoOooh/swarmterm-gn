//! `media.show`: an agent hands Swarmterm an image/video it produced so the
//! user sees it in the Media panel. The file may live anywhere (scratch and
//! temp dirs included); `FileService::register_unrooted_media` validates it
//! and allow-lists it for the unrooted `swarmterm-media` route.

use std::path::Path;
use std::sync::Arc;

use rmcp::handler::server::wrapper::{Json, Parameters};
// NOTE: `tool` / `tool_router` MUST be imported bare (see `mcp/server.rs`).
use rmcp::{schemars, tool, tool_router};
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};

use crate::files::FileService;
use crate::mcp::server::SwarmtermMcpServer;
use crate::pty::AppState;

/// Payload of the `media:show` Tauri event; camelCase in lockstep with
/// `onMediaShow` in `src/tauri/files.ts`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaShowEvent {
    pub terminal_id: String,
    pub path: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ShowMediaArgs {
    /// Image or video file (png, jpg, jpeg, gif, webp, mp4, m4v, mov, webm):
    /// an absolute path, or a path relative to the terminal's starting folder.
    pub path: String,
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
pub struct ShowMediaResult {
    pub ok: bool,
    /// Canonical absolute path that is now shown.
    pub path: String,
}

#[tool_router(router = tool_router_media, vis = "pub")]
impl SwarmtermMcpServer {
    #[tool(
        name = "media.show",
        description = "Show an image or video file in the user's Swarmterm Media panel, next to \
                       the calling terminal. Call this whenever you create or update a \
                       screenshot, recording, chart or comparison image the user should look \
                       at, instead of only printing its path. Accepts png, jpg, jpeg, gif, webp, \
                       mp4, m4v, mov or webm; absolute paths or paths relative to the \
                       terminal's starting folder (prefer absolute)."
    )]
    pub async fn show_media(
        &self,
        rmcp::handler::server::tool::Extension(parts): rmcp::handler::server::tool::Extension<
            axum::http::request::Parts,
        >,
        Parameters(args): Parameters<ShowMediaArgs>,
    ) -> Result<Json<ShowMediaResult>, rmcp::ErrorData> {
        let terminal = self.caller(&parts)?;
        let cwd = {
            let state = self.app.state::<AppState>();
            let terminals = state
                .terminals
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            terminals
                .get(&terminal.0)
                .map(|t| t.cwd.clone())
                .ok_or_else(|| rmcp::ErrorData::invalid_request("unknown session", None))?
        };
        let service = self.app.state::<Arc<FileService>>().inner().clone();
        let raw = args.path;
        // Canonicalize/metadata touch the disk (maybe a slow network share):
        // keep it off the async executor.
        let path = tauri::async_runtime::spawn_blocking(move || {
            service.register_unrooted_media(&raw, Path::new(&cwd))
        })
        .await
        .map_err(|e| rmcp::ErrorData::internal_error(e.to_string(), None))?
        .map_err(|m| rmcp::ErrorData::invalid_params(m, None))?;
        let path = crate::files::path::display(&path);
        self.app
            .emit(
                "media:show",
                MediaShowEvent {
                    terminal_id: terminal.0,
                    path: path.clone(),
                },
            )
            .map_err(|e| rmcp::ErrorData::internal_error(e.to_string(), None))?;
        Ok(Json(ShowMediaResult { ok: true, path }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn media_show_event_serializes_camelcase() {
        let json = serde_json::to_value(MediaShowEvent {
            terminal_id: "t1".into(),
            path: "C:\\x.png".into(),
        })
        .unwrap();
        assert_eq!(json["terminalId"], "t1");
        assert_eq!(json["path"], "C:\\x.png");
    }

    #[test]
    fn registration_rejects_non_media_missing_and_accepts_relative() {
        let t = tempfile::tempdir().unwrap();
        let service = FileService::new(t.path().join("history"));
        std::fs::write(t.path().join("a.webp"), [0]).unwrap();
        std::fs::write(t.path().join("a.html"), "<p>").unwrap();
        assert!(service.register_unrooted_media("a.webp", t.path()).is_ok());
        assert!(service.register_unrooted_media("a.html", t.path()).is_err());
        assert!(service
            .register_unrooted_media("nope.png", t.path())
            .is_err());
    }
}
