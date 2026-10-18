"""Verify packed plugin activation before spending any model requests."""
import argparse
import base64
import json
import pathlib
import urllib.parse
import urllib.request

parser = argparse.ArgumentParser()
parser.add_argument("--todo", action="store_true")
arguments = parser.parse_args()
root = pathlib.Path.home() / ".local/share/opencode-v2-migration"
connection = json.loads((root / "runtime/connection.json").read_text())
authorization = "Basic " + base64.b64encode(f'{connection["username"]}:{connection["password"]}'.encode()).decode()
query = urllib.parse.urlencode({"location[directory]": str(root / "projects/account-probe")})
# Plugin inventory alone does not activate a previously unused Location.
request = urllib.request.Request(connection["url"] + "/api/model?" + query, headers={"Authorization": authorization})
with urllib.request.urlopen(request, timeout=90) as response:
    json.load(response)
request = urllib.request.Request(connection["url"] + "/api/plugin?" + query, headers={"Authorization": authorization})
with urllib.request.urlopen(request, timeout=90) as response:
    plugins = json.load(response)["data"]
report = {"plugins": [{"id": plugin.get("id"), "state": plugin["state"]} for plugin in plugins]}
(root / "runtime/profile-preflight.json").write_text(json.dumps(report, indent=2) + "\n")
active = {plugin.get("id") for plugin in plugins if plugin["state"]["status"] == "active"}
required = {"cursor.provider", "local.claude-subscription", "moritz.model-policy", "moritz-parity"}
if arguments.todo:
    required.add("moritz-todo")
print(json.dumps({"active": sorted(active), "missing": sorted(required - active), "failed": [item.get("id") for item in plugins if item["state"]["status"] == "failed"]}))
if required - active or any(item["state"]["status"] == "failed" for item in plugins):
    raise SystemExit(1)
