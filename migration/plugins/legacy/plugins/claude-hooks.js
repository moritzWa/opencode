// @bun
// ../../../../../../../.config/opencode/plugins/claude-hooks.js
import { spawnSync } from "child_process";
import { readFileSync } from "fs";
import { homedir } from "os";
import { resolve } from "path";
var SETTINGS = `${homedir()}/.claude/settings.json`;
var HOOK_TIMEOUT_MS = 30000;
var EDIT_TOOLS = { edit: "Edit", write: "Write", multiedit: "MultiEdit", apply_patch: "Edit", patch: "Edit" };
function hookCommands(event, toolName) {
  let settings;
  try {
    settings = JSON.parse(readFileSync(SETTINGS, "utf8"));
  } catch {
    return [];
  }
  return (settings.hooks?.[event] ?? []).filter((entry) => !entry.matcher || new RegExp(`^(?:${entry.matcher})$`).test(toolName)).flatMap((entry) => entry.hooks ?? []).filter((hook) => hook.type === "command" && hook.command).map((hook) => hook.command);
}
function patchedFiles(patchText) {
  return [...(patchText ?? "").matchAll(/^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$/gm)].map((m) => m[1].trim());
}
function runHook(command, payload, cwd, sessionID) {
  return spawnSync("/bin/sh", ["-c", command], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    cwd,
    timeout: HOOK_TIMEOUT_MS,
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: sessionID }
  });
}
var ClaudeHooks = async ({ directory }) => ({
  "shell.env": async (input, output) => {
    if (input.sessionID)
      output.env.CLAUDE_CODE_SESSION_ID = input.sessionID;
  },
  "tool.execute.before": async (input, output) => {
    const gmail = input.tool.match(/^(gmail(?:-[\w-]+)?)_(send_email|draft_email)$/);
    if (gmail) {
      const toolName = `mcp__${gmail[1]}__${gmail[2]}`;
      const payload = {
        session_id: input.sessionID,
        hook_event_name: "PreToolUse",
        tool_name: toolName,
        tool_input: output.args ?? {},
        cwd: directory
      };
      for (const command of hookCommands("PreToolUse", toolName)) {
        const result = runHook(command, payload, directory, input.sessionID);
        if (result.status === 2) {
          throw new Error(result.stderr?.trim() || `Blocked by hook: ${command}`);
        }
      }
      return;
    }
    if (input.tool !== "bash")
      return;
    const cwd = output.args?.workdir ?? directory;
    const payload = {
      session_id: input.sessionID,
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: output.args?.command ?? "" },
      cwd
    };
    for (const command of hookCommands("PreToolUse", "Bash")) {
      const result = runHook(command, payload, cwd, input.sessionID);
      if (result.status === 2) {
        throw new Error(result.stderr?.trim() || `Blocked by hook: ${command}`);
      }
    }
  },
  "tool.execute.after": async (input) => {
    const toolName = EDIT_TOOLS[input.tool];
    if (!toolName)
      return;
    const args = input.args ?? {};
    const files = args.filePath ? [args.filePath] : patchedFiles(args.patchText);
    const commands = hookCommands("PostToolUse", toolName);
    for (const file of files) {
      for (const command of commands) {
        runHook(command, {
          session_id: input.sessionID,
          hook_event_name: "PostToolUse",
          tool_name: toolName,
          tool_input: { file_path: resolve(directory, file) },
          cwd: directory
        }, directory, input.sessionID);
      }
    }
  }
});
export {
  ClaudeHooks
};

//# debugId=D53D06381B9CCF9364756E2164756E21
