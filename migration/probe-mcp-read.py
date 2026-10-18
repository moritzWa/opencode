"""Exercise safe real MCP reads through native Code Mode, not just discovery."""
import base64
import argparse
import json
import pathlib
import time
import urllib.request
import uuid

root = pathlib.Path.home() / ".local/share/opencode-v2-migration"
parser = argparse.ArgumentParser()
parser.add_argument("--server", choices=["gmail", "gmail-arca", "google-calendar", "google-workspace", "slack", "cua"])
arguments = parser.parse_args()
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


permissions = [{"action": "*", "resource": "*", "effect": "deny"}]
permissions.extend({"action": name, "resource": "*", "effect": "allow"} for name in ["execute", "*list_email_labels", "*list-calendars", "*list_drive_items", "*search_channels", "*list_spaces"])
session = api("/api/session", {"title": "Migration safe real MCP reads", "location": {"directory": str(root / "projects/account-probe")}, "permissions": permissions, "metadata": {"migrationProbe": True}})
session_id = session["id"]
report = {"sessionID": session_id, "success": False}
try:
    api(f"/api/session/{session_id}/model", {"model": {"providerID": "openai", "id": "gpt-6.1-sol"}})
    reads = {
        "gmail": "personal gmail list_email_labels",
        "gmail-arca": "gmail-arca list_email_labels",
        "google-calendar": "google-calendar list-calendars",
        "google-workspace": "google-workspace list_drive_items with user_google_email wallawitsch@gmail.com and page_size 1",
        "slack": "slack search_channels for general",
        "cua": "cua list_spaces",
    }
    if arguments.server:
        reads = {arguments.server: reads[arguments.server]}
    api(f"/api/session/{session_id}/prompt", {"id": "msg_" + uuid.uuid4().hex, "text": "Ignore memory for this connectivity test. Perform only these safe real MCP reads using advertised native tools or Code Mode: " + "; ".join(reads.values()) + ". Discover exact callable names and schemas as necessary. Never send, draft, create, update, delete, move, rename, launch, or touch any GUI. Keep returned personal data out of the conversation: return only counts/success flags. Do not infer success without an actual tool response; inspect error wrappers. Final answer must be a single JSON object with exactly keys " + ", ".join(reads) + ". Each value must be true for a confirmed successful real read or a short error string. No prose or markdown fences."})
    deadline = time.monotonic() + 240
    while time.monotonic() < deadline:
        messages = api(f"/api/session/{session_id}/message?limit=40&order=desc")
        assistants = [item for item in messages if item["type"] == "assistant"]
        if assistants and assistants[0].get("time", {}).get("completed") and not any(item["type"] == "tool" for item in assistants[0]["content"]):
            text = "".join(item.get("text", "") for item in assistants[0]["content"] if item["type"] == "text").strip()
            try:
                report["reads"] = json.loads(text)
            except ValueError:
                report["error"] = "non_json_final_answer"
            report["tools"] = [{"name": part["name"], "status": part["state"]["status"]} for item in assistants for part in item["content"] if part["type"] == "tool"]
            break
        time.sleep(0.5)
    report["success"] = set(report.get("reads", {})) == set(reads) and all(value is True for value in report["reads"].values()) and any(item["status"] == "completed" for item in report.get("tools", []))
finally:
    api(f"/api/session/{session_id}/interrupt", {})
    filename = "mcp-read-probe" + ("-" + arguments.server if arguments.server else "") + ".json"
    (root / "runtime" / filename).write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report), flush=True)
if not report["success"]:
    raise SystemExit(1)
