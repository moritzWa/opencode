#!/usr/bin/env python3
"""Message an explicitly selected migration session on the existing V1 server."""

import base64
import json
import os
import pathlib
import sys
import urllib.parse
import urllib.request


def main():
    session, directory, text = sys.argv[1:]
    record_path = pathlib.Path(os.environ.get("AGENTVIEW_OPENCODE_SERVER_RECORD", "")) if os.environ.get("AGENTVIEW_OPENCODE_SERVER_RECORD") else pathlib.Path(os.environ.get("XDG_STATE_HOME", str(pathlib.Path.home() / ".local/state"))) / "agentview/opencode/server.json"
    record = json.loads(record_path.read_text())
    credential = base64.b64encode(
        f'{record["username"]}:{record["password"]}'.encode()
    ).decode()
    v2 = str(record.get("api", "v1")).lower() == "v2"
    endpoint = f"/api/session/{session}/prompt" if v2 else f"/session/{session}/prompt_async?" + urllib.parse.urlencode({"directory": directory})
    body = {"text": text} if v2 else {"parts": [{"type": "text", "text": text}]}
    request = urllib.request.Request(
        f'http://127.0.0.1:{record["port"]}' + endpoint,
        data=json.dumps(body).encode(),
        headers={
            "Authorization": f"Basic {credential}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        print(f"{session}: HTTP {response.status}")


if __name__ == "__main__":
    main()
