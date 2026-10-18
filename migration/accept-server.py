#!/usr/bin/env python3
"""Read-only acceptance against the authenticated candidate and imported history."""

import base64
from contextlib import closing
import json
import pathlib
import sqlite3
import sys
import urllib.error
import urllib.parse
import urllib.request


root = pathlib.Path.home() / ".local/share/opencode-v2-migration"
profile = json.loads((root / "profile.json").read_text())
connection = json.loads((root / "runtime/connection.json").read_text())
authorization = "Basic " + base64.b64encode(f'{connection["username"]}:{connection["password"]}'.encode()).decode()


def request(path, authenticated=True):
    headers = {"Authorization": authorization} if authenticated else {}
    with urllib.request.urlopen(urllib.request.Request(connection["url"] + path, headers=headers), timeout=30) as response:
        return json.load(response)


try:
    request("/api/info", authenticated=False)
    raise AssertionError("Candidate API unexpectedly permits unauthenticated access")
except urllib.error.HTTPError as error:
    assert error.code == 401, error.code

info = request("/api/info")
assert info["pid"] == connection["pid"]
assert request("/api/experimental/migration/v1")["status"] == "completed"
if "--extended" in sys.argv:
    assert info["capabilities"]["tuiSessionSelect"] is True
    assert info["capabilities"]["tuiExecuteCommand"] is True

with closing(sqlite3.connect(pathlib.Path(profile["environment"]["OPENCODE_DB"]).as_uri() + "?mode=ro", uri=True)) as db:
    missing = db.execute("SELECT count(*) FROM session s LEFT JOIN session_v2 v ON v.id=s.id WHERE v.id IS NULL").fetchone()[0]
    assert missing == 0, f"Missing imported sessions: {missing}"
    expected_count = db.execute("SELECT count(*) FROM session").fetchone()[0]
    selected = db.execute("SELECT id,title FROM session WHERE parent_id IS NULL ORDER BY time_updated DESC LIMIT 1").fetchone()
    assert selected is not None
    loaded = request("/api/session/" + selected[0])
    loaded = loaded.get("data", loaded)
    assert loaded["id"] == selected[0]
    assert loaded["title"] == selected[1]
    expected_ids = [row[0] for row in db.execute("SELECT id FROM session_message WHERE session_id=? ORDER BY seq DESC LIMIT 3", (selected[0],))]
    messages = request("/api/session/" + selected[0] + "/message?" + urllib.parse.urlencode({"limit": 3, "order": "desc"}))
    actual_ids = [message["id"] for message in messages["data"]]
    assert actual_ids == expected_ids, (actual_ids, expected_ids)

report = {
    "version": info["version"],
    "authenticated": True,
    "unauthenticated_rejected": True,
    "server_pid_matches": True,
    "imported_sessions": expected_count,
    "missing_sessions": missing,
    "sample_session_title_matches": True,
    "sample_message_page_matches": True,
    "capabilities": info["capabilities"],
}
(root / "runtime/server-acceptance.json").write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps(report, indent=2))
