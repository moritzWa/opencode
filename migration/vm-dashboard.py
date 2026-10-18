"""Guest-only real agentview dashboard over the private completed fixture."""
import json
import os
import pathlib
import sys

root = pathlib.Path("/Users/lume/Code/opencode-v2-migration")
profile = json.loads((root / "runtime/stack-profile.json").read_text())
environment = {**os.environ, **profile["environment"]}
for key in ["OPENCODE_PASSWORD", "OPENCODE_SERVER_PASSWORD", "OPENCODE_SERVER_USERNAME", "OPENCODE_TUI_CLIENT_ID"]:
    environment.pop(key, None)
others = ["claude", "codex", "pi", "copilot", "cursor", "antigravity", "mistral-vibe", "muse", "qwen", "kimi", "omp", "grok", "kilo", "openhands", "hermes", "mastracode", "devin"]
executable = str(root / "bin/agentview-v2-candidate")
arguments = [executable, "--opencode-bin", str(root / "bin/opencode-v2-candidate"), *["--no-host-" + name for name in others], "--all", "--include-temp", "--cwd", profile["work"], "--launch-provider", "opencode", "--launch-cwd", profile["work"], "--refresh-ms", "500"]
if "--json" in sys.argv:
    arguments.append("--json")
os.chdir(profile["work"])
os.execve(executable, arguments, environment)
