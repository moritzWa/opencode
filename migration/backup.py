#!/usr/bin/env python3
"""Take a consistent online backup of V1 into the isolated candidate profile."""

import datetime
import argparse
from contextlib import closing
import json
import os
import pathlib
import sqlite3
import shlex
import subprocess
import time


def main():
    home = pathlib.Path.home()
    parser = argparse.ArgumentParser()
    parser.add_argument("root", nargs="?", default=str(home / ".local/share/opencode-v2-migration"))
    parser.add_argument("--source", default=str(home / ".local/share/opencode/opencode.db"))
    parser.add_argument("--target")
    parser.add_argument("--snapshot-only", action="store_true")
    parser.add_argument("--frozen-clone", action="store_true", help="APFS clone of a stopped V1 database; refuses live writers")
    args = parser.parse_args()
    source = pathlib.Path(args.source).resolve()
    root = pathlib.Path(args.root).resolve()
    target = pathlib.Path(args.target).resolve() if args.target else root / "data/opencode/history-v1.db"
    if not target.is_relative_to(root):
        raise RuntimeError("Snapshot destination must stay inside the explicit migration profile")
    if target.exists() or source.resolve() == target.resolve():
        raise RuntimeError("Refusing to overwrite a database")
    if not (root / "profile.json").is_file():
        raise RuntimeError("Prepare the isolated profile first")
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.umask(0o077)
    started = time.monotonic()
    temporary = target.with_name(f"opencode-backup-{os.getpid()}.db")
    if args.frozen_clone:
        from cutover.host import Host
        if Host().writers(source):
            raise RuntimeError("Frozen clone requires all source writers to be stopped")
    with closing(sqlite3.connect(source.as_uri() + "?mode=ro", uri=True)) as original:
        # Pin one read snapshot. Without this transaction, backup stepping can
        # restart repeatedly while the live agents keep writing to the source.
        original.execute("BEGIN")
        original.execute("SELECT count(*) FROM sqlite_master").fetchone()
        print("Snapshot pinned; copying live history without blocking writers", flush=True)
        if args.frozen_clone:
            for suffix in ("", "-wal"):
                source_file = pathlib.Path(str(source) + suffix)
                if source_file.exists():
                    copied_file = pathlib.Path(str(temporary) + suffix)
                    subprocess.run(["/bin/cp", "-c", str(source_file), str(copied_file)], check=True, timeout=60)
                    copied_file.chmod(0o600)
        with closing(sqlite3.connect(temporary)) as copied:
            if not args.frozen_clone:
                original.backup(copied, pages=8192, sleep=0.05)
            check = copied.execute("PRAGMA quick_check").fetchone()[0]
            if check != "ok":
                raise RuntimeError(f"Copied database check failed: {check}")
            counts = {
                name: copied.execute(f"SELECT count(*) FROM {name}").fetchone()[0]
                for name in ("session", "message", "part")
            }
            if args.frozen_clone and counts != {name: original.execute(f"SELECT count(*) FROM {name}").fetchone()[0] for name in counts}:
                raise RuntimeError("Frozen clone differs from pinned source counts")
            # A SQLite connection context commits but does not close. Close and
            # checkpoint before moving the main file, or its WAL stays attached
            # to the old temporary filename rather than the published database.
            copied.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchall()
    os.replace(temporary, target)
    with closing(sqlite3.connect(target.as_uri() + "?mode=ro", uri=True)) as verified:
        reopened = {
            name: verified.execute(f"SELECT count(*) FROM {name}").fetchone()[0]
            for name in counts
        }
        if reopened != counts:
            raise RuntimeError("Reopened backup differs from its source snapshot")
    report = {
        "created": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "source": str(source),
        "target": str(target),
        "method": "apfs-frozen-clone-readonly-source" if args.frozen_clone else "sqlite-online-backup-readonly-source",
        "quick_check": check,
        "reopened_counts_verified": True,
        "counts": counts,
        "bytes": target.stat().st_size,
        "seconds": round(time.monotonic() - started, 2),
    }
    previous = root / "reference" / (f"snapshot-{target.stem}.json" if args.snapshot_only else "backup.json")
    if previous.exists():
        previous.rename(root / "reference/backup-initial-invalid.json")
    previous.write_text(json.dumps(report, indent=2) + "\n")
    if args.snapshot_only:
        target.chmod(0o400)
        print("Retained snapshot complete: " + json.dumps(report), flush=True)
        return
    profile_path = root / "profile.json"
    profile = json.loads(profile_path.read_text())
    profile["environment"]["OPENCODE_DB"] = str(target)
    profile_path.write_text(json.dumps(profile, indent=2) + "\n")
    wrapper = root / "bin/opencode-v2-candidate"
    assignments = " ".join(f"{key}={shlex.quote(value)}" for key, value in profile["environment"].items())
    wrapper.write_text(f'#!/bin/sh\nexec env {assignments} {shlex.quote(profile["executable"])} "$@"\n')
    wrapper.chmod(0o700)
    print("Backup complete: " + json.dumps(report), flush=True)


if __name__ == "__main__":
    main()
