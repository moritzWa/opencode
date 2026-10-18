#!/usr/bin/env python3
"""Guest/host final dashboard entry; invoked only by the armed coordinator."""
import os
from pathlib import Path
import sys

from host import Host, private_json, read_private


def main():
    request = read_private(sys.argv[1])
    os.chdir(request["cwd"])
    identity = Host().identity(os.getpid())
    private_json(Path(request["receipt"]), {"pid": os.getpid(), "pgid": os.getpgrp(),"start":identity["start"]})
    environment = {**os.environ, **request["environment"]}
    os.execve(request["argv"][0], request["argv"], environment)


if __name__ == "__main__":
    main()
