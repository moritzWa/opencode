"""Continue and compact a fork of imported history, never its original."""
import argparse
import base64
import hashlib
import json
import pathlib
import time
import urllib.request
import uuid

parser = argparse.ArgumentParser()
parser.add_argument("session")
arguments = parser.parse_args()
root = pathlib.Path.home() / ".local/share/opencode-v2-migration"
connection = json.loads((root / "runtime/connection.json").read_text())
authorization = "Basic " + base64.b64encode(f'{connection["username"]}:{connection["password"]}'.encode()).decode()


def api(path, body=None, method=None):
    request = urllib.request.Request(connection["url"] + path, data=None if body is None else json.dumps(body).encode(), method=method, headers={"Authorization": authorization, "Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=90) as response:
        raw = response.read()
        if not raw:
            return None
        value = json.loads(raw)
        return value.get("data", value) if isinstance(value, dict) else value


def digest(messages):
    return hashlib.sha256(json.dumps(messages, sort_keys=True).encode()).hexdigest()


def prompt(session_id, expected):
    message_id = "msg_" + uuid.uuid4().hex
    api(f"/api/session/{session_id}/prompt", {"id": message_id, "text": f"Ignore memory. Read-only migration acceptance check: reply with exactly {expected}. Do not continue the historical task and do not use tools."})
    deadline = time.monotonic() + 180
    while time.monotonic() < deadline:
        messages = api(f"/api/session/{session_id}/message?limit=20&order=desc")
        boundary = next((index for index, item in enumerate(messages) if item["id"] == message_id), 0)
        assistants = [item for item in messages[:boundary] if item["type"] == "assistant"]
        if assistants and assistants[0].get("time", {}).get("completed"):
            latest = assistants[0]
            text = "".join(item.get("text", "") for item in latest["content"] if item["type"] == "text").strip()
            return {"matched": text == expected, "tools": sum(item["type"] == "tool" for item in latest["content"]), "errorType": latest.get("error", {}).get("type")}
        time.sleep(0.5)
    return {"matched": False, "error": "deadline"}


original = api(f"/api/experimental/session/{arguments.session}/export")
session = api(f"/api/session/{arguments.session}/fork", {})
session_id = session["id"]
report = {"originalSessionID": arguments.session, "forkSessionID": session_id, "originalMessages": len(original["messages"]), "success": False}
try:
    api(f"/api/session/{session_id}", {"title": "Migration imported-history continuation proof", "permissions": [{"action": "*", "resource": "*", "effect": "deny"}], "metadata": {"migrationProbe": True}}, "PATCH")
    api(f"/api/session/{session_id}/model", {"model": {"providerID": "openai", "id": "gpt-6.1-sol"}})
    report["beforeCompaction"] = prompt(session_id, "IMPORTED_HISTORY_CONTINUED")
    compact_id = "msg_" + uuid.uuid4().hex
    api(f"/api/session/{session_id}/compact", {"id": compact_id})
    deadline = time.monotonic() + 240
    while time.monotonic() < deadline:
        entries = api(f"/api/session/{session_id}/message?limit=30&order=desc")
        compact = next((item for item in entries if item["id"] == compact_id), None)
        if compact and compact["status"] in ["completed", "failed"]:
            report["compaction"] = {key: compact.get(key) for key in ["status", "model", "error", "strategy"]}
            break
        time.sleep(0.5)
    report["afterCompaction"] = prompt(session_id, "COMPACTED_HISTORY_CONTINUED")
    report["originalUnchanged"] = digest(api(f"/api/experimental/session/{arguments.session}/export")["messages"]) == digest(original["messages"])
    report["success"] = all(report[key]["matched"] and report[key]["tools"] == 0 for key in ["beforeCompaction", "afterCompaction"]) and report["originalUnchanged"] and report.get("compaction", {}).get("status") == "completed"
finally:
    api(f"/api/session/{session_id}/interrupt", {})
    (root / "runtime/history-continuation-probe.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report), flush=True)
if not report["success"]:
    raise SystemExit(1)
