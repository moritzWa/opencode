#!/usr/bin/env python3
"""Guest/host final dashboard entry; invoked only by the armed coordinator."""
import os
from pathlib import Path
import sys
import signal

from host import Host, private_json, read_private


def main():
    request = read_private(sys.argv[1])
    os.chdir(request["cwd"])
    # Ghostty may launch the command as a child of its shell's foreground group.
    # Give the dashboard its own verifiable group without leaving it backgrounded.
    if os.getpgrp() != os.getpid():
        os.setpgid(0, 0)
        if os.isatty(0):
            previous = signal.signal(signal.SIGTTOU, signal.SIG_IGN)
            os.tcsetpgrp(0, os.getpgrp())
            signal.signal(signal.SIGTTOU, previous)
    identity = Host().identity(os.getpid())
    private_json(Path(request["receipt"]), {"pid": os.getpid(), "pgid": os.getpgrp(),"start":identity["start"]})
    environment = {**os.environ, **request["environment"]}
    os.execve(request["argv"][0], request["argv"], environment)


if __name__ == "__main__":
    main()
