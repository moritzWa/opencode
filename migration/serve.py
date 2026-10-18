#!/usr/bin/env python3
"""Run a bounded, authenticated candidate server without electing a live service."""

import base64
import json
import os
import pathlib
import secrets
import signal
import socket
import subprocess
import sys
import time
import urllib.request


def main():
    root = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else pathlib.Path.home() / ".local/share/opencode-v2-migration"
    profile = json.loads((root / "profile.json").read_text())
    database = pathlib.Path(profile["environment"]["OPENCODE_DB"])
    if not (root / "reference/backup.json").is_file() or not database.is_file():
        raise RuntimeError("Verified online history backup must finish before the candidate starts")
    if database.resolve() == (pathlib.Path.home() / ".local/share/opencode/opencode.db").resolve():
        raise RuntimeError("Refusing the live database")
    os.umask(0o077)
    runtime = root / "runtime"
    runtime.mkdir(exist_ok=True)
    with socket.socket() as selection:
        selection.bind(("127.0.0.1", 0))
        port = selection.getsockname()[1]
    password = secrets.token_urlsafe(32)
    environment = {**os.environ, **profile["environment"], "OPENCODE_PASSWORD": password}
    connection = {
        "url": f"http://127.0.0.1:{port}",
        "vm_url": f"http://192.168.64.1:{port}",
        "username": "opencode",
        "password": password,
        "profile": str(root),
    }
    authorization = "Basic " + base64.b64encode(f"opencode:{password}".encode()).decode()
    log = (runtime / "server.log").open("ab", buffering=0)
    child = subprocess.Popen(
        [profile["executable"], "serve", "--hostname", "0.0.0.0", "--port", str(port)],
        cwd=root,
        env=environment,
        stdout=log,
        stderr=subprocess.STDOUT,
    )
    connection["pid"] = child.pid
    (runtime / "connection.json").write_text(json.dumps(connection, indent=2) + "\n")

    stopping = False

    def stop(_signum, _frame):
        nonlocal stopping
        stopping = True
        if child.poll() is None:
            child.terminate()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        deadline = time.monotonic() + 1200
        while child.poll() is None:
            try:
                request = urllib.request.Request(connection["url"] + "/api/info", headers={"Authorization": authorization})
                with urllib.request.urlopen(request, timeout=5) as response:
                    info = json.load(response)
                (runtime / "info.json").write_text(json.dumps(info, indent=2) + "\n")
                print(f"READY isolated V2 candidate {connection['url']} pid={child.pid}", flush=True)
                break
            except (OSError, ValueError):
                if time.monotonic() >= deadline:
                    raise RuntimeError("Candidate startup deadline exceeded; inspect private runtime/server.log")
                time.sleep(2)
        # The candidate has an explicit lifecycle even if the manager disappears.
        try:
            code = child.wait(timeout=4 * 3600)
        except subprocess.TimeoutExpired:
            stopping = True
            print("Candidate four-hour test lease expired; shutting down", flush=True)
            child.terminate()
            code = child.wait(timeout=30)
        if code != 0 and not stopping:
            raise RuntimeError(f"Candidate server exited with code {code}; inspect private runtime/server.log")
    finally:
        if child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=30)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()
        log.close()
        print("Candidate server stopped and reaped", flush=True)


if __name__ == "__main__":
    main()
