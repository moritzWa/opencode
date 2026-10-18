"""Export only synthetic acceptance history for a guest-local full-stack run."""
import base64
import json
import pathlib
import urllib.parse
import urllib.request

root = pathlib.Path.home() / ".local/share/opencode-v2-migration"
connection = json.loads((root / "runtime/connection.json").read_text())
fixture = json.loads((root / "runtime/ui-fixture.json").read_text())
authorization = "Basic " + base64.b64encode(f'{connection["username"]}:{connection["password"]}'.encode()).decode()


def api(path, body=None):
    request = urllib.request.Request(connection["url"] + path, data=None if body is None else json.dumps(body).encode(), headers={"Authorization": authorization, "Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


transfer = api(f'/api/experimental/session/{fixture["sessionID"]}/export')["data"]
if transfer["info"].get("metadata", {}).get("migrationProbe") is not True:
    raise SystemExit("Refusing to export a non-probe session")
query = urllib.parse.urlencode({"location[directory]": transfer["info"]["location"]["directory"]})
todos = api("/api/rpc/moritz-todo/get?" + query, {"input": {"sessionID": fixture["sessionID"]}})["output"]
transfer["info"]["location"] = {"directory": "/Users/lume/Code/opencode-v2-migration"}
transfer["info"]["permissions"] = [{"action": "*", "resource": "*", "effect": "deny"}]
destination = root / "runtime/vm-fixture-transfer.json"
destination.write_text(json.dumps({"transfer": transfer, "todos": todos}, indent=2) + "\n")
destination.chmod(0o600)
print("Exported synthetic history and authoritative TODOs only")
