import { expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"

test("real SessionRunner Code Mode MCP hooks, native shell env and native write", async () => {
  const home = mkdtempSync(join(tmpdir(), "v2-combined-hooks-"))
  mkdirSync(join(home, "tmp"))
  try {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "combined-scenario.js")], {
      cwd: home, stdout: "pipe", stderr: "pipe",
      env: { ...process.env, HOME: home, TMPDIR: join(home, "tmp"), CLAUDE_CONFIG_DIR: join(home, ".claude"), CLAUDE_CODE_SESSION_ID: "outer-id-must-be-replaced", XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local/share"), XDG_CACHE_HOME: join(home, ".cache"), XDG_STATE_HOME: join(home, ".local/state"), OPENCODE_V2_HOST: process.env.OPENCODE_V2_HOST ?? join(import.meta.dir, "../../.."), PARITY_EMAIL_HOOK_SOURCE: process.env.PARITY_EMAIL_HOOK_SOURCE ?? join(homedir(), ".claude/hooks/gmail-html-only.py") },
    })
    const [output, error] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
    if (await child.exited) throw new Error(`${output}\n${error}`)
    expect({ output, error }).toEqual({ output: "COMBINED_RUNNER_HOOKS_OK\n", error: "" })
  } finally { rmSync(home, { recursive: true, force: true }) }
}, 120000)
