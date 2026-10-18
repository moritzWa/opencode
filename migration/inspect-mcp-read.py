import base64
import json
import pathlib
import urllib.parse
import urllib.request

root = pathlib.Path.home() / ".local/share/opencode-v2-migration"
connection = json.loads((root / "runtime/connection.json").read_text())
report = json.loads((root / "runtime/mcp-read-probe.json").read_text())
authorization = "Basic " + base64.b64encode(f'{connection["username"]}:{connection["password"]}'.encode()).decode()


def api(path):
    with urllib.request.urlopen(urllib.request.Request(connection["url"] + path, headers={"Authorization": authorization}), timeout=60) as response:
        return json.load(response)["data"]


session = api("/api/session/" + report["sessionID"])
print(json.dumps({key: session.get(key) for key in ["id", "agent", "model", "permissions"]}))
query = urllib.parse.urlencode({"location[directory]": str(root / "projects/account-probe")})
print(json.dumps([{key: item.get(key) for key in ["id", "mode", "hidden", "permissions"]} for item in api("/api/agent?" + query) if item["id"] == "build"]))
print(json.dumps([{key: item.get(key) for key in ["id", "providerID", "capabilities"]} for item in api("/api/model?" + query) if item["providerID"] == "openai" and item["id"] == "gpt-6.1-sol"]))
