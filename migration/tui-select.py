"""Select one Session on the exact VM frontend, or create a blank draft target."""
import argparse
import base64
import json
import pathlib
import urllib.request

parser = argparse.ArgumentParser()
parser.add_argument("session", nargs="?")
arguments = parser.parse_args()
root = pathlib.Path.home() / ".local/share/opencode-v2-migration"
connection = json.loads((root / "runtime/connection.json").read_text())
authorization = "Basic " + base64.b64encode(f'{connection["username"]}:{connection["password"]}'.encode()).decode()


def api(path, body=None):
    request = urllib.request.Request(connection["url"] + path, data=None if body is None else json.dumps(body).encode(), headers={"Authorization": authorization, "Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)["data"]


session = api("/api/session/" + arguments.session) if arguments.session else api("/api/session", {"title": "V2 blank draft switch target", "location": {"directory": str(root / "projects/account-probe")}, "permissions": [{"action": "*", "resource": "*", "effect": "deny"}], "metadata": {"migrationProbe": True}})
request = urllib.request.Request(connection["url"] + "/api/tui/select-session", data=json.dumps({"sessionID": session["id"], "client": "v2-migration-vm", "targetDirectory": session["location"]["directory"]}).encode(), headers={"Authorization": authorization, "Content-Type": "application/json"})
with urllib.request.urlopen(request, timeout=15) as response:
    print("Selected exact VM frontend", session["id"], response.status)
if not arguments.session:
    (root / "runtime/draft-target.json").write_text(json.dumps({"sessionID": session["id"]}) + "\n")
