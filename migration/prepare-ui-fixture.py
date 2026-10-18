"""Create harmless real TodoWrite/link/speech content for VM acceptance."""
import base64
import json
import pathlib
import time
import urllib.request
import uuid

root = pathlib.Path.home() / ".local/share/opencode-v2-migration"
connection = json.loads((root / "runtime/connection.json").read_text())
authorization = "Basic " + base64.b64encode(f'{connection["username"]}:{connection["password"]}'.encode()).decode()


def api(path, body=None):
    request = urllib.request.Request(connection["url"] + path, data=None if body is None else json.dumps(body).encode(), headers={"Authorization": authorization, "Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=90) as response:
        raw = response.read()
        if not raw:
            return None
        value = json.loads(raw)
        return value.get("data", value) if isinstance(value, dict) else value


session = api("/api/session", {"title": "V2 parity GUI proof", "location": {"directory": str(root / "projects/account-probe")}, "permissions": [{"action": "*", "resource": "*", "effect": "deny"}, {"action": "todowrite", "resource": "*", "effect": "allow"}], "metadata": {"migrationProbe": True}})
session_id = session["id"]
report = {"sessionID": session_id, "success": False}
try:
    api(f"/api/session/{session_id}/model", {"model": {"providerID": "openai", "id": "gpt-6.1-sol"}})
    api(f"/api/session/{session_id}/prompt", {"id": "msg_" + uuid.uuid4().hex, "text": "Ignore memory. This is a synthetic UI fixture, not real work. Call todowrite once with exactly three tasks: Verify imported history (completed, high); Verify speech and links (in_progress, high); Verify final handoff (pending, medium). Then output exactly this Markdown and stop: V2 parity check. The checklist is ready. Visit [OpenCode docs](https://opencode.ai/docs) and read this sentence aloud. Alpha beta gamma delta. These words exercise selection, pause, resume, speed, and highlighting."})
    deadline = time.monotonic() + 180
    while time.monotonic() < deadline:
        messages = api(f"/api/session/{session_id}/message?limit=20&order=desc")
        assistants = [item for item in messages if item["type"] == "assistant"]
        if assistants and assistants[0].get("time", {}).get("completed") and not any(item["type"] == "tool" for item in assistants[0]["content"]):
            report["tools"] = [{"name": part["name"], "status": part["state"]["status"]} for item in assistants for part in item["content"] if part["type"] == "tool"]
            report["success"] = report["tools"] == [{"name": "todowrite", "status": "completed"}]
            break
        time.sleep(0.5)
finally:
    api(f"/api/session/{session_id}/interrupt", {})
    (root / "runtime/ui-fixture.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report), flush=True)
if not report["success"]:
    raise SystemExit(1)
