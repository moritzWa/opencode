#!/usr/bin/env python3
"""Foreground operator entry: use from a separate terminal, never an agent tool."""
import json
from pathlib import Path
import subprocess
import sys
import time

sys.path.insert(0, str(Path(__file__).with_name("cutover")))
from controller import Settings, arm
from host import Host, Refusal, private_json, read_private


def main():
    config = Path.home() / ".local/share/opencode-v2/runtime/cutover-config.json"
    settings, host = Settings.load(config), Host()
    old = read_private(settings.state / "server.json")
    if old["pid"] in host.ancestors():
        raise Refusal("Run this command in a separate Terminal window, not inside OpenCode.")
    print("Checking the prepared V2 profile and creating a fresh cutover plan...", flush=True)
    result = arm(settings, host, config)
    plan = read_private(result["plan"])
    directory = Path(result["plan"]).parent
    private_json(settings.ready, {"runID": plan["runID"], "managerSessionID": settings.manager_session,
                                 "ready": True, "expiresAtMs": plan["createdMs"] + 25 * 60 * 1000})
    print("Keep this terminal open. History copy and verification can take several minutes.", flush=True)
    print("Evidence and logs: " + str(directory), flush=True)
    child = subprocess.Popen([sys.executable, str(directory / "code/controller.py"), "execute", "--armed", "--plan", result["plan"]])
    previous = None
    while child.poll() is None:
        journal = directory / "journal.json"
        if journal.exists():
            current = read_private(journal)
            phase = current["phases"][-1]["phase"] if current["phases"] else "preflight"
            state = (phase, current["status"])
            if state != previous:
                print(f"{time.strftime('%H:%M:%S')}  {phase}: {current['status']}", flush=True)
                previous = state
        time.sleep(1)
    code = child.wait()
    journal = directory / "journal.json"
    if journal.exists():
        current = read_private(journal)
        print("Final result: " + current["status"] + "; authority=" + current["authority"], flush=True)
        if current.get("error"):
            print(json.dumps(current["error"]), flush=True)
    raise SystemExit(code)


if __name__ == "__main__":
    try:
        main()
    except Refusal as error:
        print("Stopped before proceeding: " + str(error), file=sys.stderr)
        raise SystemExit(2)
