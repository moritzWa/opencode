#!/usr/bin/env python3
"""Wake the manager when one explicitly selected child reaches an idle boundary."""

import base64
import json
import pathlib
import sys
import time
import urllib.parse
import urllib.request


session, directory = sys.argv[1:]
record = json.loads((pathlib.Path.home() / ".local/state/agentview/opencode/server.json").read_text())
authorization = "Basic " + base64.b64encode(f'{record["username"]}:{record["password"]}'.encode()).decode()
seen = False
deadline = time.monotonic() + 23 * 3600
while time.monotonic() < deadline:
    request = urllib.request.Request(
        f'http://127.0.0.1:{record["port"]}/session/status?' + urllib.parse.urlencode({"directory": directory}),
        headers={"Authorization": authorization},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        status = json.load(response)
    busy = status.get(session, {}).get("type") in ("busy", "retry")
    if busy:
        seen = True
    if seen and not busy:
        print(f"Migration child reached idle boundary: {session}", flush=True)
        break
    time.sleep(30)
else:
    raise RuntimeError(f"Child watch deadline: {session}")
