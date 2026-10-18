"""Read current V1 session activity without changing service authority."""
import json
import pathlib
import subprocess

home = pathlib.Path.home()
root = home / ".local/share/opencode-v2"
others = ["claude", "codex", "pi", "copilot", "cursor", "antigravity", "mistral-vibe", "muse", "qwen", "kimi", "omp", "grok", "kilo", "openhands", "hermes", "mastracode", "devin"]
result = subprocess.run([str(home / ".local/bin/agentview"), "--opencode-bin", str(home / ".local/bin/opencode-dev"), *["--no-host-" + name for name in others], "--all", "--json"], capture_output=True, text=True, timeout=90, check=True)
snapshot = json.loads(result.stdout)
runtime = root / "runtime"
runtime.mkdir(exist_ok=True, mode=0o700)
report = runtime / "v1-inventory.json"
report.write_text(json.dumps(snapshot, indent=2) + "\n")
report.chmod(0o600)
active = [item for item in snapshot["sessions"] if item["provider"] == "opencode" and item["state"] not in ["completed", "stopped"]]
print(json.dumps({"sessions": [{key: item.get(key) for key in ["provider_session_id", "name", "cwd", "state", "kind"]} for item in active], "total": len(snapshot["sessions"]), "warnings": snapshot.get("warnings", [])}, indent=2))
