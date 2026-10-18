import base64
import json
import pathlib
import re
import urllib.parse
import urllib.request

root = pathlib.Path.home() / ".local/share/opencode-v2-migration"
connection = json.loads((root / "runtime/connection.json").read_text())
auth = "Basic " + base64.b64encode(f'{connection["username"]}:{connection["password"]}'.encode()).decode()


def api(path):
    with urllib.request.urlopen(urllib.request.Request(connection["url"] + path, headers={"Authorization": auth}), timeout=30) as response:
        return json.load(response)


def safe(value):
    if isinstance(value, dict):
        return {key: "[redacted]" if any(part in key.lower() for part in ("access", "refresh", "authorization", "secret", "cookie", "api_key", "apikey")) else safe(item) for key, item in value.items()}
    if isinstance(value, list):
        return [safe(item) for item in value]
    text = json.dumps(value)
    text = re.sub(r"(?:sk-[A-Za-z0-9_-]+|gsk_[A-Za-z0-9_-]+|xox[baprs]-[A-Za-z0-9_-]+|crsr_[A-Za-z0-9_-]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)", "[redacted]", text)
    text = re.sub(r"(?i)Bearer\s+[A-Za-z0-9._-]+", "Bearer [redacted]", text)
    return json.loads(text)


query = urllib.parse.urlencode({"location[directory]": str(root / "projects/account-probe")})
plugins = api("/api/plugin?" + query)
entries = plugins.get("data", plugins) if isinstance(plugins, dict) else plugins
print("plugins", json.dumps(safe([{key: item.get(key) for key in ("id", "target", "status", "error")} for item in entries if not str(item.get("id", "")).startswith("opencode.")])))
for item in entries:
    if not item.get("id"):
        print("unloaded_plugin", json.dumps(safe(item)))
report = json.loads((root / "runtime/account-probes.json").read_text())
for item in report["results"]:
    if item["success"] or "sessionID" not in item:
        continue
    messages = api(f'/api/session/{item["sessionID"]}/message?limit=10&order=desc')["data"]
    print("failed_probe", item["providerID"], json.dumps(safe([
        {"id": message["id"], "model": message.get("model"), "error": message.get("error"), "retry": message.get("retry")}
        for message in messages if message["type"] == "assistant"
    ])))
