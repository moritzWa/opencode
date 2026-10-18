"""Actual dual helpers against isolated HTTP fixtures, never a live service."""
import http.server
import json
import os
import pathlib
import subprocess
import tempfile
import threading

real_home = pathlib.Path.home()
calls = []


class Handler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        calls.append((self.path, body))
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps({"data": {"id": "ses_fixture"}} if self.path == "/api/session" else {"id": "ses_fixture"}).encode())

    def log_message(self, *_args):
        pass


server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
try:
    with tempfile.TemporaryDirectory(prefix="helper-proof-", dir="/var/folders/n9/hr809bk55vb2tm653_tkg7m00000gn/T/opencode") as temporary:
        home = pathlib.Path(temporary)
        record = home / "selected.json"
        base = {"username": "fixture", "password": "fixture-not-a-secret", "port": server.server_port}
        environment = {**os.environ, "HOME": str(home), "AGENTVIEW_OPENCODE_SERVER_RECORD": str(record)}
        background = real_home / ".claude/scripts/opencode-bg.sh"
        message = real_home / ".claude/scripts/opencode-message.py"
        for version in ["v1", "v2"]:
            record.write_text(json.dumps({**base, "api": version}))
            calls.clear()
            subprocess.run(["bash", str(background), str(home), "fixture-title", "fixture brief"], env=environment, capture_output=True, text=True, check=True)
            assert calls[0][0].split("?")[0] == ("/api/session" if version == "v2" else "/session")
            assert calls[1][0].split("?")[0] == ("/api/session/ses_fixture/prompt" if version == "v2" else "/session/ses_fixture/prompt_async")
            if version == "v2":
                assert calls[0][1]["location"]["directory"] == str(home)
                assert calls[1][1] == {"text": "fixture brief"}
            calls.clear()
            subprocess.run(["python3", str(message), "ses_fixture", str(home), "fixture reply"], env=environment, capture_output=True, text=True, check=True)
            assert calls[0][0].split("?")[0] == ("/api/session/ses_fixture/prompt" if version == "v2" else "/session/ses_fixture/prompt_async")
        selected = home / ".local/state/install-latest/opencode-v2-ref"
        selected.parent.mkdir(parents=True)
        selected.write_text("fork/v2-parity\n")
        profile = home / ".local/share/opencode-v2"
        profile.mkdir(parents=True)
        state = home / "configured-shared-state"
        actual = state / "agentview/opencode/server.json"
        actual.parent.mkdir(parents=True)
        actual.write_text(json.dumps({**base, "api": "v2"}))
        (profile / "profile.json").write_text(json.dumps({"environment": {"XDG_STATE_HOME": str(state)}}))
        environment.pop("AGENTVIEW_OPENCODE_SERVER_RECORD")
        calls.clear()
        subprocess.run(["bash", str(background), str(home), "native-profile", "fixture"], env=environment, capture_output=True, check=True)
        assert calls[0][0] == "/api/session"
        (profile / "runtime").mkdir()
        (profile / "runtime/cutover.pending").write_text("pending")
        calls.clear()
        result = subprocess.run(["bash", str(background), str(home), "blocked", "fixture"], env=environment, capture_output=True)
        assert result.returncode == 75 and not calls
        result = subprocess.run(["python3", str(message), "ses_fixture", str(home), "blocked"], env=environment, capture_output=True)
        assert result.returncode != 0 and not calls
        print("Actual helpers passed V1/V2 wire, exact directory, profile-derived state, and cutover-fence fixtures")
finally:
    server.shutdown()
    server.server_close()
    thread.join(timeout=5)
