#!/usr/bin/env python3
"""One-shot outside-V1 controller. No live actions without execute --armed.

Only the manager arms this program. preflight is read-only; tests use a fake
host and private SQLite/HTTP fixtures, never the default production paths.
"""
import argparse
from contextlib import closing
from dataclasses import dataclass, field
import fcntl
import hashlib
import json
import os
from pathlib import Path
import plistlib
import shutil
import signal
import sqlite3
import stat
import sys
import time
import urllib.parse
import uuid

from host import Host, Refusal, digest, private_json, read_private


MANAGER = "ses_eb9f07705ffeNJGcxTvu16q0bv"
RUNTIME = "8806e2cdf305647b134e3523f21b731a11dfbd00"
PACKAGES = {"cursor-opencode-provider", "@moritz/opencode-parity-plugins", "opencode-read-aloud",
            "@local/opencode-subscription-auth", "@moritz/opencode-todo"}
CHECKPOINTS = [
    ("ses_eb30a3117ffeDyAGrT5lRycVxa", "/Users/m", "/Users/m/beeper-companion-netwatch/CHECKPOINT.md"),
    ("ses_f01e25e61ffe4tn49x10ZJtk3X", "/Users/m/Code/arca", "/Users/m/Documents/arca-outreach-plan/bench/labelers/v1-v2-checkpoint-ses_f01e25e61ffe4tn49x10ZJtk3X.md"),
    ("ses_ece25eb68ffe1SopY2ZHqcvXIu", "/Users/m/Code/arca", "/Users/m/.local/state/opencode/chatgpt-plugin-v2-checkpoint.md"),
]
OTHERS = "claude codex pi copilot cursor antigravity mistral-vibe muse qwen kimi omp grok kilo openhands hermes mastracode devin".split()
PHASES = ("wait_idle", "fence", "lock", "stop_v1", "freeze", "offline_import", "audit",
          "install_v2", "service", "install_dashboard", "adopt", "verify", "authority", "dashboard", "successor")


@dataclass
class Settings:
    home: Path
    repo: Path
    profile: Path
    global_state: Path
    approvals: Path
    ready: Path
    dashboard_pid: int = 4090
    frontend_pids: list = field(default_factory=lambda: [9283])
    source_ref: str = "fork/v2-parity"
    accepted_runtime: str = RUNTIME
    manager_session: str = MANAGER
    manager_directory: str = "/Users/m/Code/opencode"
    checkpoints: list = field(default_factory=lambda: list(CHECKPOINTS))
    idle_timeout: int = 1200
    quiet_seconds: int = 3
    command_timeout: int = 1800
    dashboard_timeout: int = 30
    ghostty: str = "/Applications/Ghostty.app"
    successor_model: dict = field(default_factory=lambda: {"providerID": "openai", "id": "gpt-6.1-sol"})

    @classmethod
    def load(cls, path):
        value = read_private(path)
        allowed = {"profile", "repo", "globalState", "approvals", "ready", "dashboardPID", "frontendPIDs",
                   "sourceRef", "acceptedRuntime", "managerSession", "managerDirectory", "checkpoints",
                   "idleTimeout", "quietSeconds", "commandTimeout", "dashboardTimeout", "ghostty", "successorModel"}
        if set(value) - allowed:
            raise Refusal("Unknown cutover configuration fields")
        home = Path.home()
        profile = Path(value.get("profile", home / ".local/share/opencode-v2"))
        result = cls(home, Path(value.get("repo", home / "Code/opencode/.claude/worktrees/v2-migration")), profile,
                     Path(value.get("globalState", home / ".local/state")),
                     Path(value.get("approvals", profile / "runtime/cutover-approval.json")),
                     Path(value.get("ready", profile / "runtime/cutover-ready.json")))
        mapping = {"dashboardPID": "dashboard_pid", "frontendPIDs": "frontend_pids", "sourceRef": "source_ref",
                   "acceptedRuntime": "accepted_runtime", "managerSession": "manager_session",
                   "managerDirectory": "manager_directory", "checkpoints": "checkpoints", "idleTimeout": "idle_timeout",
                   "quietSeconds": "quiet_seconds", "commandTimeout": "command_timeout",
                   "dashboardTimeout": "dashboard_timeout", "ghostty": "ghostty", "successorModel": "successor_model"}
        for key, name in mapping.items():
            if key in value:
                setattr(result, name, value[key])
        if any(not item.is_absolute() for item in (result.home, result.repo, result.profile, result.global_state, result.approvals, result.ready)):
            raise Refusal("All coordinator paths must be absolute")
        if result.profile.resolve() != (home / ".local/share/opencode-v2").resolve():
            raise Refusal("This controller only cuts over the prepared production opencode-v2 profile")
        if not (1 <= result.idle_timeout <= 3600 and 1 <= result.quiet_seconds <= 30 and 1 <= result.command_timeout <= 3600):
            raise Refusal("Invalid phase bounds")
        return result

    @property
    def state(self):
        return self.global_state / "agentview/opencode"

    @property
    def original(self):
        return self.home / ".local/share/opencode/opencode.db"

    @property
    def installer(self):
        return self.home / ".claude/scripts/install-latest.sh"

    @property
    def logical(self):
        return self.home / ".local/bin/opencode-dev"

    @property
    def dashboard(self):
        return self.home / ".local/bin/agentview"

    def global_env(self):
        env = dict(os.environ)
        profile = json.loads((self.profile / "profile.json").read_text())
        for key in profile["environment"]:
            env.pop(key, None)
        for key in ("AGENTVIEW_OPENCODE_API", "AGENTVIEW_OPENCODE_SERVICE_FILE", "OPENCODE_PASSWORD", "OPENCODE_SERVER_PASSWORD"):
            env.pop(key, None)
        env.update(HOME=str(self.home), XDG_CONFIG_HOME=str(self.home / ".config"),
                   XDG_DATA_HOME=str(self.home / ".local/share"), XDG_CACHE_HOME=str(self.home / ".cache"),
                   XDG_STATE_HOME=str(self.global_state), OPENCODE_CUTOVER_COORDINATOR="1")
        return env

    def native_env(self):
        env = self.global_env()
        env.update(json.loads((self.profile / "profile.json").read_text())["environment"])
        return env

    def av_env(self):
        env = self.global_env()
        env.update(AGENTVIEW_OPENCODE_API="v2", AGENTVIEW_OPENCODE_SERVICE_FILE=str(self.service_file()))
        return env

    def service_file(self):
        return Path(json.loads((self.profile / "profile.json").read_text())["serviceFile"])


def identical(expected, actual):
    return actual is not None and all(actual.get(key) == expected.get(key)
        for key in ("pid", "pgid", "uid", "start", "executable", "argvSha256"))


def source_receipt(settings, host):
    remote, branch = settings.source_ref.split("/", 1)
    remote_line = host.capture(["git", "ls-remote", remote, "refs/heads/" + branch], cwd=settings.repo).split()
    if len(remote_line) != 2:
        raise Refusal("Pushed source ref is unavailable")
    pushed = remote_line[0]
    head = host.capture(["git", "rev-parse", "HEAD"], cwd=settings.repo).strip()
    if head != pushed:
        raise Refusal("Manager branch must be committed and pushed before arming")
    dirty = host.capture(["git", "status", "--porcelain", "--untracked-files=no", "--", "packages", "migration/cutover", "migration/backup.py", "migration/refresh-history.ts", "migration/audit-history.mjs"], cwd=settings.repo)
    if dirty.strip():
        raise Refusal("Runtime/coordinator/offline helper changes must be committed before arming")
    host.capture(["git", "merge-base", "--is-ancestor", settings.accepted_runtime, head], cwd=settings.repo)
    host.capture(["git", "diff", "--exit-code", settings.accepted_runtime, head, "--",
                  *["packages/" + name for name in ("core", "cli", "protocol", "server", "tui", "schema", "client", "sdk", "ai")]], cwd=settings.repo)
    return pushed


def checkpoint_receipts(settings):
    result = {}
    for session, directory, path in settings.checkpoints:
        file = Path(path)
        if not file.is_file() or file.stat().st_size == 0 or not Path(directory).is_dir():
            raise Refusal("Missing durable peer checkpoint: " + session)
        result[session] = {"directory": directory, "path": str(file), "sha256": digest(file)}
    return result


def preflight(settings, host, require_external=False):
    profile = read_private(settings.profile / "profile.json")
    env = profile["environment"]
    expected = {"OPENCODE_CONFIG_DIR": settings.profile / "config/opencode", "XDG_CONFIG_HOME": settings.profile / "config",
                "XDG_DATA_HOME": settings.profile / "data", "XDG_CACHE_HOME": settings.profile / "cache",
                "XDG_STATE_HOME": settings.global_state}
    if any(Path(env.get(key, "")).resolve() != value.resolve() for key, value in expected.items()):
        raise Refusal("Profile must isolate config/data/cache and share only the approved global state root")
    database = Path(env["OPENCODE_DB"])
    if not database.is_absolute() or not database.is_relative_to(settings.profile) or database.exists():
        raise Refusal("Production target must be fresh and inside the production profile")
    if (settings.profile / "data/opencode/history-v1.db").exists():
        raise Refusal("Frozen import target already exists; do not overwrite or promote a rehearsal")
    if not settings.original.is_file():
        raise Refusal("Original V1 database is missing")
    if not (Path(settings.ghostty) / "Contents/MacOS/ghostty").is_file():
        raise Refusal("Reviewed host Ghostty application is missing")
    selected = settings.home / ".local/state/install-latest/opencode-v2-ref"
    if selected.exists() and selected.read_text().strip():
        raise Refusal("V2 selection is already active; this one-shot is not a second cutover")
    for file in (settings.global_state / "opencode").glob("service*.json"):
        lease=read_private(file)
        if not isinstance(lease.get("pid"),int) or lease["pid"]<=1:
            raise Refusal("Unrecognized existing native service lease")
        if host.identity(lease["pid"]) is not None:
            raise Refusal("A native service already owns global state; refuse replacing its lease")
    artifacts = read_private(settings.profile / "artifacts/manifest.json")
    if set(artifacts["packages"]) != PACKAGES or set(artifacts["sha256"]) != PACKAGES:
        raise Refusal("Expected exactly the five accepted archives")
    for name, value in artifacts["packages"].items():
        file = Path(value)
        if not file.resolve().is_relative_to((settings.profile / "artifacts").resolve()) or digest(file) != artifacts["sha256"][name]:
            raise Refusal("Accepted archive fingerprint changed: " + name)
        if file.stat().st_mode & 0o222:
            raise Refusal("Accepted archives must be immutable before arming")
    if not (settings.profile / "config/opencode/node_modules").is_dir():
        raise Refusal("Prepared native plugin dependencies are missing")
    config_path=settings.profile / "config/opencode/opencode.jsonc"
    config=read_private(config_path)
    todos=[entry for entry in config.get("plugins",[]) if str(entry.get("package","")).endswith("/todo-server")]
    if len(todos)!=1 or Path(todos[0].get("options",{}).get("legacyDatabasePath","")).resolve()!=(settings.profile / "data/opencode/history-v1.db").resolve():
        raise Refusal("Prepared Todo legacyDatabasePath must name the final history-v1.db target")
    rollback = read_private(settings.profile / "rollback/manifest.json")
    for key in ("binary", "compatBinary"):
        item = rollback[key]
        if digest(item["preserved"]) != item["sha256"]:
            raise Refusal("Preserved exact V1 binary changed")
    if Path(rollback["originalDatabase"]).resolve() != settings.original.resolve():
        raise Refusal("Rollback source database is not the authoritative V1 store")
    if Path(rollback.get("originalConfig","")).resolve()!=(settings.home / ".config/opencode").resolve() or not (settings.home / ".config/opencode").is_dir():
        raise Refusal("Original V1 config path is not preserved")
    if not (settings.profile / "rollback/config-v1").is_dir():
        raise Refusal("Preserved V1 configuration is missing")
    proof = read_private(settings.approvals)
    checks = {"cliPendingGate", "dashboardPendingGate", "parentGlobalXdg", "childProfilePaths",
              "exactRollbackVerified", "pendingBeforeSelection"}
    if proof.get("version") != 1 or any(proof.get("checks", {}).get(key) is not True for key in checks):
        raise Refusal("Manager's actual launcher/rollback/gate proof is incomplete")
    if proof.get("installerSha256") != digest(settings.installer):
        raise Refusal("Installer differs from the manager-verified helper")
    helpers = proof.get("helperSha256", {})
    if not {str(settings.home / ".claude/scripts/opencode-bg.sh"), str(settings.home / ".claude/scripts/opencode-message.py")} <= set(helpers):
        raise Refusal("Actual pending/default helper proof must bind both global send/launch helpers")
    for path, fingerprint in helpers.items():
        if digest(path) != fingerprint:
            raise Refusal("A manager-verified helper changed")
    old = read_private(settings.state / "server.json")
    if old.get("api","v1")!="v1":
        raise Refusal("Global authority is not the reviewed V1 supervisor")
    lock = settings.state / "server.lock"
    info = lock.lstat()
    if settings.state.is_symlink() or not stat.S_ISREG(info.st_mode) or info.st_uid!=os.getuid() or info.st_mode & 0o077:
        raise Refusal("Existing global supervisor lock/directory is not the private real-file fence")
    backend = host.identity(old["pid"])
    if backend is None or backend["start"] != old["processStartToken"] or hashlib.sha256(bytes(old["processCmdline"])).hexdigest() != backend["argvSha256"]:
        raise Refusal("V1 supervisor kernel identity differs from its credential record")
    if not host.listener(backend["pid"], old["port"]) or host.api(old, "GET", "/global/health").get("healthy") is not True:
        raise Refusal("Original authenticated V1 endpoint is not healthy/owned")
    identities = {"backend": backend}
    for role, pid in [("dashboard", settings.dashboard_pid), *[(f"frontend-{i}", pid) for i, pid in enumerate(settings.frontend_pids)]]:
        item = host.identity(pid)
        if item is None:
            raise Refusal("Expected old process disappeared; refresh the reviewed plan: " + role)
        identities[role] = item
    for role, item in identities.items():
        if item["uid"] != os.getuid() or item["pid"] != item["pgid"]:
            raise Refusal("Refusing a foreign/shared process group: " + role)
        name = Path(item["executable"]).name
        if (role == "dashboard" and "agentview" not in name) or (role != "dashboard" and "opencode" not in name):
            raise Refusal("Reviewed PID is not the expected app role: " + role)
        if require_external and item["pgid"] in (os.getpgrp(), os.getpid()):
            raise Refusal("Coordinator must not live inside a V1-owned process group")
    if require_external and {item["pid"] for item in identities.values()} & set(host.ancestors()):
        raise Refusal("Coordinator is descended from a V1 process; arm through external launchd")
    writers = host.writers(settings.original)
    allowed = {member["pid"] for item in identities.values() for member in host.group(item["pgid"])}
    if not writers <= allowed:
        raise Refusal("Unreviewed processes hold the original database writable")
    holds = settings.global_state / "agentview/holds/opencode"
    for file in holds.glob("*/*.json"):
        hold = read_private(file, require_private=False)
        if hold.get("pid") and host.identity(int(hold["pid"])) is not None:
            raise Refusal("Live OpenCode monitor/background hold must settle before arming")
    return {"version": 1, "sourceSha": source_receipt(settings, host), "installerSha256": proof["installerSha256"],
            "artifactSha256": artifacts["sha256"], "checkpoints": checkpoint_receipts(settings),
            "identities": identities, "originalPort": old["port"], "profileSha256": digest(settings.profile / "profile.json"),
            "approvalsSha256": digest(settings.approvals), "originalDatabase": str(settings.original),
            "dashboardCwd": host.cwd(settings.dashboard_pid),"configSha256":digest(config_path),
            "entrypointSha256":{str(path):digest(path) for path in (settings.logical,settings.dashboard,settings.home / ".opencode/bin/opencode")}}


class Controller:
    def __init__(self, settings, host, plan, directory):
        self.s, self.h, self.plan, self.directory = settings, host, plan, Path(directory)
        self.path = self.directory / "journal.json"
        self.journal = {"version": 1, "runID": plan["runID"], "status": "armed", "authority": "v1",
                        "phases": [], "resources": {}, "successorInputID": plan["successorInputID"]}
        self.lock_fd = None
        self.lock_inode = None
        self.deadline = None

    def save(self):
        private_json(self.path, self.journal)
        private_json(self.s.profile / "runtime/cutover-status.json",{
            "runID":self.plan["runID"],"status":self.journal["status"],"authority":self.journal["authority"],
            "phase":self.current_phase(),"journal":str(self.path),"successorInputID":self.plan["successorInputID"]})

    def run(self):
        if self.path.exists():
            raise Refusal("Journal already exists; use recover/reconcile, never replay a cutover")
        self.save()
        try:
            # Check the sealed plan again before any live action.
            observed = preflight(self.s, self.h, require_external=True)
            if observed != self.plan["preflight"]:
                raise Refusal("Reviewed preflight changed; re-arm before downtime")
            self.journal["status"] = "running"
            for phase in PHASES:
                bound = {"wait_idle": self.s.idle_timeout + 10, "fence": 100, "lock": 45,
                    "stop_v1": 120, "freeze": 1200, "offline_import": 900, "audit": 900,
                    "install_v2": self.s.command_timeout, "service": 60,
                    "install_dashboard": self.s.command_timeout, "adopt": 300,
                    "verify": 300, "authority": 20, "dashboard": self.s.dashboard_timeout + 10,
                    "successor": 60}[phase]
                self.deadline = self.h.now() + bound
                entry = {"phase": phase, "startedMs": int(time.time() * 1000), "boundSeconds": bound, "status": "running"}
                self.journal["phases"].append(entry)
                self.save()
                evidence = getattr(self, phase)()
                entry.update(status="complete", finishedMs=int(time.time() * 1000), evidence=evidence or {})
                self.save()
            self.journal["status"] = "handoff_admitted"
            self.save()
        except BaseException as error:
            if self.journal["phases"]:
                self.journal["phases"][-1].update(status="failed",finishedMs=int(time.time()*1000),errorType=type(error).__name__)
            self.journal["status"] = "failed"
            self.journal["error"] = {"type": type(error).__name__, "phase": self.current_phase(),
                "message": str(error) if isinstance(error, Refusal) else "Inspect private phase logs"}
            self.save()
            if self.journal["authority"] != "v2":
                self.rollback()
                if self.journal["status"] == "rolled_back":
                    self.notify_rollback()
            else:
                # User work may now exist. Never restart V1 after this boundary.
                self.journal["status"] = "v2_needs_recovery"
                self.save()
            raise
        finally:
            self.unlock()

    def current_phase(self):
        return self.journal["phases"][-1]["phase"] if self.journal["phases"] else "preflight"

    def log(self, name):
        path = self.directory / (name + ".log")
        path.touch(mode=0o600, exist_ok=True)
        path.chmod(0o600)
        return path

    def command(self, tag, argv, env=None, timeout=None, cwd=None):
        self.check_budget()
        self.h.run(tag, argv, env or self.s.global_env(), cwd or self.s.repo / "packages/cli",
                   min(timeout or self.s.command_timeout, max(1,self.deadline - self.h.now())) if self.deadline else (timeout or self.s.command_timeout), self.log(tag))
        self.check_budget()

    def check_budget(self):
        if self.deadline is not None and self.h.now() > self.deadline:
            raise Refusal("Phase exceeded its finite bound: " + self.current_phase())

    def api(self, record, method, path, body=None):
        self.check_budget()
        result = self.h.api(record,method,path,body)
        self.check_budget()
        return result

    def wait_idle(self):
        deadline = self.h.now() + self.s.idle_timeout
        stable = None
        while self.h.now() < deadline:
            ready = read_private(self.s.ready) if self.s.ready.exists() else {}
            now_ms = int(time.time() * 1000)
            if (ready.get("managerSessionID") == self.s.manager_session and ready.get("ready") is True
                and ready.get("runID") == self.plan["runID"]
                and now_ms < ready.get("expiresAtMs", 0) <= self.plan["createdMs"] + 30 * 60 * 1000):
                if self.all_idle():
                    stable = self.h.now() if stable is None else stable
                    if self.h.now() - stable >= self.s.quiet_seconds:
                        if checkpoint_receipts(self.s) != self.plan["preflight"]["checkpoints"]:
                            raise Refusal("Peer checkpoint changed while waiting; re-arm with renewed quiescence")
                        return {"sessions": 1 + len(self.s.checkpoints), "quietSeconds": self.s.quiet_seconds}
                else:
                    stable = None
            self.h.sleep(0.25)
        raise Refusal("Manager/peers did not become idle within the bounded wait")

    def all_idle(self):
        old = read_private(self.s.state / "server.json")
        rows = [(self.s.manager_session, self.s.manager_directory), *[(s, d) for s, d, _ in self.s.checkpoints]]
        directories = {d for _, d in rows} | {row["cwd"] for row in old.get("sessions", {}).values()}
        initial = read_private(self.s.profile / "runtime/v1-inventory.json")
        directories.update(row["cwd"] for row in initial["sessions"] if row["provider"] == "opencode")
        for directory in sorted(directories):
            statuses = self.api(old, "GET", "/session/status?" + urllib.parse.urlencode({"directory": directory}))
            # Refuse any active drain, not only the four named roots.
            if any((value.get("type") if isinstance(value, dict) else value) != "idle" for value in statuses.values()):
                return False
        return True

    def fence(self):
        self.pending = self.s.profile / "runtime/cutover.pending"
        if self.pending.exists():
            raise Refusal("A cutover gate already exists")
        private_json(self.pending, {"runID": self.plan["runID"]})
        self.journal["resources"]["gate"] = True
        self.save()
        # Refresh the complete managed/owned inventory before taking its lock.
        args = [self.s.dashboard, "--opencode-bin", self.s.logical,
                *["--no-host-" + name for name in OTHERS], "--all", "--json"]
        snapshot = json.loads(self.h.capture(args, env=self.s.global_env(), timeout=90, log=self.log("fresh-inventory")))
        if snapshot.get("warnings"):
            raise Refusal("Fresh V1 inventory has warnings")
        initial = read_private(self.s.profile / "runtime/v1-inventory.json")
        rows = {row["provider_session_id"]: row for source in (initial, snapshot) for row in source["sessions"] if row["provider"] == "opencode"}
        private_json(self.directory / "inventory.json", {"sessions": list(rows.values()),
            "visibleIDs": [row["provider_session_id"] for row in snapshot["sessions"] if row["provider"] == "opencode"]})
        return {"sessions": len(rows)}

    def lock(self):
        info = self.acquire_global_lock()
        if not self.all_idle():
            raise Refusal("V1 became active after the fence")
        self.backup = self.s.profile / "rollback" / self.plan["runID"]
        self.backup.mkdir(parents=True, mode=0o700)
        shutil.copytree(self.s.state, self.backup / "supervisor", ignore=shutil.ignore_patterns("server.lock"), symlinks=True)
        shutil.copytree(self.s.home / ".config/opencode",self.backup / "config-source",ignore=shutil.ignore_patterns("node_modules",".git"),symlinks=True)
        ownership = self.s.global_state / "agentview/opencode-owned.json"
        if ownership.exists():
            shutil.copy2(ownership, self.backup / "opencode-owned.json")
        state = self.s.global_state / "opencode"
        if state.exists():
            shutil.copytree(state, self.backup / "native-state", symlinks=True)
        self.journal["resources"]["backup"] = str(self.backup)
        self.save()
        return {"lockInode": info.st_ino, "privateBackup": str(self.backup)}

    def acquire_global_lock(self):
        path = self.s.state / "server.lock"
        self.lock_fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        os.set_inheritable(self.lock_fd, False)
        info = os.fstat(self.lock_fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise Refusal("Old supervisor lock is not private/current-user")
        deadline = self.h.now() + 30
        while True:
            try:
                fcntl.flock(self.lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if self.h.now() >= deadline:
                    raise Refusal("Old supervisor lock acquisition exceeded 30 seconds")
                self.h.sleep(0.1)
        self.lock_inode = (info.st_dev, info.st_ino)
        previous = self.journal["resources"].get("lockIdentity")
        if previous and previous != list(self.lock_inode):
            raise Refusal("Original lock inode changed before recovery")
        self.journal["resources"]["lockIdentity"] = list(self.lock_inode)
        self.save()
        return info

    def unlock(self):
        if self.lock_fd is not None:
            fcntl.flock(self.lock_fd, fcntl.LOCK_UN)
            os.close(self.lock_fd)
            self.lock_fd = None

    def stop_identity(self, role, expected):
        actual = self.h.identity(expected["pid"])
        members = self.h.group(expected["pgid"])
        if actual is None and not members:
            return
        if not identical(expected, actual):
            raise Refusal("Process identity changed; refusing signal: " + role)
        if any(item["uid"] != os.getuid() for item in members):
            raise Refusal("Refusing foreign process-group member")
        self.journal["resources"].setdefault("stoppedGroups", {})[role] = members
        self.save()
        for signum in (signal.SIGTERM, signal.SIGKILL):
            remaining = self.h.group(expected["pgid"])
            if not remaining:
                return
            if any(not any(identical(item, known) for known in members) for item in remaining):
                raise Refusal("Unverified/reused process appeared before escalation")
            self.h.signal_group(expected["pgid"], signum)
            deadline = self.h.now() + (10 if signum == signal.SIGTERM else 5)
            while self.h.group(expected["pgid"]) and self.h.now() < deadline:
                self.h.sleep(0.1)
        if self.h.group(expected["pgid"]):
            raise Refusal("Verified process group survived SIGKILL")

    def stop_v1(self):
        identities = self.plan["preflight"]["identities"]
        for role, item in identities.items():
            if role != "backend":
                self.stop_identity(role, item)
        if not self.all_idle():
            raise Refusal("New V1 work appeared before backend stop")
        self.stop_identity("backend", identities["backend"])
        self.journal["resources"]["v1Stopped"] = True
        self.save()
        # Kernel process exit can precede release of its sockets/SQLite handles.
        deadline = self.h.now() + 10
        while True:
            endpoint = self.h.port_open(self.plan["preflight"]["originalPort"])
            writers = self.h.writers(self.s.original)
            if not endpoint and not writers:
                break
            if self.h.now() >= deadline:
                raise Refusal(f"V1 resources remain after shutdown: endpoint={endpoint}, writerPIDs={sorted(writers)}")
            self.h.sleep(0.1)
        self.retire_holds()
        for name in ("server.json", "restart-pending.json", "handoffs.json"):
            (self.s.state / name).unlink(missing_ok=True)
        (self.s.global_state / "agentview/opencode-owned.json").unlink(missing_ok=True)
        self.check_lock_inode()
        return {"oldGroupsGone": True, "databaseWriters": 0}

    def check_lock_inode(self):
        info = (self.s.state / "server.lock").stat()
        if (info.st_dev, info.st_ino) != self.lock_inode:
            raise Refusal("The locked inode/path was replaced")

    def retire_holds(self):
        root = self.s.global_state / "agentview/holds/opencode"
        destination = self.backup / "holds"
        if not root.exists():
            return
        for file in root.glob("*/*.json"):
            hold = read_private(file, require_private=False)
            # Never hide an actually running monitor/background shell.
            if hold.get("pid") and self.h.identity(int(hold["pid"])) is not None:
                raise Refusal("Live OpenCode hold remains after quiescence")
            target = destination / file.relative_to(root)
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            shutil.copy2(file, target)
            target.chmod(0o600)
            if digest(file) != digest(target):
                raise Refusal("Hold backup verification failed")
            file.unlink()

    def freeze(self):
        if self.h.writers(self.s.original) or self.h.port_open(self.plan["preflight"]["originalPort"]):
            raise Refusal("Source is not frozen")
        self.command("backup", [sys.executable, self.s.repo / "migration/backup.py", self.s.profile,
                                "--source", self.s.original])
        report = read_private(self.s.profile / "reference/backup.json")
        profile = read_private(self.s.profile / "profile.json")
        target = Path(profile["environment"]["OPENCODE_DB"])
        if target.resolve() != (self.s.profile / "data/opencode/history-v1.db").resolve() or Path(report.get("source", "")).resolve() != self.s.original.resolve() or report.get("quick_check") != "ok" or report.get("reopened_counts_verified") is not True:
            raise Refusal("Fresh source backup lacks its verified receipt")
        with closing(sqlite3.connect(target.as_uri() + "?mode=ro", uri=True)) as source:
            counts = {table: source.execute(f"SELECT count(*) FROM {table}").fetchone()[0] for table in ("session", "message", "part")}
            if counts != report["counts"] or source.execute("PRAGMA quick_check").fetchone()[0] != "ok":
                raise Refusal("Published source backup differs from its receipt")
        retained = self.backup / "frozen-v1.db"
        # A verified, checkpointed backup can be retained as an independent APFS
        # copy-on-write clone; importing the target cannot mutate this snapshot.
        self.command("retain-frozen", ["/bin/cp", "-c", target, retained], timeout=60)
        retained.chmod(0o400)
        if self.h.writers(self.s.original):
            raise Refusal("A source writer returned during backup")
        self.journal["resources"].update(frozen=str(retained), frozenSha256=digest(retained), sourceCounts=counts)
        self.save()
        return {"counts": counts, "immutableSnapshot": str(retained)}

    def offline_import(self):
        self.command("offline-import", ["bun", "run", self.s.repo / "migration/refresh-history.ts", self.s.profile], env=self.s.native_env())
        if digest(self.journal["resources"]["frozen"]) != self.journal["resources"]["frozenSha256"]:
            raise Refusal("Retained source snapshot changed")

    def audit(self):
        self.command("history-audit", ["bun", self.s.repo / "migration/audit-history.mjs", self.s.profile], env=self.s.native_env())
        report = read_private(self.s.profile / "runtime/history-audit.json")
        if report["counts"]["missing"] or report["counts"]["changed"] or report["failures"] or report["warnings"]:
            raise Refusal("Native history audit has real missing/changed rows or warnings")
        if report["counts"]["sessions"] != self.journal["resources"]["sourceCounts"]["session"]:
            raise Refusal("Audit omitted frozen source sessions")
        return {"counts": report["counts"]}

    def install_v2(self):
        if source_receipt(self.s, self.h) != self.plan["preflight"]["sourceSha"] or digest(self.s.installer) != self.plan["preflight"]["installerSha256"]:
            raise Refusal("Approved installer/source changed after arming")
        env = self.s.global_env()
        env.update(INSTALL_LATEST_OPENCODE_V2_REF=self.s.source_ref, INSTALL_LATEST_NO_RESTART="1",
                   INSTALL_LATEST_OPENCODE_V2_PROFILE=str(self.s.profile))
        self.command("install-opencode", [self.s.installer, "opencode"], env=env)
        profile = read_private(self.s.profile / "profile.json")
        executable = Path(profile["executable"])
        if executable != self.s.profile / "bin/native/opencode-dev":
            raise Refusal("Approved installer did not select the production native executable")
        receipt = read_private(self.s.home / ".local/state/install-latest/opencode-dev.json")
        if receipt["commit"] != self.plan["preflight"]["sourceSha"][:10]:
            raise Refusal("Installed runtime is not the reviewed pushed source")
        version = self.h.capture([executable, "--version"], env=self.s.native_env()).strip()
        self.journal["resources"].update(nativeSha256=digest(executable), nativeVersion=version)
        self.save()
        return {"sha256": digest(executable), "version": version}

    def service(self):
        port = self.h.free_port({self.plan["preflight"]["originalPort"]})
        self.journal["resources"]["nativePort"] = port
        self.save()
        try:
            pid = self.h.start([self.s.logical, "serve", "--service", "--hostname", "127.0.0.1", "--port", str(port)],
                               self.s.native_env(), self.s.profile, self.log("native-service"))
        except OSError:
            # Popen reports exec failure only after reaping its failed child.
            self.journal["resources"]["nativeSpawnFailed"] = True
            self.save()
            raise Refusal("Native executable could not start") from None
        self.journal["resources"]["nativePID"] = pid
        started = self.h.identity(pid)
        self.journal["resources"]["nativeStartToken"] = started["start"] if started else None
        self.save()
        deadline = self.h.now() + 45
        while self.h.now() < deadline:
            for file in (self.s.global_state / "opencode").glob("service*.json"):
                try:
                    record = read_private(file)
                    if record.get("url", "").rstrip("/") != f"http://127.0.0.1:{port}":
                        continue
                    info = self.api(record, "GET", "/api/info")
                except (OSError, Refusal, KeyError, ValueError):
                    continue
                identity = self.h.identity(record["pid"])
                executable = self.s.profile / "bin/native/opencode-dev"
                if identity is None or identity["uid"] != os.getuid() or identity["pgid"] != pid or identity["executable"] != str(executable):
                    raise Refusal("Native service kernel identity differs from the installed executable")
                if info["pid"] != record["pid"] or not self.h.listener(record["pid"], port):
                    raise Refusal("Native listener/API process identity mismatch")
                if identity["start"] != self.journal["resources"]["nativeStartToken"]:
                    raise Refusal("Native PID changed during service startup")
                if info["version"] != self.journal["resources"]["nativeVersion"] or not all(info.get("capabilities", {}).get(key) is True for key in ("tuiSessionSelect", "tuiExecuteCommand")):
                    raise Refusal("Native runtime version/targeting capability mismatch")
                if digest(executable)!=self.journal["resources"]["nativeSha256"]:
                    raise Refusal("Installed native runtime changed during startup")
                profile = read_private(self.s.profile / "profile.json")
                profile["serviceFile"] = str(file)
                private_json(self.s.profile / "profile.json", profile)
                self.journal["resources"].update(nativeIdentity=identity, serviceFile=str(file))
                self.save()
                return {"pid": record["pid"], "port": port, "version": info["version"]}
            self.h.sleep(0.2)
        raise Refusal("Native service did not expose the required authenticated identity")

    def install_dashboard(self):
        self.command("install-agentview", [self.s.installer, "agentview"], env={**self.s.global_env(), "INSTALL_LATEST_NO_RESTART": "1"})
        native = self.s.profile / "bin/native/agentview"
        if not native.is_file():
            raise Refusal("Approved dashboard installation is missing")
        receipt=read_private(self.s.home / ".local/state/install-latest/agentview.json")
        pushed=self.h.capture(["git","rev-parse","origin/main"],cwd=self.s.home / "Code/agentview").strip()
        self.h.capture(["git","merge-base","--is-ancestor","d5472303d36a943d3089b16f6ffda0dd663f7d3c",pushed],cwd=self.s.home / "Code/agentview")
        if not pushed.startswith(receipt["commit"]):
            raise Refusal("Dashboard installer receipt is not current pushed origin/main")
        version = self.h.capture([native, "--version"], env=self.s.av_env()).strip()
        self.journal["resources"]["dashboardSha256"]=digest(native)
        self.save()
        return {"sha256": digest(native), "version": version,"sourceCommit":pushed}

    def native(self):
        return read_private(self.s.service_file())

    def adopt(self):
        record = self.native()
        old = read_private(self.backup / "supervisor/server.json")
        inventory = read_private(self.directory / "inventory.json")
        by_id = {row["provider_session_id"]: row for row in inventory["sessions"]}
        required = {self.s.manager_session,*[session for session,_,_ in self.s.checkpoints]}
        ids = set(by_id) | set(old.get("sessions", {})) | required
        with closing(sqlite3.connect(Path(self.journal["resources"]["frozen"]).as_uri()+"?mode=ro",uri=True)) as source:
            source_ids = {row[0] for row in source.execute("SELECT id FROM session")}
        if not required <= source_ids:
            raise Refusal("A checkpointed root is missing from the frozen source")
        skipped = sorted(ids-source_ids)
        ids &= source_ids
        entries = []
        for session in sorted(ids):
            info = self.api(record, "GET", f"/api/session/{session}")["data"]
            if info["time"].get("archived") is not None:
                # Historical archive is preserved by the DB, not active ownership.
                if session in required:
                    raise Refusal("A checkpointed root is archived in the native target")
                continue
            page = self.api(record, "GET", f"/api/session/{session}/message?limit=1")["data"]
            state = by_id.get(session, {}).get("state")
            entries.append({"id": session, "title": info.get("title", ""), "directory": info["location"]["directory"],
                "agent": info.get("agent"), "model": info.get("model"), "createdAtMs": info["time"]["created"],
                "updatedAtMs": info["time"]["updated"], "lastMessageID": page[0]["id"] if page else None,
                "sourceState": "completed" if state in ("completed", "ready_for_review") else "awaitingInput" if state == "needs_input" else "uncertain",
                "resume": False, "toolsSettled": session in required, "externalActionsSettled": session in required})
        manifest = {"version": 1, "handoffID": self.plan["runID"], "endpoint": {"url": record["url"].rstrip("/"), "pid": record["pid"]}, "sessions": entries}
        private_json(self.directory / "handoff.json", manifest)
        self.check_lock_inode()
        # Same global lock: the new CLI constructor AND handoff import need it.
        self.unlock()
        self.command("handoff-import", [self.s.dashboard, "--opencode-bin", self.s.logical, "opencode", "handoff-import", self.directory / "handoff.json"], env=self.s.av_env(), timeout=180)
        own = read_private(self.s.state / "server.json")
        if own.get("api") != "v2" or own["pid"] != record["pid"] or not set(entry["id"] for entry in entries) <= set(own["sessions"]):
            raise Refusal("Native handoff did not grant verified ownership")
        return {"adopted": len(entries), "automaticContinuations": 0,"staleDeletedOwnership":skipped}

    def verify(self):
        record = self.native()
        if self.api(record, "GET", "/api/session/active")["data"]:
            raise Refusal("Native service started unrelated execution before authority")
        manifest = read_private(self.directory / "handoff.json")
        for entry in manifest["sessions"]:
            if self.api(record, "GET", f"/api/session/{entry['id']}/inbox")["data"]:
                raise Refusal("Imported root has pending native work")
            newest = self.api(record, "GET", f"/api/session/{entry['id']}/message?limit=1")["data"]
            if (newest[0]["id"] if newest else None) != entry["lastMessageID"]:
                raise Refusal("Imported transcript advanced unexpectedly before authority")
        snapshot = json.loads(self.h.capture([self.s.dashboard, "--opencode-bin", self.s.logical,
            *["--no-host-" + name for name in OTHERS], "--all", "--json"], env=self.s.av_env(), timeout=90, log=self.log("native-inventory")))
        visible = {item["provider_session_id"] for item in snapshot["sessions"] if item["provider"] == "opencode" and item["kind"] == "managed"}
        prior_visible = set(read_private(self.directory / "inventory.json")["visibleIDs"])
        expected_visible = prior_visible & {entry["id"] for entry in manifest["sessions"]}
        if snapshot.get("warnings") or not expected_visible <= visible:
            raise Refusal("Fresh production dashboard ownership/list verification failed")
        path = self.h.capture([self.s.logical, "debug", "paths", "db"], env=self.s.global_env()).strip()
        profile = read_private(self.s.profile / "profile.json")
        if path != profile["environment"]["OPENCODE_DB"]:
            raise Refusal("Default CLI does not resolve the production database")
        info = self.api(record, "GET", f"/api/session/{self.s.manager_session}")["data"]
        query = urllib.parse.urlencode({"location[directory]": self.s.manager_directory})
        catalog = self.api(record, "GET", "/api/model?" + query)["data"]
        models = {(m["providerID"], m["id"]) for m in catalog if m.get("enabled") is not False}
        preserved = info.get("model")
        model = preserved if preserved and "sol" in preserved["id"].lower() and (preserved["providerID"], preserved["id"]) in models else self.s.successor_model
        if (model["providerID"], model["id"]) not in models:
            raise Refusal("Approved native successor model is unavailable")
        if preserved != model:
            self.api(record, "POST", f"/api/session/{self.s.manager_session}/model", {"model": model})
        if self.api(record, "GET", f"/api/session/{self.s.manager_session}/form")["data"] or self.api(record, "GET", f"/api/session/{self.s.manager_session}/permission")["data"]:
            raise Refusal("Manager requires native form/permission recovery before a new verification prompt")
        newest = self.api(record, "GET", f"/api/session/{self.s.manager_session}/message?limit=1")["data"]
        self.journal["resources"]["managerWatermark"] = newest[0]["id"] if newest else None
        self.save()
        return {"owned": len(manifest["sessions"]), "pendingInputs": 0, "model": model}

    def authority(self):
        if not identical(self.journal["resources"]["nativeIdentity"], self.h.identity(self.native()["pid"])):
            raise Refusal("Native service changed before authority transfer")
        if digest(self.s.profile / "bin/native/opencode-dev")!=self.journal["resources"]["nativeSha256"] or digest(self.s.profile / "bin/native/agentview")!=self.journal["resources"]["dashboardSha256"]:
            raise Refusal("Installed application hashes changed before authority transfer")
        self.journal["authority"] = "v2"
        self.save()  # irreversible boundary before users can start new V2 work
        self.clear_gate()

    def clear_gate(self):
        if not self.journal["resources"].get("gate"):
            return
        path = self.s.profile / "runtime/cutover.pending"
        if path.exists():
            if read_private(path).get("runID") != self.plan["runID"]:
                raise Refusal("Another coordinator owns the pending gate")
            path.unlink()

    def dashboard(self):
        return self.launch_dashboard(self.s.av_env(), "v2")

    def launch_dashboard(self, env, mode):
        receipt = self.directory / (mode + "-dashboard.json")
        request = self.directory / (mode + "-dashboard-request.json")
        cwd = self.plan["preflight"]["dashboardCwd"]
        private_json(request, {"receipt": str(receipt), "argv": [str(self.s.dashboard), "--opencode-bin", str(self.s.logical), "--include-external", "--include-interactive", "--no-host-claude"], "environment": {key: value for key, value in env.items() if key in ("HOME", "PATH", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "AGENTVIEW_OPENCODE_API", "AGENTVIEW_OPENCODE_SERVICE_FILE", "OPENCODE_CUTOVER_COORDINATOR")}, "cwd": cwd})
        requested=mode+"DashboardRequested"
        if not self.journal["resources"].get(requested):
            self.journal["resources"][requested]=True
            self.save()
            self.h.capture(["/usr/bin/open", "-na", self.s.ghostty, "--args", "--working-directory=" + cwd,
                            "-e", sys.executable, str(Path(__file__).with_name("dashboard.py")), str(request)], env=env)
        deadline = self.h.now() + self.s.dashboard_timeout
        expected = str(self.s.profile / "bin/native/agentview") if mode == "v2" else None
        while self.h.now() < deadline:
            if receipt.exists():
                observed = read_private(receipt)
                pid = observed["pid"]
                item = self.h.identity(pid)
                if item and item["uid"]==os.getuid() and item["start"]==observed["start"] and (item["executable"] == expected if expected else "agentview" in Path(item["executable"]).name):
                    self.journal["resources"][mode + "Dashboard"] = item
                    self.save()
                    return {"pid": pid}
            self.h.sleep(0.2)
        raise Refusal("New dashboard did not prove its running executable")

    def successor(self):
        text = self.successor_text()
        private_json(self.directory / "successor.json", {"id": self.plan["successorInputID"], "text": text})
        return self.admit_successor(text)

    def successor_text(self):
        peers = "\n".join(f"- {session} ({directory}): {checkpoint}" for session, directory, checkpoint in self.s.checkpoints)
        return ("New post-cutover native V2 verification phase, not replay of interrupted tools. "
            "Read the durable cutover journal and status before acting: " + str(self.path) + ". "
            "Stable status pointer: " + str(self.s.profile / "runtime/cutover-status.json") + ". "
            "Verify actual installed/running/default CLI and agentview paths, service identity, DB/config selection, and native tool smoke. "
            "No unrelated old session was auto-resumed. Compare each checkpoint with its latest imported messages (including newer recruiting requests/results). Continue the checkpointed tasks only after that comparison and reconciling external actions; do not replay sends/writes blindly.\n" + peers +
            "\nFinish source/branch/worktree/child-session cleanup and final user signoff. The coordinator owns only this transition; inspect its completed launchd job and private journal before removing it. "
            "Preserved V1 rollback and immutable frozen source are under " + str(self.backup) + ".")

    def admit_successor(self, text):
        record = self.native()
        identity = self.h.identity(record["pid"])
        executable = self.s.profile / "bin/native/opencode-dev"
        port = urllib.parse.urlparse(record["url"]).port
        info = self.api(record, "GET", "/api/info")
        if identity is None or identity["uid"] != os.getuid() or identity["executable"] != str(executable) or info["pid"] != record["pid"] or not self.h.listener(record["pid"], port) or digest(executable) != self.journal["resources"]["nativeSha256"]:
            raise Refusal("Successor target is not the verified installed native service")
        session, message = self.s.manager_session, self.plan["successorInputID"]
        if self.input_exists(record, session, message, text):
            return {"inputID": message, "alreadyAccepted": True}
        newest = self.api(record, "GET", f"/api/session/{session}/message?limit=1")["data"]
        if (newest[0]["id"] if newest else None) != self.journal["resources"]["managerWatermark"]:
            raise Refusal("Manager history advanced before successor admission; require explicit reconciliation")
        try:
            accepted = self.api(record, "POST", f"/api/session/{session}/prompt", {"id": message, "text": text,
                "metadata": {"cutoverRun": self.plan["runID"], "phase": "native-verification"}})["data"]
            if accepted["id"] != message:
                raise Refusal("Successor returned a different durable input ID")
        except (Refusal, OSError):
            if not self.input_exists(record, session, message, text):
                raise Refusal("Successor ACK uncertain; retain V2 and reconcile the same input ID") from None
        return {"inputID": message, "alreadyAccepted": False}

    def input_exists(self, record, session, message, text):
        item = self.api(record, "GET", f"/api/session/{session}/message/{message}")
        if not item.get("_notFound"):
            item = item["data"]
            if item.get("id") != message or item.get("type") != "user" or item.get("text") != text:
                raise Refusal("Successor input ID collides with different durable work")
            return True
        for item in self.api(record, "GET", f"/api/session/{session}/inbox")["data"]:
            if item["id"] == message:
                if item["type"] != "user" or item["payload"]["text"] != text:
                    raise Refusal("Successor inbox ID collides with different durable work")
                return True
        return False

    def rollback(self):
        # Control rollback never admits a V1 prompt. Ambiguous process ownership
        # keeps the fence in place rather than creating two live authorities.
        try:
            resources = self.journal["resources"]
            self.deadline = self.h.now()+240
            if self.journal["status"] == "rolled_back":
                self.verify_v1_recovered()
                return
            if not resources.get("gate"):
                self.journal["status"] = "refused_before_actions"
                self.save()
                return
            if resources.get("backup") and self.lock_fd is None:
                self.acquire_global_lock()
            if self.lock_fd is not None:
                self.check_lock_inode()
            if resources.get("rollbackPID"):
                backup=Path(resources["backup"])
                original=read_private(backup / "supervisor/server.json")
                item=self.h.identity(resources["rollbackPID"])
                if item is None or item["start"]!=resources.get("rollbackStartToken") or item["uid"]!=os.getuid() or item["executable"]!=str(self.s.logical) or not self.h.listener(item["pid"],original["port"]) or self.api(original,"GET","/global/health").get("healthy") is not True:
                    raise Refusal("Partially recovered V1 service needs explicit identity/log reconciliation")
                original.update(pid=item["pid"],processStartToken=item["start"],processCmdline=list(self.h.argv(item["pid"])),createdAtMs=int(time.time()*1000),api="v1")
                private_json(self.s.state / "server.json",original)
                resources["rollbackIdentity"]=item
                self.save()
                self.unlock()
                if resources.get("stoppedGroups",{}).get("dashboard"):
                    self.launch_dashboard(self.s.global_env(),"v1")
                self.clear_gate()
                self.journal["status"]="rolled_back"
                self.save()
                return
            if self.current_phase() == "service" and not resources.get("nativePID") and not resources.get("nativeSpawnFailed"):
                raise Refusal("Service spawn/journal window is uncertain; inspect private native port before recovery")
            if self.journal["resources"].get("nativeIdentity"):
                self.stop_identity("native", self.journal["resources"]["nativeIdentity"])
            elif self.journal["resources"].get("nativePID"):
                item = self.h.identity(self.journal["resources"]["nativePID"])
                if item:
                    expected = str(self.s.profile / "bin/native/opencode-dev")
                    if item["uid"] != os.getuid() or item["pgid"] != item["pid"] or item["executable"] != expected or item["start"] != resources.get("nativeStartToken"):
                        raise Refusal("Cannot prove partially started native service ownership")
                    self.stop_identity("native-partial", item)
                elif self.h.group(resources["nativePID"]):
                    raise Refusal("Native root vanished with unverified group survivors")
            database = Path(read_private(self.s.profile / "profile.json")["environment"]["OPENCODE_DB"])
            if database.exists() and self.h.writers(database):
                raise Refusal("Native database still has writers; refuse dual authority")
            old_identity = self.plan["preflight"]["identities"]["backend"]
            old_live = self.h.identity(old_identity["pid"])
            if old_live is not None and not identical(old_identity, old_live):
                raise Refusal("Old PID was reused; refuse guessed rollback")
            if old_live is None and resources.get("backup"):
                if self.h.group(old_identity["pgid"]):
                    raise Refusal("Old backend group has unverified survivors")
                env = self.s.global_env()
                env.update(INSTALL_LATEST_OPENCODE_V1="1", INSTALL_LATEST_OPENCODE_ROLLBACK=str(self.s.profile / "rollback/opencode-dev-v1"), INSTALL_LATEST_NO_RESTART="1")
                self.command("rollback-binary", [self.s.installer, "opencode"], env=env, timeout=120,cwd=self.s.home)
                manifest = read_private(self.s.profile / "rollback/manifest.json")
                if digest(self.s.logical) != manifest["binary"]["sha256"] or digest(self.s.home / ".opencode/bin/opencode") != manifest["compatBinary"]["sha256"]:
                    raise Refusal("Approved exact V1 rollback was not restored")
                backup = Path(resources["backup"])
                original = read_private(backup / "supervisor/server.json")
                if self.h.port_open(original["port"]):
                    raise Refusal("Original V1 port has an unverified owner")
                native_state = self.s.global_state / "opencode"
                if native_state.exists():
                    if not (backup / "native-state-failed").exists():
                        shutil.copytree(native_state, backup / "native-state-failed", symlinks=True)
                    shutil.rmtree(native_state)
                if (backup / "native-state").exists():
                    shutil.copytree(backup / "native-state", native_state, symlinks=True)
                for name in ("server.json", "restart-pending.json", "handoffs.json"):
                    (self.s.state / name).unlink(missing_ok=True)
                ownership = self.s.global_state / "agentview/opencode-owned.json"
                if (backup / "opencode-owned.json").exists():
                    shutil.copy2(backup / "opencode-owned.json", ownership)
                else:
                    ownership.unlink(missing_ok=True)
                env.update(OPENCODE_SERVER_USERNAME=original["username"], OPENCODE_SERVER_PASSWORD=original["password"], OPENCODE_CONFIG_DIR=str(self.s.home / ".config/opencode"), OPENCODE_DB=str(self.s.original))
                pid = self.h.start([self.s.logical, "serve", "--hostname", "127.0.0.1", "--port", str(original["port"])], env, self.s.home, self.log("rollback-service"))
                resources["rollbackPID"]=pid
                started=self.h.identity(pid)
                resources["rollbackStartToken"]=started["start"] if started else None
                self.save()
                deadline = self.h.now() + 30
                while self.h.now() < deadline:
                    item = self.h.identity(pid)
                    try:
                        healthy = item and self.h.listener(pid, original["port"]) and self.api(original, "GET", "/global/health").get("healthy") is True
                    except Refusal:
                        healthy = False
                    if healthy:
                        if item["start"]!=resources["rollbackStartToken"] or item["uid"]!=os.getuid() or item["pgid"]!=pid or item["executable"]!=str(self.s.logical):
                            raise Refusal("Rollback process changed identity during startup")
                        original.update(pid=pid, processStartToken=item["start"], processCmdline=list(self.h.argv(pid)), createdAtMs=int(time.time() * 1000), api="v1")
                        private_json(self.s.state / "server.json", original)
                        self.journal["resources"]["rollbackIdentity"] = item
                        self.save()
                        break
                    self.h.sleep(0.2)
                else:
                    raise Refusal("Exact V1 service did not prove recovery")
            elif old_live is not None:
                old = read_private(self.s.state / "server.json")
                if not self.h.listener(old_live["pid"], old["port"]) or self.api(old, "GET", "/global/health").get("healthy") is not True:
                    raise Refusal("Original surviving V1 backend is not healthy")
            else:
                raise Refusal("No verified V1 backend or retained recovery source")
            self.unlock()
            if self.journal["resources"].get("stoppedGroups", {}).get("dashboard"):
                self.launch_dashboard(self.s.global_env(), "v1")
            self.clear_gate()
            self.journal["status"] = "rolled_back"
            self.save()
        except BaseException as error:
            self.journal["status"] = "failed_fenced"
            self.journal["rollbackError"] = {"type": type(error).__name__}
            if isinstance(error,Refusal):
                self.journal["rollbackError"]["message"]=str(error)
            self.save()
            # Retain gate and preserved source; never claim recovery from exit0.

    def verify_v1_recovered(self):
        expected = self.journal["resources"].get("rollbackIdentity", self.plan["preflight"]["identities"]["backend"])
        record = read_private(self.s.state / "server.json")
        if not identical(expected, self.h.identity(expected["pid"])) or record["pid"] != expected["pid"] or not self.h.listener(expected["pid"], record["port"]) or self.api(record, "GET", "/global/health").get("healthy") is not True:
            raise Refusal("Previously recovered V1 control plane no longer matches its receipt")

    def notify_rollback(self):
        """Wake only the manager for diagnosis, never replay interrupted work."""
        message = "msg_" + hashlib.sha256((self.plan["runID"] + ":rollback-diagnostic").encode()).hexdigest()[:32]
        query = "?" + urllib.parse.urlencode({"directory": self.s.manager_directory})
        text = ("AUTOMATED CUTOVER ROLLBACK DIAGNOSTIC: V1 is still authoritative, NOT V2. "
                "The cutover failed and exact V1 recovery was verified. This is a new manager-only diagnostic phase, "
                "not a replay of interrupted tools or approval to resume other tasks. Read " + str(self.path) +
                " and inspect the failed phase logs. Fix the actual failure, preserve the original history and "
                "checkpointed goals, and continue the authorized migration with fresh preflight. Do not claim completion or blindly replay external actions.")
        try:
            self.verify_v1_recovered()
            record = read_private(self.s.state / "server.json")
            previous = self.h.api(record, "GET", f"/session/{self.s.manager_session}/message/{message}" + query)
            if previous.get("_notFound"):
                self.h.api(record, "POST", f"/session/{self.s.manager_session}/prompt_async" + query,
                           {"messageID": message, "model": {"providerID": self.s.successor_model["providerID"],
                                                          "modelID": self.s.successor_model["id"]},
                            "parts": [{"type": "text", "text": text}]})
            self.journal["resources"]["rollbackNotice"] = {"messageID": message, "state": "admitted"}
        except (Refusal, OSError) as error:
            self.journal["resources"]["rollbackNotice"] = {"messageID": message, "state": "uncertain", "errorType": type(error).__name__}
        self.save()


def arm(settings, host, config_path):
    observed = preflight(settings, host)
    run = "cutover-" + uuid.uuid4().hex
    directory = settings.profile / "runtime/cutover" / run
    directory.mkdir(parents=True, mode=0o700)
    code=directory / "code"
    code.mkdir(mode=0o700)
    fingerprints={}
    for name in ("controller.py","host.py","dashboard.py"):
        shutil.copy2(Path(__file__).with_name(name),code / name)
        (code / name).chmod(0o400)
        fingerprints[name]=digest(code / name)
    plan = {"version": 1, "runID": run, "createdMs": int(time.time() * 1000), "configPath": str(Path(config_path).resolve()),
            "configSha256": digest(config_path), "successorInputID": "msg_" + uuid.uuid4().hex, "preflight": observed,
            "codeSha256":fingerprints}
    private_json(directory / "plan.json", plan)
    script = code / "controller.py"
    label = "dev.moritz.opencode." + run
    plist = {"Label": label, "RunAtLoad": True, "KeepAlive": False, "WorkingDirectory": str(settings.repo / "packages/cli"),
             "ProgramArguments": [sys.executable, str(settings.home / ".claude/scripts/heavy-job.py"), "--wait", "--", sys.executable, str(script), "execute", "--armed", "--plan", str(directory / "plan.json")],
             "EnvironmentVariables": {"HOME": str(settings.home), "PATH": os.environ.get("PATH", "/usr/bin:/bin:/usr/sbin:/sbin"), "OPENCODE_CUTOVER_COORDINATOR": "1"},
             "StandardOutPath": str(directory / "launchd.log"), "StandardErrorPath": str(directory / "launchd.log")}
    (directory / "launchd.log").touch(mode=0o600)
    file = directory / "coordinator.plist"
    file.write_bytes(plistlib.dumps(plist))
    file.chmod(0o600)
    return {"plan": str(directory / "plan.json"), "plist": str(file), "label": label,
            "bootstrap": ["launchctl", "bootstrap", f"gui/{os.getuid()}", str(file)]}


def load_plan(path, allow_expired=False):
    plan = read_private(path)
    if plan.get("version") != 1 or (not allow_expired and int(time.time() * 1000) - plan["createdMs"] > 30 * 60 * 1000):
        raise Refusal("Arm plan is invalid or older than 30 minutes; refresh identities/checkpoints")
    if digest(plan["configPath"]) != plan["configSha256"]:
        raise Refusal("Armed configuration changed")
    settings=Settings.load(plan["configPath"])
    if path.resolve() != (settings.profile / "runtime/cutover" / plan["runID"] / "plan.json").resolve():
        raise Refusal("Arm plan is outside its private production run directory")
    for name,fingerprint in plan["codeSha256"].items():
        if name not in ("controller.py","host.py","dashboard.py") or digest(path.parent / "code" / name)!=fingerprint:
            raise Refusal("Armed coordinator code changed")
    return plan, settings


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("preflight", "arm", "execute", "recover", "reconcile-successor"))
    parser.add_argument("--config", type=Path)
    parser.add_argument("--plan", type=Path)
    parser.add_argument("--armed", action="store_true")
    args = parser.parse_args()
    host = Host()
    os.umask(0o077)
    if args.action in ("preflight", "arm"):
        if not args.config:
            parser.error("--config is required")
        settings = Settings.load(args.config)
        report = preflight(settings, host) if args.action == "preflight" else arm(settings, host, args.config)
        print(json.dumps(report, indent=2))
        return
    if not args.armed or not args.plan:
        parser.error("Live transitions require --armed and --plan")
    plan, settings = load_plan(args.plan, allow_expired=args.action != "execute")
    directory = args.plan.parent
    fd = os.open(directory / "coordinator.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise Refusal("Coordinator already running") from None
    control = Controller(settings, host, plan, directory)
    def interrupted(_number, _frame):
        raise Refusal("Coordinator termination requested; inspect durable recovery state")
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    try:
        if args.action == "execute":
            control.run()
        else:
            control.journal = read_private(control.path)
            if control.journal["resources"].get("backup"):
                control.backup = Path(control.journal["resources"]["backup"])
            if args.action == "recover":
                if control.journal["authority"] == "v2":
                    raise Refusal("V2 authority already released; use native recovery, never automatic V1 rollback")
                control.rollback()
            else:
                if control.journal["authority"] != "v2":
                    raise Refusal("Successor reconciliation requires established V2 authority")
                value = read_private(directory / "successor.json")
                evidence = control.admit_successor(value["text"])
                control.journal["status"] = "handoff_admitted"
                control.journal["successorReconciliation"] = evidence
                control.save()
        print(json.dumps({"status": control.journal["status"], "journal": str(control.path)}, indent=2))
        if control.journal["status"] not in ("handoff_admitted", "rolled_back"):
            raise Refusal("Cutover did not complete a verified authority state")
    finally:
        control.unlock()
        os.close(fd)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # Avoid printing API credentials, command bodies, or process environments.
        print(json.dumps({"status": "refused", "errorType": type(error).__name__,
                          "message": str(error) if isinstance(error, Refusal) else "See private phase journal/log"}), file=sys.stderr)
        sys.exit(1)
