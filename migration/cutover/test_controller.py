"""Isolated phase tests: real private files/SQLite/HTTP, fake OS and installers.

No test calls the production defaults, reserved installer, launchctl, open, or
signals a live application. Every HTTP server is loopback-only and joined.
"""
from contextlib import closing
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import unittest

from controller import Controller, Settings, MANAGER, PACKAGES, arm, preflight
from host import Host, Refusal, digest, private_json, read_private


class Server:
    def __init__(self, host, version, port=0):
        self.host, self.version = host, version
        self.posts = []
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def handle_api(self):
                from urllib.parse import urlparse
                path = urlparse(self.path).path
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"null")
                if self.headers.get("Authorization") != outer.authorization:
                    self.send_response(401); self.end_headers(); return
                if self.command == "POST":
                    outer.posts.append((path, body))
                result, status = outer.response(self.command, path, body)
                if result == "DROP_ACK":
                    self.close_connection = True
                    self.connection.shutdown(socket.SHUT_RDWR)
                    return
                raw = json.dumps(result).encode()
                self.send_response(status)
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            do_GET = handle_api
            do_POST = handle_api

        class Http(ThreadingHTTPServer):
            allow_reuse_address = True
            daemon_threads = True

        import base64
        self.password = "native-test-private-password" if version == 2 else "a" * 64
        self.authorization = "Basic " + base64.b64encode(("opencode:" + self.password).encode()).decode()
        self.http = Http(("127.0.0.1", port), Handler)
        self.port = self.http.server_port
        self.thread = threading.Thread(target=self.http.serve_forever, daemon=True)
        self.thread.start()
        self.closed = False
        self.notices = {}

    def response(self, method, path, body):
        host = self.host
        if self.version == 1:
            if path == "/global/health": return {"healthy": True}, 200
            if method == "POST" and path == f"/session/{MANAGER}/prompt_async":
                self.notices[body["messageID"]] = body
                return None, 204
            if method == "GET" and path.startswith(f"/session/{MANAGER}/message/"):
                item = self.notices.get(path.rsplit("/", 1)[-1])
                return (item, 200) if item else ({}, 404)
            if path == "/session/status":
                host.polls += 1
                if host.append_latest and not host.appended:
                    with closing(sqlite3.connect(host.s.original)) as db:
                        db.execute("INSERT INTO message VALUES('msg_recruiting_latest',?,?,?,?)",
                            (host.s.checkpoints[1][0], 2, 2, json.dumps({"role": "assistant", "text": "Latest recruiting read-only result"})))
                        db.commit()
                    host.appended = True
                return ({MANAGER: {"type": "busy"}} if host.busy else {}), 200
            return {}, 404
        if path == "/api/info":
            return {"pid": host.info_pid, "version": host.native_version, "capabilities": {"tuiSessionSelect": True, "tuiExecuteCommand": True}}, 200
        if path == "/api/session/active": return {"data": host.unexpected_active}, 200
        if path == "/api/model": return {"data": [{"providerID": "openai", "id": "gpt-6.1-sol", "enabled": True}]}, 200
        if not path.startswith("/api/session/"): return {}, 404
        parts = path.split("/")
        session = parts[3]
        if session not in host.sessions: return {}, 404
        if len(parts) == 4: return {"data": host.sessions[session]}, 200
        resource = parts[4]
        if resource == "message":
            if len(parts) == 6:
                item = next((m for m in host.messages[session] if m["id"] == parts[5]), None)
                return ({"data": item}, 200) if item else ({}, 404)
            return {"data": host.messages[session][-1:][::-1], "cursor": {}}, 200
        if resource in ("inbox", "form", "permission"): return {"data": []}, 200
        if resource == "model":
            host.sessions[session]["model"] = body["model"]
            return None, 204
        if resource == "prompt":
            existing = next((m for m in host.messages[session] if m["id"] == body["id"]), None)
            if not existing:
                host.messages[session].append({"id": body["id"], "type": "user", "text": body["text"], "time": {"created": 10}})
            if host.drop_ack:
                host.drop_ack = False
                return "DROP_ACK", 200
            return {"data": {"id": body["id"], "sessionID": session, "type": "user", "payload": {"text": body["text"]}}}, 200
        return {}, 404

    def close(self):
        if not self.closed:
            self.http.shutdown(); self.http.server_close(); self.thread.join(timeout=3)
            if self.thread.is_alive(): raise AssertionError("Fake service thread survived cleanup")
            self.closed = True


class FakeHost(Host):
    def __init__(self, settings):
        self.s = settings
        self.clock = 0
        self.identities = {}
        self.arguments = {}
        self.signals, self.commands, self.starts, self.opened = [], [], [], []
        self.busy, self.append_latest, self.appended = False, False, False
        self.drop_ack = False
        self.polls = 0
        self.fail_tag = None
        self.spoof_install = False
        self.reuse_before_signal = False
        self.swapped = False
        self.unexpected_active = {}
        self.info_pid = 400
        self.foreign_writers = set()
        self.source_sha = "b" * 40
        self.native_version = "2.0.32-local." + self.source_sha[:10]
        self.sessions, self.messages = {}, {}
        self.services = []
        self.old = Server(self, 1)
        self.services.append(self.old)
        self.native_server = None
        for pid, executable in [(100, settings.logical), (200, settings.dashboard), (300, settings.logical)]:
            self.add_identity(pid, str(executable))

    def add_identity(self, pid, executable):
        argv = (executable + "\0serve\0").encode()
        self.arguments[pid] = argv
        self.identities[pid] = {"pid": pid, "pgid": pid, "uid": os.getuid(), "start": f"{pid}.000001", "executable": executable, "argvSha256": hashlib.sha256(argv).hexdigest()}

    def close(self):
        for server in self.services: server.close()

    def now(self): return self.clock
    def sleep(self, seconds): self.clock += seconds
    def cwd(self, pid): return str(self.s.home)
    def ancestors(self): return [1]
    def argv(self, pid): return self.arguments[pid]

    def identity(self, pid):
        if self.reuse_before_signal and pid == 200 and (self.s.profile / "runtime/cutover.pending").exists() and not self.swapped:
            self.identities[pid] = {**self.identities[pid], "start": "reused.000001"}
            self.swapped = True
        return self.identities.get(pid)

    def group(self, pgid): return [item for item in self.identities.values() if item["pgid"] == pgid]

    def signal_group(self, pgid, signum):
        self.signals.append((pgid, signum))
        for pid in [p for p, item in self.identities.items() if item["pgid"] == pgid]: self.identities.pop(pid)
        if pgid == 100: self.old.close()
        if pgid == 400 and self.native_server: self.native_server.close()

    def listener(self, pid, port):
        return pid in self.identities and any(not server.closed and server.port == port for server in self.services)

    def writers(self, database):
        if Path(database) == self.s.original: return ({100} if 100 in self.identities else ({700} if 700 in self.identities else set())) | self.foreign_writers
        return {400} if 400 in self.identities else set()

    def capture(self, argv, cwd=None, env=None, timeout=10, log=None):
        argv = [str(x) for x in argv]
        if argv[0] == "git":
            if "ls-remote" in argv: return self.source_sha + "\trefs/heads/v2-parity\n"
            if "rev-parse" in argv: return self.source_sha + "\n"
            return ""
        if "--version" in argv: return "agentview 0.1.0" if "agentview" in argv[0] else self.native_version
        if argv[1:] == ["debug", "paths", "db"]:
            return json.loads((self.s.profile / "profile.json").read_text())["environment"]["OPENCODE_DB"]
        if "--json" in argv:
            snapshot = read_private(self.s.profile / "runtime/v1-inventory.json")
            if env and env.get("AGENTVIEW_OPENCODE_API") == "v2":
                for row in snapshot["sessions"]: row["kind"] = "managed"
            return json.dumps(snapshot)
        if argv[0] == "/usr/bin/open":
            assert argv[-4] == "-e"
            request = read_private(argv[-1])
            mode = "v2" if request["environment"].get("AGENTVIEW_OPENCODE_API") == "v2" else "v1"
            pid = 500 if mode == "v2" else 600
            self.add_identity(pid, str(self.s.profile / "bin/native/agentview") if mode == "v2" else str(self.s.dashboard))
            private_json(request["receipt"], {"pid": pid, "pgid": pid,"start":self.identities[pid]["start"]})
            self.opened.append(mode)
            return ""
        raise AssertionError("Unexpected read-only command")

    def run(self, tag, argv, env, cwd, timeout, log):
        self.commands.append(tag)
        if tag == self.fail_tag: raise Refusal("Injected " + tag + " failure")
        s = self.s
        if tag == "backup":
            # Exercise the real bounded helper on the isolated fake source.
            helper = Path(__file__).parents[1] / "backup.py"
            result=subprocess.run([sys.executable, str(helper), str(s.profile), "--source", str(s.original), *(["--frozen-clone"] if sys.platform == "darwin" else [])],
                stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=10)
            if result.returncode: raise AssertionError(result.stderr.decode())
        elif tag == "retain-frozen":
            shutil.copy2(argv[-2], argv[-1])
        elif tag == "offline-import":
            target = Path(read_private(s.profile / "profile.json")["environment"]["OPENCODE_DB"])
            with closing(sqlite3.connect(target)) as db:
                db.execute("CREATE TABLE session_v2 AS SELECT * FROM session")
                db.commit()
                for sid, directory, title in db.execute("SELECT id,directory,title FROM session"):
                    self.sessions[sid] = {"id": sid, "title": title, "location": {"directory": directory}, "agent": "build", "model": {"providerID": "openai", "id": "gpt-6.1-sol"}, "time": {"created": 1, "updated": 2}, "outcome": "succeeded"}
                    rows = db.execute("SELECT id,data FROM message WHERE session_id=? ORDER BY time_created", (sid,)).fetchall()
                    self.messages[sid] = [{"id": mid, "type": "assistant", "content": [{"type": "text", "text": json.loads(data)["text"]}], "time": {"created": 1, "completed": 2}} for mid, data in rows]
        elif tag == "history-audit":
            counts = {"sessions": len(self.sessions), "expected": sum(map(len, self.messages.values())), "missing": 0, "changed": 0}
            private_json(s.profile / "runtime/history-audit.json", {"counts": counts, "warnings": {}, "failures": []})
        elif tag == "install-opencode":
            assert env["INSTALL_LATEST_NO_RESTART"] == "1"
            if self.spoof_install: return
            executable = s.profile / "bin/native/opencode-dev"
            executable.parent.mkdir(parents=True, exist_ok=True)
            executable.write_bytes(b"FAKE-NATIVE-V2")
            profile = read_private(s.profile / "profile.json"); profile["executable"] = str(executable)
            private_json(s.profile / "profile.json", profile)
            s.logical.write_bytes(b"fake-v2-wrapper")
            selected = s.home / ".local/state/install-latest/opencode-v2-ref"
            selected.parent.mkdir(parents=True, exist_ok=True); selected.write_text(s.source_ref)
            private_json(selected.parent / "opencode-dev.json", {"commit": self.source_sha[:10]})
            (selected.parent / "opencode-dev.json").chmod(0o644)
        elif tag == "install-agentview":
            assert env["XDG_STATE_HOME"] == str(s.global_state)
            (s.profile / "bin/native/agentview").write_bytes(b"FAKE-AV-V2")
            private_json(s.home / ".local/state/install-latest/agentview.json",{"commit":self.source_sha[:7]})
            (s.home / ".local/state/install-latest/agentview.json").chmod(0o644)
        elif tag == "handoff-import":
            # The actual phase must release its old lock before invoking CLI.
            fd = os.open(s.state / "server.lock", os.O_RDWR)
            try: fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            finally: os.close(fd)
            manifest = read_private(argv[-1])
            assert all(entry["resume"] is False for entry in manifest["sessions"])
            record = read_private(s.service_file())
            private_json(s.state / "server.json", {"api": "v2", "pid": record["pid"], "sessions": {entry["id"]: entry for entry in manifest["sessions"]}})
        elif tag == "rollback-binary":
            assert env["INSTALL_LATEST_NO_RESTART"] == "1"
            assert env["INSTALL_LATEST_OPENCODE_V1"] == "1"
            s.logical.write_bytes((s.profile / "rollback/opencode-dev-v1").read_bytes())
            (s.home / ".opencode/bin/opencode").write_bytes((s.profile / "rollback/opencode-stock-v1").read_bytes())
            (s.home / ".local/state/install-latest/opencode-v2-ref").write_text("")
        else: raise AssertionError("Unexpected live command boundary: " + tag)

    def start(self, argv, env, cwd, log):
        assert not any(key.startswith("INSTALL_LATEST_") for key in env)
        self.starts.append([str(x) for x in argv])
        if "--service" in argv:
            port = int(argv[-1]); self.add_identity(400, str(self.s.profile / "bin/native/opencode-dev"))
            self.native_server = Server(self, 2, port); self.services.append(self.native_server)
            private_json(self.s.global_state / "opencode/service.json", {"pid": 400, "url": f"http://127.0.0.1:{port}", "password": self.native_server.password})
            return 400
        self.add_identity(700, str(self.s.logical))
        server = Server(self, 1, int(argv[-1])); self.services.append(server)
        return 700


# The production lock implementation itself is exercised, not mocked.
import fcntl


class CutoverTests(unittest.TestCase):
    def test_inherited_rollback_flags_cannot_contaminate_runtime_environment(self):
        script = ("from pathlib import Path; import sys; from controller import Settings; "
                  "s=Settings(*(Path(value) for value in sys.argv[1:])); "
                  "env=s.global_env(); assert not any(key.startswith('INSTALL_LATEST_') for key in env)")
        result = subprocess.run([sys.executable, "-c", script, *map(str, (self.s.home, self.s.repo, self.s.profile,
                                self.s.global_state, self.s.approvals, self.s.ready))],
                                cwd=Path(__file__).parent, capture_output=True, text=True, timeout=10,
                                env={**os.environ, "INSTALL_LATEST_OPENCODE_V1": "1", "INSTALL_LATEST_OPENCODE_ROLLBACK": "/fixture/rollback", "INSTALL_LATEST_OPENCODE_V2_REF": "stale-ref"})
        self.assertEqual(0, result.returncode, result.stderr)

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="cutover-unit-")
        self.addCleanup(self.temp.cleanup)
        home = Path(self.temp.name) / "home"; home.mkdir()
        profile = home / "prod"; repo = home / "repo"
        self.s = Settings(home, repo, profile, home / "state", profile / "approval.json", profile / "ready.json", dashboard_pid=200, frontend_pids=[300], idle_timeout=2, quiet_seconds=1, manager_directory=str(home))
        self.s.ghostty=str(home / "Applications/Ghostty.app")
        for path in [self.s.state, self.s.logical.parent, self.s.dashboard.parent, self.s.original.parent,
                     home / ".local/state/install-latest",
                     home / ".config/opencode",
                     Path(self.s.ghostty) / "Contents/MacOS",
                     home / ".opencode/bin", home / ".claude/scripts", profile / "config/opencode/node_modules",
                     profile / "artifacts", profile / "bin", profile / "rollback/config-v1", profile / "runtime", profile / "reference", repo / "packages/cli"]:
            path.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.s.logical.write_bytes(b"OLD-V1"); (home / ".opencode/bin/opencode").write_bytes(b"OLD-STOCK")
        (Path(self.s.ghostty) / "Contents/MacOS/ghostty").write_bytes(b"FAKE-GUI-NEVER-EXECUTED")
        self.s.dashboard.write_bytes(b"OLD-AV"); self.s.installer.write_text("fake approved installer")
        self.s.checkpoints = []
        for index in range(3):
            path = home / f"checkpoint-{index}.md"; path.write_text("Settled external actions; read-only latest work captured")
            self.s.checkpoints.append((f"ses_peer{index}", str(home), str(path)))
        self.h = FakeHost(self.s); self.addCleanup(self.h.close)
        env = {"OPENCODE_CONFIG_DIR": str(profile / "config/opencode"), "XDG_CONFIG_HOME": str(profile / "config"),
               "XDG_DATA_HOME": str(profile / "data"), "XDG_CACHE_HOME": str(profile / "cache"),
               "XDG_STATE_HOME": str(self.s.global_state), "OPENCODE_DB": str(profile / "data/opencode/opencode.db")}
        private_json(profile / "profile.json", {"root": str(profile), "environment": env, "executable": str(repo / "candidate")})
        private_json(profile / "config/opencode/opencode.jsonc",{"plugins":[{"package":str(profile / "config/opencode/ports/todo-server"),"options":{"legacyDatabasePath":str(profile / "data/opencode/history-v1.db")}}]})
        packages, hashes = {}, {}
        for index, name in enumerate(sorted(PACKAGES)):
            path = profile / "artifacts" / f"{index}.tgz"; path.write_bytes(name.encode()); path.chmod(0o400)
            packages[name] = str(path); hashes[name] = digest(path)
        private_json(profile / "artifacts/manifest.json", {"packages": packages, "sha256": hashes})
        for key, name, data in [("binary", "opencode-dev-v1", b"OLD-V1"), ("compatBinary", "opencode-stock-v1", b"OLD-STOCK")]:
            (profile / "rollback" / name).write_bytes(data)
        private_json(profile / "rollback/manifest.json", {"binary": {"preserved": str(profile / "rollback/opencode-dev-v1"), "sha256": digest(profile / "rollback/opencode-dev-v1")},
            "compatBinary": {"preserved": str(profile / "rollback/opencode-stock-v1"), "sha256": digest(profile / "rollback/opencode-stock-v1")}, "originalDatabase": str(self.s.original),"originalConfig":str(home / ".config/opencode")})
        helpers = {}
        for name in ("opencode-bg.sh", "opencode-message.py"):
            path = home / ".claude/scripts" / name; path.write_text("fake proved helper"); helpers[str(path)] = digest(path)
        private_json(self.s.approvals, {"version": 1, "checks": {name: True for name in ("cliPendingGate", "dashboardPendingGate", "parentGlobalXdg", "childProfilePaths", "exactRollbackVerified", "pendingBeforeSelection")}, "installerSha256": digest(self.s.installer), "helperSha256": helpers})
        rows = [{"provider": "opencode", "provider_session_id": session, "name": session, "cwd": str(home), "state": "completed", "kind": "managed"}
                for session in [MANAGER, *[s for s, _, _ in self.s.checkpoints], "ses_completed"]]
        private_json(profile / "runtime/v1-inventory.json", {"sessions": rows, "warnings": []})
        with closing(sqlite3.connect(self.s.original)) as db:
            db.executescript("CREATE TABLE session(id TEXT,directory TEXT,title TEXT); CREATE TABLE message(id TEXT,session_id TEXT,time_created INTEGER,time_updated INTEGER,data TEXT); CREATE TABLE part(id TEXT);")
            for row in rows:
                sid = row["provider_session_id"]
                db.execute("INSERT INTO session VALUES(?,?,?)", (sid, str(home), sid))
                db.execute("INSERT INTO message VALUES(?,?,?,?,?)", ("msg_" + sid, sid, 1, 1, json.dumps({"role": "assistant", "text": "Frozen result"})))
            db.commit()
        self.s.original.chmod(0o600)
        old = self.h.identities[100]
        private_json(self.s.state / "server.json", {"version": 1, "pid": 100, "port": self.h.old.port, "username": "opencode", "password": self.h.old.password,
            "processStartToken": old["start"], "processCmdline": list(self.h.argv(100)), "sessions": {row["provider_session_id"]: {"cwd": str(home)} for row in rows}})
        (self.s.state / "server.lock").touch(mode=0o600)
        state = self.s.global_state / "opencode"; state.mkdir(); (state / "model.json").write_text("original preferences")
        other = self.s.global_state / "agentview/codex-supervisor"; other.mkdir(); (other / "keep").write_text("untouched")
        self.config = profile / "config.json"; private_json(self.config, {})
        report = preflight(self.s, self.h)
        self.directory = profile / "runtime/cutover/test-run"; self.directory.mkdir(parents=True)
        self.plan = {"runID": "test-run", "createdMs": int(time.time() * 1000), "successorInputID": "msg_stable_cutover", "preflight": report}
        self.ready()

    def ready(self):
        private_json(self.s.ready, {"managerSessionID": MANAGER, "ready": True, "runID": "test-run", "expiresAtMs": int(time.time() * 1000) + 60000})

    def controller(self): return Controller(self.s, self.h, self.plan, self.directory)

    def test_preflight_is_read_only_and_binds_archive_and_checkpoint_inputs(self):
        before = {str(p): digest(p) for p in self.s.home.rglob("*") if p.is_file()}
        result = preflight(self.s, self.h)
        after = {str(p): digest(p) for p in self.s.home.rglob("*") if p.is_file()}
        self.assertEqual(before, after); self.assertEqual(3, len(result["checkpoints"]))
        self.assertEqual([], self.h.signals); self.assertEqual([], self.h.commands)

    def test_complete_phase_logic_latest_history_adoption_and_one_successor(self):
        self.h.append_latest = True
        inode = (self.s.state / "server.lock").stat().st_ino
        control = self.controller(); control.run()
        self.assertEqual("handoff_admitted", control.journal["status"])
        self.assertEqual("v2", control.journal["authority"])
        self.assertEqual(6, control.journal["resources"]["sourceCounts"]["message"])
        self.assertEqual(inode, (self.s.state / "server.lock").stat().st_ino)
        self.assertEqual(1, len([p for p, _ in self.h.native_server.posts if p.endswith("/prompt")]))
        self.assertEqual([], self.h.old.posts)
        self.assertFalse((self.s.profile / "runtime/cutover.pending").exists())
        self.assertEqual("untouched", (self.s.global_state / "agentview/codex-supervisor/keep").read_text())
        self.assertEqual(["v2"], self.h.opened)
        journal = self.path_text()
        self.assertNotIn(self.h.old.password, journal); self.assertNotIn(self.h.native_server.password, journal)

    def path_text(self): return (self.directory / "journal.json").read_text()

    def test_lost_http_ack_reconciles_same_id_without_repeating_prompt(self):
        self.h.drop_ack = True
        control = self.controller(); control.run()
        payload = read_private(self.directory / "successor.json")
        again = control.admit_successor(payload["text"])
        self.assertTrue(again["alreadyAccepted"])
        self.assertEqual(1, len([p for p, _ in self.h.native_server.posts if p.endswith("/prompt")]))

    def test_identity_reuse_refuses_signals_and_preserves_fence(self):
        self.h.reuse_before_signal = True
        control = self.controller()
        with self.assertRaises(Refusal): control.run()
        self.assertFalse(any(group == 200 for group, _ in self.h.signals))
        self.assertNotIn("backup", self.h.commands)
        self.assertEqual([f"/session/{MANAGER}/prompt_async"], [path for path, _ in self.h.old.posts])

    def test_audit_failure_restores_exact_v1_without_replaying_old_work(self):
        self.h.fail_tag = "history-audit"
        control = self.controller()
        with self.assertRaises(Refusal): control.run()
        self.assertEqual("rolled_back", control.journal["status"])
        restored = read_private(self.s.state / "server.json")
        self.assertEqual(700, restored["pid"]); self.assertEqual("v1", restored["api"])
        self.assertEqual(b"OLD-V1", self.s.logical.read_bytes())
        self.assertEqual(b"OLD-STOCK", (self.s.home / ".opencode/bin/opencode").read_bytes())
        self.assertFalse((self.s.profile / "runtime/cutover.pending").exists())
        self.assertEqual(["v1"], self.h.opened)
        self.assertTrue((self.s.profile / "rollback/test-run/frozen-v1.db").exists())
        self.assertEqual([], self.h.old.posts)
        commands=list(self.h.commands); starts=list(self.h.starts)
        control.rollback()
        self.assertEqual(commands,self.h.commands); self.assertEqual(starts,self.h.starts)

    def test_zero_exit_without_installation_evidence_is_not_success(self):
        self.h.spoof_install = True
        control = self.controller()
        with self.assertRaises(Refusal): control.run()
        self.assertEqual("rolled_back", control.journal["status"])
        self.assertIsNone(self.h.native_server)

    def test_failure_after_authority_never_restarts_v1(self):
        self.h.fail_tag = None
        # A late dashboard publication failure must retain the healthy V2 server.
        original = self.h.capture
        def capture(argv, **kwargs):
            if str(argv[0]) == "/usr/bin/open": raise Refusal("Injected GUI publication failure")
            return original(argv, **kwargs)
        self.h.capture = capture
        control = self.controller()
        with self.assertRaises(Refusal): control.run()
        self.assertEqual("v2_needs_recovery", control.journal["status"])
        self.assertIn(400, self.h.identities); self.assertNotIn(700, self.h.identities)
        self.assertNotIn("rollback-binary", self.h.commands)

    def test_busy_manager_times_out_before_fence_or_signals(self):
        self.h.busy = True
        control = self.controller()
        with self.assertRaises(Refusal): control.run()
        self.assertEqual([], self.h.signals)
        self.assertFalse((self.s.profile / "runtime/cutover.pending").exists())

    def test_launchd_arm_is_one_shot_external_and_not_bootstrapped(self):
        result = arm(self.s, self.h, self.config)
        import plistlib
        value = plistlib.loads(Path(result["plist"]).read_bytes())
        self.assertFalse(value["KeepAlive"])
        self.assertIn("--wait", value["ProgramArguments"])
        self.assertEqual(1, sum(arg.endswith("heavy-job.py") for arg in value["ProgramArguments"]))
        self.assertNotIn("password", json.dumps(value))
        self.assertEqual([], self.h.commands); self.assertEqual([], self.h.signals)

    def test_archive_mutation_refuses_preflight(self):
        manifest = read_private(self.s.profile / "artifacts/manifest.json")
        path = Path(next(iter(manifest["packages"].values())))
        path.chmod(0o600); path.write_bytes(b"changed")
        with self.assertRaises(Refusal): preflight(self.s, self.h)

    def test_unreviewed_database_writer_refuses_before_downtime(self):
        self.h.foreign_writers={999}
        control=self.controller()
        with self.assertRaises(Refusal): control.run()
        self.assertEqual([],self.h.signals)
        self.assertEqual("refused_before_actions",control.journal["status"])

    def test_shutdown_waits_for_delayed_database_handle_release(self):
        original = self.h.writers
        released = []
        def writers(database):
            if Path(database) == self.s.original and 100 not in self.h.identities and 400 not in self.h.identities:
                if not released:
                    released.append(self.h.now() + 2)
                if self.h.now() < released[0]:
                    return {100}
            return original(database)
        self.h.writers = writers
        control = self.controller()
        control.run()
        self.assertEqual("handoff_admitted", control.journal["status"])
        self.assertTrue(released)

    def test_verified_rollback_wakes_only_manager_once_for_diagnosis(self):
        self.h.fail_tag = "history-audit"
        control = self.controller()
        with self.assertRaises(Refusal):
            control.run()
        self.assertEqual("rolled_back", control.journal["status"])
        recovered = self.h.services[-1]
        self.assertEqual(1, len(recovered.posts))
        path, body = recovered.posts[0]
        self.assertEqual(f"/session/{MANAGER}/prompt_async", path)
        self.assertIn("NOT V2", body["parts"][0]["text"])
        self.assertEqual("admitted", control.journal["resources"]["rollbackNotice"]["state"])
        control.notify_rollback()
        self.assertEqual(1, len(recovered.posts))

    def test_shutdown_reports_surviving_writer_without_signalling_it(self):
        original = self.h.writers
        self.h.writers = lambda database: ({999} if Path(database) == self.s.original and 100 not in self.h.identities else original(database))
        control = self.controller()
        with self.assertRaisesRegex(Refusal, r"writerPIDs=\[999\]"):
            control.run()
        self.assertNotIn("backup", self.h.commands)
        self.assertFalse(any(group == 999 for group, _ in self.h.signals))

    def test_updated_checkpoint_requires_renewed_arm(self):
        Path(self.s.checkpoints[1][2]).write_text("Renewed recruiting checkpoint")
        control=self.controller()
        with self.assertRaises(Refusal): control.run()
        self.assertEqual([],self.h.signals)
        self.assertFalse((self.s.profile / "runtime/cutover.pending").exists())

    def test_wrong_ready_run_cannot_start_cutover(self):
        ready=read_private(self.s.ready); ready["runID"]="another-run"; private_json(self.s.ready,ready)
        control=self.controller()
        with self.assertRaises(Refusal): control.run()
        self.assertEqual([],self.h.signals)

    def test_live_hold_refuses_arming_and_dead_hold_is_retained_privately(self):
        path=self.s.global_state / "agentview/holds/opencode/ses_completed/old.cut.json"
        private_json(path,{"pid":300,"owner":100,"expires_ms":int(time.time()*1000)+60000})
        with self.assertRaises(Refusal): preflight(self.s,self.h)
        private_json(path,{"pid":999,"owner":100,"expires_ms":int(time.time()*1000)+60000})
        # Legacy hold files can be 0644; backup directory/file stays private.
        path.chmod(0o644)
        self.controller().run()
        self.assertFalse(path.exists())
        saved=self.s.profile / "rollback/test-run/holds/ses_completed/old.cut.json"
        self.assertTrue(saved.exists()); self.assertEqual(0o600,saved.stat().st_mode & 0o777)

    def test_replacing_locked_inode_fails_fenced_without_guessed_restart(self):
        original=self.h.signal_group
        def signal_group(pgid,signum):
            original(pgid,signum)
            if pgid==300:
                path=self.s.state / "server.lock"; path.unlink(); path.touch(mode=0o600)
        self.h.signal_group=signal_group
        control=self.controller()
        with self.assertRaises(Refusal): control.run()
        self.assertEqual("failed_fenced",control.journal["status"])
        self.assertTrue((self.s.profile / "runtime/cutover.pending").exists())
        self.assertEqual([],self.h.starts)

    def test_original_binary_and_other_harness_state_are_not_migrated(self):
        original=digest(self.s.original)
        self.controller().run()
        self.assertEqual(original,digest(self.s.original))
        self.assertEqual("untouched",(self.s.global_state / "agentview/codex-supervisor/keep").read_text())

    def test_api_pid_mismatch_refuses_native_authority_and_rolls_back(self):
        self.h.info_pid=999
        control=self.controller()
        with self.assertRaises(Refusal): control.run()
        self.assertEqual("rolled_back",control.journal["status"])
        self.assertFalse(any(group==999 for group,_ in self.h.signals))
        self.assertNotIn("handoff-import",self.h.commands)
        self.assertEqual([],self.h.native_server.posts)

    def test_controller_descended_from_v1_refuses_before_action(self):
        self.h.ancestors=lambda:[100,1]
        # Read-only preparation may happen in V1; execution must be external.
        self.assertEqual(self.plan["preflight"],preflight(self.s,self.h))
        control=self.controller()
        with self.assertRaises(Refusal): control.run()
        self.assertEqual("refused_before_actions",control.journal["status"])
        self.assertEqual([],self.h.signals)

    def test_successor_input_collision_never_posts_again(self):
        control=self.controller(); control.run()
        self.h.messages[MANAGER][-1]["text"]="Different durable input"
        with self.assertRaises(Refusal): control.admit_successor(read_private(self.directory / "successor.json")["text"])
        self.assertEqual(1,len([p for p,_ in self.h.native_server.posts if p.endswith("/prompt")]))


class EntrySafetyTests(unittest.TestCase):
    @unittest.skipUnless(sys.platform == "darwin", "APFS frozen source clone")
    def test_frozen_backup_preserves_uncheckpointed_wal_and_original(self):
        with tempfile.TemporaryDirectory(prefix="frozen-wal-") as directory:
            root = Path(directory)
            source = root / "source.db"
            (root / "reference").mkdir()
            (root / "bin").mkdir()
            private_json(root / "profile.json", {"environment": {}, "executable": "/bin/false"})
            script = ("import sqlite3,os; db=sqlite3.connect(" + repr(str(source)) + "); "
                      "db.execute('PRAGMA journal_mode=WAL'); "
                      "[db.execute('CREATE TABLE '+name+' (id TEXT)') for name in ('session','message','part')]; "
                      "[db.execute('INSERT INTO '+name+' VALUES (?)',('source-row',)) for name in ('session','message','part')]; "
                      "db.commit(); os._exit(0)")
            subprocess.run([sys.executable, "-c", script], check=True, timeout=10)
            original = digest(source)
            wal = Path(str(source) + "-wal")
            original_wal = digest(wal)
            helper = Path(__file__).parents[1] / "backup.py"
            subprocess.run([sys.executable, str(helper), str(root), "--source", str(source), "--frozen-clone"],
                           check=True, stdout=subprocess.DEVNULL, timeout=15)
            report = read_private(root / "reference/backup.json", require_private=False)
            self.assertEqual({"session": 1, "message": 1, "part": 1}, report["counts"])
            self.assertEqual("ok", report["quick_check"])
            self.assertEqual(original, digest(source))
            self.assertEqual(original_wal, digest(wal))

    @unittest.skipUnless(sys.platform == "darwin", "macOS process exit race")
    def test_identity_handles_exit_between_kernel_and_argv_reads(self):
        child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(10)"], start_new_session=True)
        class ExitingHost(Host):
            def argv(self, pid):
                child.terminate()
                child.wait(timeout=5)
                return super().argv(pid)
        try:
            self.assertIsNone(ExitingHost().identity(child.pid))
        finally:
            if child.poll() is None:
                child.kill()
                child.wait(timeout=5)

    @unittest.skipUnless(sys.platform == "darwin", "APFS clone verification")
    def test_retained_clone_is_independent_of_import_target(self):
        with tempfile.TemporaryDirectory(prefix="cutover clone ") as directory:
            source = Path(directory) / "import target"
            retained = Path(directory) / "retained snapshot"
            source.write_bytes(b"original history")
            Host().capture(["/bin/cp", "-c", str(source), str(retained)])
            source.write_bytes(b"native import changes")
            self.assertEqual(b"original history", retained.read_bytes())
            self.assertNotEqual(source.stat().st_ino, retained.stat().st_ino)

    @unittest.skipUnless(sys.platform=="darwin","macOS kernel group verification")
    def test_readonly_timeout_reaps_its_private_descendants(self):
        host=Host()
        with tempfile.TemporaryDirectory() as directory:
            marker=Path(directory) / "descendant.json"
            script="import os,time,json; child=os.fork(); open("+repr(str(marker))+",'w').write(json.dumps({'pid':os.getpid(),'pgid':os.getpgrp()})) if child==0 else None; time.sleep(30)"
            with self.assertRaises(Refusal): host.capture([sys.executable,"-c",script],timeout=0.5)
            child=json.loads(marker.read_text())
            self.assertEqual([],host.group(child["pgid"]))

    def test_execute_without_arm_is_a_nonoperational_cli_refusal(self):
        result=subprocess.run([sys.executable,str(Path(__file__).with_name("controller.py")),"execute"],capture_output=True,text=True,timeout=5)
        self.assertEqual(2,result.returncode)
        self.assertIn("require --armed",result.stderr)

    def test_kernel_identity_only_returns_whitelisted_metadata(self):
        host=Host()
        if sys.platform!="darwin":
            with self.assertRaises(Refusal): host.identity(os.getpid())
            return
        identity=host.identity(os.getpid())
        self.assertEqual(os.getpid(),identity["pid"])
        self.assertEqual(os.getpgrp(),identity["pgid"])
        self.assertEqual(os.getuid(),identity["uid"])
        self.assertRegex(identity["start"],r"^\d+\.\d{6}$")
        self.assertEqual({"pid","pgid","uid","start","executable","argvSha256"},set(identity))
        self.assertNotIn(b"HOME=",host.argv(os.getpid()))


if __name__ == "__main__":
    unittest.main()
