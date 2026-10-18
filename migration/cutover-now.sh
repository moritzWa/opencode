#!/bin/sh
set -eu
exec python3 "$HOME/.claude/scripts/heavy-job.py" --wait -- \
  python3 "$(dirname "$0")/manual-cutover.py"
