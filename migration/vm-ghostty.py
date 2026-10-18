"""Guest-only lifecycle for the exact migration Ghostty and its CLI children."""
import argparse
import json
import os
import pathlib
import shlex
import signal
import subprocess
import time

parser = argparse.ArgumentParser()
parser.add_argument("action", choices=["start", "stop"])
parser.add_argument("--dashboard", action="store_true")
arguments = parser.parse_args()
root = pathlib.Path("/Users/lume/Code/opencode-v2-migration")
executable = "/Users/lume/Applications/OpenCode-V2-Ghostty.app/Contents/MacOS/ghostty"
receipt = root / "runtime/ghostty-process.json"


def processes():
    rows = subprocess.check_output(["ps", "-axo", "pid=,pgid=,comm="], text=True)
    ghostty_pid = json.loads(receipt.read_text())["pid"] if receipt.exists() else None
    result = []
    for row in rows.splitlines():
        pid, pgid, command = row.strip().split(maxsplit=2)
        if command in [str(root / "bin/opencode-v2-candidate"), str(root / "bin/agentview-v2-candidate")] or (int(pid) == ghostty_pid and command == executable):
            result.append((int(pid), int(pgid)))
    return result


if arguments.action == "stop":
    for group in {item[1] for item in processes()}:
        try:
            os.killpg(group, signal.SIGTERM)
        except ProcessLookupError:
            pass
    deadline = time.monotonic() + 5
    while processes() and time.monotonic() < deadline:
        time.sleep(0.1)
    for group in {item[1] for item in processes()}:
        try:
            os.killpg(group, signal.SIGKILL)
        except ProcessLookupError:
            pass
    if processes():
        raise SystemExit("Own migration GUI/client processes survived shutdown")
    print("Verified zero owned migration GUI/client processes")
    raise SystemExit(0)

existing = processes()
if arguments.dashboard:
    stack = json.loads((root / "runtime/stack-profile.json").read_text())
    service = json.loads((pathlib.Path(stack["profile"]) / "registration.json").read_text())["pid"]
    existing = [item for item in existing if item[0] != service]
if existing:
    raise SystemExit("Own migration GUI/client already running")
for name in ["runtime/connection.json", "data/opencode/speechify.key"]:
    (root / name).chmod(0o600)
subprocess.run(["osascript", "-e", "set volume output muted true", "-e", "set volume output volume 0"], check=True)
with (root / "runtime/ghostty.log").open("ab") as log:
    child = subprocess.Popen([executable, "--config-file=" + str(root / "config/ghostty/config"), "--window-save-state=never", "--working-directory=" + str(root), "--initial-command=" + shlex.join(["/usr/bin/python3", str(root / "runtime" / ("vm-dashboard.py" if arguments.dashboard else "vm-client.py"))])], stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
receipt.write_text(json.dumps({"pid": child.pid, "pgid": child.pid}) + "\n")
print("Started own migration Ghostty", child.pid)
