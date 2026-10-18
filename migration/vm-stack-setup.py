"""Guest-local full-stack fixture: no provider credentials or model requests."""
import base64
import json
import os
import pathlib
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.parse
import urllib.request

root = pathlib.Path("/Users/lume/Code/opencode-v2-migration")
os.umask(0o077)
profile = pathlib.Path(tempfile.mkdtemp(prefix="stack-proof-", dir=root))
work = profile / "work"
managed = {f"XDG_{name}_HOME": str(profile / name.lower()) for name in ["CONFIG", "DATA", "STATE", "CACHE"]}
managed.update({"OPENCODE_CONFIG_DIR": str(root / "config/opencode"), "OPENCODE_DB": str(profile / "data/opencode/opencode.db"), "AGENTVIEW_OPENCODE_API": "v2", "AGENTVIEW_OPENCODE_SERVICE_FILE": str(profile / "registration.json"), "OPENCODE_DISABLE_MODELS_FETCH": "1", "OPENCODE_DISABLE_AUTOUPDATE": "1", "OPENCODE_DISABLE_PROJECT_CONFIG": "1", "OPENCODE_DISABLE_CLAUDE_CODE": "1", "OPENCODE_DISABLE_FFF": "1", "PATH": str(root / "bin") + ":" + os.environ["PATH"]})
environment = {**os.environ, **managed}
for key in ["OPENCODE_PASSWORD", "OPENCODE_SERVER_PASSWORD", "OPENCODE_SERVER_USERNAME", "OPENCODE_TUI_CLIENT_ID"]:
    environment.pop(key, None)
for directory in [work, profile / "data/opencode", profile / "state/opencode", profile / "cache/opencode/speech"]:
    directory.mkdir(parents=True, exist_ok=True)
shutil.copy2(root / "data/opencode/speechify.key", profile / "data/opencode/speechify.key")
for filename in ["kv.json", "model.json"]:
    shutil.copy2(root / "state/opencode" / filename, profile / "state/opencode" / filename)
for filename in (root / "cache/opencode/speech").glob("*"):
    if filename.is_file():
        shutil.copy2(filename, profile / "cache/opencode/speech" / filename.name)
(root / "config/opencode/opencode.jsonc").write_text(json.dumps({"plugins": [{"package": str(root / "config/opencode/ports/todo-server"), "options": {"todoread": True}}]}) + "\n")
with socket.socket() as selection:
    selection.bind(("127.0.0.1", 0))
    port = selection.getsockname()[1]
executable = str(root / "bin/opencode-v2-candidate")
with (profile / "server.log").open("wb") as log:
    child = subprocess.Popen([str(root / "bin/timeout.sh"), "--kill-after", "30s", "30m", executable, "serve", "--service", "--hostname", "127.0.0.1", "--port", str(port)], cwd=work, env=environment, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
(root / "runtime/stack-profile.json").write_text(json.dumps({"profile": str(profile), "work": str(work), "environment": managed, "leasePID": child.pid}) + "\n")


def private(filename, value):
    filename.write_text(json.dumps(value, indent=2) + "\n")
    filename.chmod(0o600)


deadline = time.monotonic() + 90
while time.monotonic() < deadline:
    files = list((profile / "state/opencode").glob("service*.json"))
    if files:
        registration = json.loads(files[0].read_text())
        break
    if child.poll() is not None:
        raise SystemExit("Private fixture service exited; inspect its own server.log")
    time.sleep(0.1)
else:
    raise SystemExit("Private service registration deadline exceeded")
authorization = "Basic " + base64.b64encode(("opencode:" + registration["password"]).encode()).decode()


def api(path, body=None):
    request = urllib.request.Request(registration["url"].rstrip("/") + path, data=None if body is None else json.dumps(body).encode(), headers={"Authorization": authorization, "Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=30) as response:
        raw = response.read()
        return json.loads(raw) if raw else None


info = api("/api/info")
assert info["pid"] == registration["pid"]
assert info["capabilities"]["tuiSessionSelect"] and info["capabilities"]["tuiExecuteCommand"]
private(profile / "registration.json", registration)
fixture = json.loads((root / "runtime/vm-fixture-transfer.json").read_text())
session = api("/api/experimental/session/import", {**fixture["transfer"], "location": {"directory": str(work)}})["data"]
session_id = session["id"]
query = urllib.parse.urlencode({"location[directory]": str(work)})
api("/api/rpc/moritz-todo/update?" + query, {"input": {"sessionID": session_id, "todos": fixture["todos"]["todos"]}})
session = api("/api/session/" + session_id)["data"]
messages = api(f"/api/session/{session_id}/message?limit=1")["data"]
assert api("/api/session/active")["data"] == {}
private(profile / "handoff.json", {"version": 1, "handoffID": "guest-completed-proof", "endpoint": {"url": registration["url"], "pid": registration["pid"]}, "sessions": [{"id": session_id, "title": session["title"], "directory": session["location"]["directory"], "agent": session.get("agent"), "model": session.get("model"), "lastMessageID": messages[0]["id"], "createdAtMs": session["time"]["created"], "updatedAtMs": session["time"]["updated"], "sourceState": "completed", "resume": False, "toolsSettled": True, "externalActionsSettled": True}]})
agentview = str(root / "bin/agentview-v2-candidate")
subprocess.run([agentview, "--opencode-bin", executable, "opencode", "handoff-import", str(profile / "handoff.json")], env=environment, cwd=work, check=True)
print("Private completed fixture adopted without any prompt/resume:", session_id)
