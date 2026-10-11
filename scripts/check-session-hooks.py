"""Exercise the built pre-Tauri hook CLIs against a real loopback socket.

Usage: python scripts/check-session-hooks.py src-tauri/target/release/swarmterm.exe
No agent config, trust record, conversation or native app window is touched.
"""
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def main():
    requests = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            requests.append((self.path, self.headers.get("Authorization"),
                             json.loads(self.rfile.read(int(self.headers["Content-Length"])))))
            self.send_response(204)
            self.send_header("Content-Length", "0")
            self.send_header("Connection", "close")
            self.end_headers()

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    binary = pathlib.Path(sys.argv[1]).resolve(strict=True)
    env = os.environ.copy()
    env.update(SWARMTERM_MCP_URL=f"http://127.0.0.1:{server.server_port}/mcp",
               SWARMTERM_SESSION="test-terminal", SWARMTERM_PTY_GENERATION="test-generation")
    session_id = "11111111-2222-4333-8444-555555555555"

    def run(command, event, shell=False):
        before = len(requests)
        result = subprocess.run(command, input=json.dumps(event), text=True, capture_output=True,
                                timeout=8, env=env, shell=shell,
                                creationflags=0x08000000 if os.name == "nt" else 0)
        assert result.returncode == 0, result.stderr
        assert result.stdout == "", "Hooks must not emit output to the agent"
        if len(requests) == before:
            return None
        assert len(requests) == before + 1
        path, auth, body = requests[-1]
        assert path == "/hook" and auth == "Bearer test-terminal"
        assert "private" not in json.dumps(body)
        return body

    try:
        for flag, agent in [("--hook", "claude-code"), ("--codex-session-hook", "codex")]:
            for event in ["SessionStart", "UserPromptSubmit"]:
                body = run([str(binary), flag], {"hook_event_name": event, "session_id": session_id,
                                                "prompt": "private", "cwd": "private"})
                assert body and body["session"] == {"agentId": agent, "sessionId": session_id,
                                                     "spawnId": "test-generation"}
        assert run([str(binary), "--hook"], {"hook_event_name": "Stop", "session_id": session_id}) == {"signal": "idle"}
        assert run([str(binary), "--codex-session-hook"], {"hook_event_name": "Stop", "session_id": session_id}) is None
        assert run([str(binary), "--codex-session-hook"], {"hook_event_name": "SessionStart", "session_id": "invalid; command"}) is None
        assert run([str(binary), "--codex-session-hook"], {"hook_event_name": "SubagentStart", "session_id": session_id}) is None
        if os.name == "nt":
            # Run the exact installed command through Windows' command shell,
            # including spaces and an apostrophe in the executable path.
            with tempfile.TemporaryDirectory(prefix="swarmterm's hook check ") as temp:
                copy = pathlib.Path(temp) / "swarmterm.exe"
                shutil.copy2(binary, copy)
                escaped = str(copy).replace("\\", "/").replace("'", "''")
                command = f'powershell.exe -NoProfile -NonInteractive -Command "& \'{escaped}\' --codex-session-hook"'
                body = run(command, {"hook_event_name": "SessionStart", "session_id": session_id}, shell=True)
                assert body and body["session"]["agentId"] == "codex"
        print("Hook CLI checks passed: exact Claude/Codex identities, privacy, silent exit, Windows command quoting.")
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


if __name__ == "__main__":
    main()
