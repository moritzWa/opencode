#!/usr/bin/env python3
"""Wait for the isolated server's finite history import; fail on terminal errors."""

import base64
import json
import pathlib
import sys
import time
import urllib.request


root = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else pathlib.Path.home() / ".local/share/opencode-v2-migration"
connection = json.loads((root / "runtime/connection.json").read_text())
authorization = "Basic " + base64.b64encode(f'{connection["username"]}:{connection["password"]}'.encode()).decode()
deadline = time.monotonic() + 1800
while time.monotonic() < deadline:
    request = urllib.request.Request(
        connection["url"] + "/api/experimental/migration/v1",
        headers={"Authorization": authorization},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        status = json.load(response)
    if status["status"] == "completed":
        (root / "runtime/history-status.json").write_text(json.dumps(status, indent=2) + "\n")
        print("History import completed", flush=True)
        break
    if status["status"] == "error":
        raise RuntimeError("History import error: " + status["error"])
    time.sleep(5)
else:
    raise RuntimeError("History import deadline exceeded: " + json.dumps(status))
