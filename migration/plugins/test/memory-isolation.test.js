import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

test.each([false, true])("memory-only root injection preserves process/auth environment (explicit auth root %s)", async (explicit) => {
  const root = mkdtempSync(join(tmpdir(), "memory-root-isolation-"))
  try {
    const env = { ...process.env, HOME: root, XDG_DATA_HOME: join(root, "data"), XDG_STATE_HOME: join(root, "state"), XDG_CONFIG_HOME: join(root, "config"), XDG_CACHE_HOME: join(root, "cache") }
    if (explicit) env.CLAUDE_CONFIG_DIR = join(root, "auth-claude")
    else delete env.CLAUDE_CONFIG_DIR
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "memory-isolation-scenario.js")], {
      cwd: root, stdout: "pipe", stderr: "pipe",
      env,
    })
    const [output, error] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
    if (await child.exited) throw new Error(`${output}\n${error}`)
    expect({ output, error }).toEqual({ output: "MEMORY_ROOT_ISOLATION_OK\n", error: "" })
  } finally { rmSync(root, { recursive: true, force: true }) }
})
