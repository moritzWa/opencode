"""Guest-only launcher: private credentials stay in files/environment, not argv."""
import json
import os
import pathlib

root = pathlib.Path("/Users/lume/Code/opencode-v2-migration")
connection = json.loads((root / "runtime/connection.json").read_text())
fixture = json.loads((root / "runtime/ui-fixture.json").read_text())
config_path = root / "config/opencode/cli.json"
config = json.loads(config_path.read_text())
for plugin in config["plugins"]:
    plugin["package"] = str(root / "config/opencode/ports" / pathlib.Path(plugin["package"]).name)
config_path.write_text(json.dumps(config, indent=2) + "\n")
for filename in [root / "runtime/connection.json", root / "data/opencode/speechify.key"]:
    filename.chmod(0o600)
environment = {
    **os.environ,
    "XDG_CONFIG_HOME": str(root / "config"),
    "XDG_DATA_HOME": str(root / "data"),
    "XDG_CACHE_HOME": str(root / "cache"),
    "XDG_STATE_HOME": str(root / "state"),
    "OPENCODE_CONFIG_DIR": str(root / "config/opencode"),
    "OPENCODE_PASSWORD": connection["password"],
    "OPENCODE_TUI_CLIENT_ID": "v2-migration-vm",
    "OPENCODE_DISABLE_AUTOUPDATE": "1",
    "PATH": str(root / "bin") + ":" + os.environ["PATH"],
}
os.chdir(root)
executable = str(root / "bin/opencode-v2-candidate")
os.execve(executable, [executable, "--server", connection["vm_url"], "--session", fixture["sessionID"]], environment)
