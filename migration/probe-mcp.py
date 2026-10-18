import base64
import json
import pathlib
import time
import urllib.parse
import urllib.request

root = pathlib.Path.home() / ".local/share/opencode-v2-migration"
connection = json.loads((root / "runtime/connection.json").read_text())
authorization = "Basic " + base64.b64encode(f'{connection["username"]}:{connection["password"]}'.encode()).decode()
query = urllib.parse.urlencode({"location[directory]": str(root / "projects/account-probe")})
deadline = time.monotonic() + 120
while time.monotonic() < deadline:
    request = urllib.request.Request(connection["url"] + "/api/mcp?" + query, headers={"Authorization": authorization})
    with urllib.request.urlopen(request, timeout=30) as response:
        servers = json.load(response)["data"]
    if all(server["status"]["status"] != "pending" for server in servers):
        break
    time.sleep(1)
report = {"servers": [{"name": item["name"], "status": item["status"]["status"], "integrationID": item.get("integrationID")} for item in servers]}
(root / "runtime/mcp-status.json").write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps(report, indent=2))
if any(item["status"] != "connected" and item["name"] != "cua-driver" for item in report["servers"]):
    raise SystemExit(1)
