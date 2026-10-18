#!/usr/bin/env python3
"""Minimal live subscription requests, with no model-callable side-effect tools."""

import base64
import argparse
import json
import pathlib
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid


root = pathlib.Path.home() / ".local/share/opencode-v2-migration"
connection = json.loads((root / "runtime/connection.json").read_text())
authorization = "Basic " + base64.b64encode(f'{connection["username"]}:{connection["password"]}'.encode()).decode()
directory = str(root / "projects/account-probe")
pathlib.Path(directory).mkdir(parents=True, exist_ok=True)


def api(path, body=None):
    request = urllib.request.Request(
        connection["url"] + path,
        data=None if body is None else json.dumps(body).encode(),
        headers={"Authorization": authorization, "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=45) as response:
        raw = response.read()
        return json.loads(raw) if raw else None


def unwrap(value):
    return value.get("data", value) if isinstance(value, dict) else value


requested = [
    ("openai", "gpt-6.1-sol", "MIGRATION_OPENAI_OK"),
    ("anthropic", "claude-sonnet-5-5", "MIGRATION_CLAUDE_OK"),
    ("cursor", "claude-opus-5", "MIGRATION_CURSOR_OK"),
]
parser = argparse.ArgumentParser()
parser.add_argument("--provider", choices=["openai", "anthropic", "cursor"])
arguments = parser.parse_args()
if arguments.provider:
    requested = [item for item in requested if item[0] == arguments.provider]
query = urllib.parse.urlencode({"location[directory]": directory})
deadline = time.monotonic() + 60
catalog = []
while time.monotonic() < deadline:
    catalog = unwrap(api("/api/model?" + query))
    available = {(item["providerID"], item["id"]) for item in catalog}
    if all((provider, model) in available for provider, model, _ in requested):
        break
    time.sleep(1)

report = {"created": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "models": [], "results": []}
plugin_ids = {item.get("id") for item in unwrap(api("/api/plugin?" + query))}
report["criticalPlugins"] = sorted(plugin_ids & {"cursor.provider", "local.claude-subscription", "moritz.model-policy"})
previous_report = root / "runtime/account-probes.json"
if previous_report.exists():
    previous = json.loads(previous_report.read_text())
    preserved = root / "runtime" / ("account-probes-" + re.sub(r"[^0-9]", "", previous["created"]) + ".json")
    if not preserved.exists():
        preserved.write_text(json.dumps(previous, indent=2) + "\n")
report["models"] = [
    {"providerID": item["providerID"], "id": item["id"], "capabilities": item.get("capabilities")}
    for item in catalog
    if (item["providerID"], item["id"]) in {(provider, model) for provider, model, _ in requested}
]
for provider, model, expected in requested:
    result = {"providerID": provider, "modelID": model, "success": False}
    session_id = None
    try:
        required = "local.claude-subscription" if provider == "anthropic" else "cursor.provider" if provider == "cursor" else None
        if required and required not in plugin_ids:
            result["error"] = "critical_subscription_plugin_not_loaded"
            continue
        if (provider, model) not in available:
            result["error"] = "requested_model_unavailable_in_native_catalog"
            continue
        # Keep company-paid Cursor activity inside its existing work routing
        # boundary. No probe receives executable tools or modifies that repo.
        location = str(pathlib.Path.home() / "Code/arca") if provider == "cursor" else directory
        created = unwrap(api("/api/session", {
            "title": f"Migration subscription probe: {provider}",
            "location": {"directory": location},
            "permissions": [{"action": "*", "resource": "*", "effect": "deny"}],
            "metadata": {"migrationProbe": True},
        }))
        session_id = created["id"]
        result["sessionID"] = session_id
        api(f"/api/session/{session_id}/model", {"model": {"providerID": provider, "id": model}})
        api(f"/api/session/{session_id}/prompt", {
            "id": "msg_" + uuid.uuid4().hex,
            "text": f"This is a subscription connectivity check. Reply with exactly {expected}. Do not use tools.",
        })
        deadline = time.monotonic() + 180
        while time.monotonic() < deadline:
            messages = api(f"/api/session/{session_id}/message?limit=10&order=desc")["data"]
            assistants = [message for message in messages if message["type"] == "assistant"]
            if assistants:
                latest = assistants[0]
                text = "".join(part.get("text", "") for part in latest["content"] if part["type"] == "text").strip()
                if latest.get("time", {}).get("completed"):
                    result["actualModel"] = latest["model"]
                    result["toolCalls"] = sum(part["type"] == "tool" for part in latest["content"])
                    result["expectedTextMatched"] = text == expected
                    result["success"] = text == expected and latest["model"]["providerID"] == provider and result["toolCalls"] == 0
                    if latest.get("error"):
                        result["errorType"] = latest["error"].get("type")
                    break
            time.sleep(0.5)
        else:
            result["error"] = "bounded_probe_deadline"
    except urllib.error.HTTPError as error:
        result["httpStatus"] = error.code
    except (OSError, KeyError, ValueError) as error:
        result["error"] = type(error).__name__
    finally:
        if session_id:
            api(f"/api/session/{session_id}/interrupt", {})
        report["results"].append(result)
        (root / "runtime/account-probes.json").write_text(json.dumps(report, indent=2) + "\n")
        print(json.dumps(result), flush=True)

if not all(result["success"] for result in report["results"]):
    raise SystemExit(1)
