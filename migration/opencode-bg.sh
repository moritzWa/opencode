#!/bin/bash
# Start a persistent background session on the selected agentview V1/V2 server.
# Install this dual-version helper only as part of the verified migration.
set -euo pipefail

if [ $# -lt 3 ]; then
  echo "usage: $0 <directory> <title> <brief...>" >&2
  exit 2
fi
dir=$(cd "$1" && pwd)
title=$2
shift 2
brief=$*
record=${AGENTVIEW_OPENCODE_SERVER_RECORD:-${XDG_STATE_HOME:-$HOME/.local/state}/agentview/opencode/server.json}
if [ -z "${AGENTVIEW_OPENCODE_SERVER_RECORD:-}" ] && [ -s "$HOME/.local/state/install-latest/opencode-v2-ref" ]; then
  profile=${INSTALL_LATEST_OPENCODE_V2_PROFILE:-$HOME/.local/share/opencode-v2}
  [ ! -f "$profile/runtime/cutover.pending" ] || { echo "OpenCode migration is finishing; retry shortly" >&2; exit 75; }
  record=$(python3 -c 'import json,pathlib,sys; p=json.load(open(sys.argv[1])); print(pathlib.Path(p["environment"]["XDG_STATE_HOME"])/"agentview/opencode/server.json")' "$profile/profile.json")
fi
[ -r "$record" ] || { echo "no agentview OpenCode server record at $record" >&2; exit 1; }

python3 - "$record" "$dir" "$title" "$brief" <<'PY'
import base64
import json
import sys
import urllib.parse
import urllib.request

record_path, directory, title, brief = sys.argv[1:]
with open(record_path) as handle:
    record = json.load(handle)
auth = "Basic " + base64.b64encode(f'{record["username"]}:{record["password"]}'.encode()).decode()
base = f'http://127.0.0.1:{record["port"]}'
v2 = str(record.get("api", "v1")).lower() == "v2"
query = "" if v2 else "?" + urllib.parse.urlencode({"directory": directory})


def call(method, path, body=None):
    request = urllib.request.Request(
        base + path + query,
        data=None if body is None else json.dumps(body).encode(),
        method=method,
        headers={"Authorization": auth, "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        raw = response.read()
        return json.loads(raw) if raw else None


try:
    created = call("POST", "/api/session" if v2 else "/session", {
        "title": title,
        **({"location": {"directory": directory}} if v2 else {}),
    })
    session = created.get("data", created)
    if v2:
        call("POST", f'/api/session/{session["id"]}/prompt', {"text": brief})
    else:
        call("POST", f'/session/{session["id"]}/prompt_async', {"parts": [{"type": "text", "text": brief}]})
except OSError as error:
    sys.exit(f"the selected OpenCode server did not accept the session ({error})")
print(session["id"])
PY
