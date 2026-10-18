"""Send exact-client commands; never broadcast into other frontends."""
import argparse
import base64
import json
import pathlib
import time
import urllib.request

parser = argparse.ArgumentParser()
parser.add_argument("commands", nargs="+")
parser.add_argument("--delay", type=float, default=0)
arguments = parser.parse_args()
root = pathlib.Path.home() / ".local/share/opencode-v2-migration"
connection = json.loads((root / "runtime/connection.json").read_text())
authorization = "Basic " + base64.b64encode(f'{connection["username"]}:{connection["password"]}'.encode()).decode()
for index, command in enumerate(arguments.commands):
    if index and arguments.delay:
        time.sleep(arguments.delay)
    request = urllib.request.Request(connection["url"] + "/api/tui/execute-command", data=json.dumps({"command": command, "client": "v2-migration-vm"}).encode(), headers={"Authorization": authorization, "Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=15) as response:
        print(command, response.status)
