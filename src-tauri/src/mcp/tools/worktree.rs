//! MCP worktree tools: spawn an agent pane inside a fresh git worktree, list
//! worktrees, remove merged ones. Gated per-terminal on the workspace's
//! "Isolate features in git worktrees" toggle (worktree_mode in the map).

use std::path::Path;

use serde::{Deserialize, Serialize};

/// Wire shapes for the renderer. camelCase must match src/tauri/worktree.ts.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeSpawnEvent {
    pub requester_terminal_id: String,
    pub path: String,
    pub branch: String,
    pub agent: Option<String>,
    pub prompt: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeRemovedEvent {
    pub path: String,
}

/// Valid ids come from `agents.rs::AGENTS` (which mirrors TEMPLATES in
/// src/lib/templates.ts). "terminal" is deliberately absent from that catalog:
/// worktree.spawn exists to start an agent on a task.
pub fn validate_agent_id(agent: Option<&str>) -> Result<(), String> {
    match agent {
        None => Ok(()),
        Some(a) if crate::agents::AGENTS.iter().any(|(id, _)| *id == a) => Ok(()),
        Some(a) => Err(format!(
            "unknown agent \"{a}\" — pass one of: {} (or omit to reuse the calling pane's agent)",
            crate::agents::AGENTS
                .iter()
                .map(|(id, _)| *id)
                .collect::<Vec<_>>()
                .join(", ")
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spawn_event_serializes_camelcase() {
        let ev = WorktreeSpawnEvent {
            requester_terminal_id: "t1".into(),
            path: "C:/dev/myapp.worktrees/feat-login".into(),
            branch: "feat/login".into(),
            agent: None,
            prompt: "Implement login".into(),
        };
        let json = serde_json::to_value(&ev).unwrap();
        assert_eq!(json["requesterTerminalId"], "t1");
        assert_eq!(json["branch"], "feat/login");
        assert_eq!(json["agent"], serde_json::Value::Null);
    }

    #[test]
    fn agent_id_allow_list_tracks_agents_catalog() {
        assert!(validate_agent_id(None).is_ok());
        for (id, _) in crate::agents::AGENTS {
            assert!(validate_agent_id(Some(id)).is_ok());
        }
        assert!(validate_agent_id(Some("terminal")).is_err());
        assert!(validate_agent_id(Some("nope")).is_err());
    }
}

// --- tool methods on the shared server struct ---

use rmcp::handler::server::wrapper::{Json, Parameters};
// `tool` / `tool_router` MUST be imported bare — see mcp/server.rs module docs.
use rmcp::{schemars, tool, tool_router};
use tauri::{Emitter, Manager};

use crate::mcp::server::SwarmtermMcpServer;

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct WorktreeSpawnArgs {
    /// Branch for the new worktree, named after the task (e.g. "feat/login").
    pub branch: String,
    /// The task brief the spawned agent starts working on immediately.
    pub prompt: String,
    /// Agent template id as shown in the workspace composer (e.g.
    /// "claude-code"). Omit to reuse the calling pane's agent.
    pub agent: Option<String>,
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
pub struct WorktreeSpawnResult {
    pub path: String,
    pub branch: String,
    /// Guidance the calling agent should follow after spawning.
    pub note: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct WorktreeRemoveArgs {
    /// Absolute path of the worktree to remove (from worktree.spawn or .list).
    pub path: String,
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
pub struct WorktreeRemoveResult {
    pub ok: bool,
}

#[derive(Debug, Serialize, schemars::JsonSchema)]
pub struct WorktreeListResult {
    pub worktrees: Vec<crate::git::WorktreeInfo>,
}

#[tool_router(router = tool_router_worktree, vis = "pub")]
impl SwarmtermMcpServer {
    #[tool(
        name = "worktree.spawn",
        description = "Create an isolated git worktree for a task and open a new Swarmterm pane running a coding agent inside it. The worktree is created as <repo>.worktrees/<branch-slug> next to the repository, on a new branch. Use this instead of `git worktree add` when delegating a feature/fix to a parallel agent. Dependencies are NOT installed in the fresh worktree — the spawned agent must run project setup first."
    )]
    pub async fn worktree_spawn(
        &self,
        rmcp::handler::server::tool::Extension(parts): rmcp::handler::server::tool::Extension<
            axum::http::request::Parts,
        >,
        Parameters(args): Parameters<WorktreeSpawnArgs>,
    ) -> Result<Json<WorktreeSpawnResult>, rmcp::ErrorData> {
        let terminal = self.caller(&parts)?;
        self.app
            .state::<crate::pty::AppState>()
            .admin_policy
            .check(crate::policy::Lock::WorktreeSpawn)
            .map_err(|m| rmcp::ErrorData::invalid_request(m, None))?;
        let repo_root = self.worktree_ctx(&terminal)?;
        if args.prompt.trim().is_empty() {
            return Err(rmcp::ErrorData::invalid_params(
                "prompt must not be empty",
                None,
            ));
        }
        validate_agent_id(args.agent.as_deref())
            .map_err(|m| rmcp::ErrorData::invalid_params(m, None))?;
        // Catalog membership is not availability: spawning an uninstalled CLI
        // would provision an orphan worktree, return success, and type
        // command-not-found into the new pane. Probe before creating anything.
        if let Some(a) = args.agent.as_deref() {
            if let Some((_, exe)) = crate::agents::AGENTS.iter().find(|(id, _)| *id == a) {
                if crate::agents::find_agent_binary(exe).is_none() {
                    return Err(rmcp::ErrorData::invalid_params(
                        format!(
                            "agent \"{a}\" is not installed on this machine (executable \"{exe}\" not found)"
                        ),
                        None,
                    ));
                }
            }
        }

        let branch = args.branch.clone();
        let created = tauri::async_runtime::spawn_blocking(move || {
            // The spawned pane's env already carries SWARMTERM_MCP_URL/SESSION;
            // the MCP server is registered once at Claude's user scope, so a
            // fresh worktree needs no per-directory .mcp.json.
            crate::git::create_worktree(Path::new(&repo_root), &branch)
        })
        .await
        .map_err(|e| rmcp::ErrorData::internal_error(e.to_string(), None))?
        .map_err(|m: String| rmcp::ErrorData::invalid_params(m, None))?;

        self.app
            .emit(
                "worktree:spawn",
                WorktreeSpawnEvent {
                    requester_terminal_id: terminal.0.clone(),
                    path: created.path.clone(),
                    branch: created.branch.clone(),
                    agent: args.agent,
                    prompt: args.prompt,
                },
            )
            .map_err(|e| rmcp::ErrorData::internal_error(e.to_string(), None))?;

        Ok(Json(WorktreeSpawnResult {
            path: created.path,
            branch: created.branch,
            // Pane-opening is best-effort: the "worktree:spawn" event above is
            // fire-and-forget, and if the requester's pane closed mid-call the
            // renderer silently no-ops. Don't promise a pane that may not show.
            note: "A new agent pane should open inside the worktree and start on the prompt. \
                   If no pane appears, the worktree still exists at this path — check \
                   worktree.list. Do not edit files under that path yourself. Dependencies are \
                   not installed there yet — the new agent handles setup."
                .into(),
        }))
    }

    #[tool(
        name = "worktree.list",
        description = "List all git worktrees of this workspace's repository (path, branch, HEAD, main flag)."
    )]
    pub async fn worktree_list(
        &self,
        rmcp::handler::server::tool::Extension(parts): rmcp::handler::server::tool::Extension<
            axum::http::request::Parts,
        >,
    ) -> Result<Json<WorktreeListResult>, rmcp::ErrorData> {
        let terminal = self.caller(&parts)?;
        let repo_root = self.worktree_ctx(&terminal)?;
        let home = self
            .app
            .path()
            .home_dir()
            .map_err(|e| rmcp::ErrorData::internal_error(e.to_string(), None))?;
        let worktrees = tauri::async_runtime::spawn_blocking(move || {
            crate::git::list_worktrees(Path::new(&repo_root), &home)
        })
        .await
        .map_err(|e| rmcp::ErrorData::internal_error(e.to_string(), None))?
        .map_err(|m| rmcp::ErrorData::internal_error(m, None))?;
        Ok(Json(WorktreeListResult { worktrees }))
    }

    #[tool(
        name = "worktree.remove",
        description = "Remove a swarmterm-created worktree after its branch is merged. Refuses if uncommitted changes remain or the path is not under <repo>.worktrees."
    )]
    pub async fn worktree_remove(
        &self,
        rmcp::handler::server::tool::Extension(parts): rmcp::handler::server::tool::Extension<
            axum::http::request::Parts,
        >,
        Parameters(args): Parameters<WorktreeRemoveArgs>,
    ) -> Result<Json<WorktreeRemoveResult>, rmcp::ErrorData> {
        let terminal = self.caller(&parts)?;
        let repo_root = self.worktree_ctx(&terminal)?;
        let path = args.path.clone();
        tauri::async_runtime::spawn_blocking(move || {
            crate::git::remove_worktree(Path::new(&repo_root), Path::new(&path))
        })
        .await
        .map_err(|e| rmcp::ErrorData::internal_error(e.to_string(), None))?
        .map_err(|m| rmcp::ErrorData::invalid_params(m, None))?;

        self.app
            .emit("worktree:removed", WorktreeRemovedEvent { path: args.path })
            .map_err(|e| rmcp::ErrorData::internal_error(e.to_string(), None))?;
        Ok(Json(WorktreeRemoveResult { ok: true }))
    }
}
