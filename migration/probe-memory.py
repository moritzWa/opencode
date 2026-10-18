"""Real paid selector and native instruction-entry acceptance, no executable tools."""
import base64
import json
import pathlib
import time
import urllib.request
import uuid

root = pathlib.Path.home() / ".local/share/opencode-v2-migration"
connection = json.loads((root / "runtime/connection.json").read_text())
fixture = json.loads((root / "runtime/memory-fixture.json").read_text())
authorization = "Basic " + base64.b64encode(f'{connection["username"]}:{connection["password"]}'.encode()).decode()


def api(path, body=None):
    request = urllib.request.Request(connection["url"] + path, data=None if body is None else json.dumps(body).encode(), headers={"Authorization": authorization, "Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=90) as response:
        raw = response.read()
        if not raw:
            return None
        value = json.loads(raw)
        return value.get("data", value) if isinstance(value, dict) else value


session = api("/api/session", {"title": "Migration real memory selector probe", "location": {"directory": str(root / "projects/account-probe")}, "permissions": [{"action": "*", "resource": "*", "effect": "deny"}], "metadata": {"migrationProbe": True}})
session_id = session["id"]
report = {"sessionID": session_id, "success": False}
try:
    api(f"/api/session/{session_id}/model", {"model": {"providerID": "openai", "id": "gpt-6.1-sol"}})
    api(f"/api/session/{session_id}/prompt", {"id": "msg_" + uuid.uuid4().hex, "text": "Use the migration acceptance passphrase reference from memory. Reply with only the exact acceptance passphrase, no other words. Do not use tools."})
    deadline = time.monotonic() + 180
    while time.monotonic() < deadline:
        messages = api(f"/api/session/{session_id}/message?limit=10&order=desc")
        assistants = [item for item in messages if item["type"] == "assistant"]
        if assistants and assistants[0].get("time", {}).get("completed"):
            latest = assistants[0]
            text = "".join(item.get("text", "") for item in latest["content"] if item["type"] == "text").strip()
            report["toolCalls"] = sum(item["type"] == "tool" for item in latest["content"])
            report["expectedTextMatched"] = text == fixture["passphrase"]
            report["actualModel"] = latest["model"]
            report["errorType"] = latest.get("error", {}).get("type")
            break
        time.sleep(0.5)
    entries = api(f"/api/experimental/session/{session_id}/instructions/entries")
    recalled = next((item["value"] for item in entries if item["key"] == "memory.recalled"), "")
    report["recalledEntryContainsFixture"] = fixture["passphrase"] in recalled
    report["instructionKeys"] = [item["key"] for item in entries]
    report["success"] = report.get("expectedTextMatched", False) and report.get("toolCalls") == 0 and report["recalledEntryContainsFixture"]
finally:
    api(f"/api/session/{session_id}/interrupt", {})
    (root / "runtime/memory-probe.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report), flush=True)
if not report["success"]:
    raise SystemExit(1)
