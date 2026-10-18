import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

test("portable server registrations, hooks, memory and real monitor lifecycle", async () => {
  const home = mkdtempSync(join(tmpdir(), "v2-plugin-test-"))
  try {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "scenario.js")], {
      cwd: home,
      env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude"), XDG_DATA_HOME: join(home, ".local/share"), XDG_STATE_HOME: join(home, ".local/state"), XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache") },
      stdout: "pipe", stderr: "pipe",
    })
    const output = await new Response(child.stdout).text()
    const error = await new Response(child.stderr).text()
    expect({ exit: await child.exited, error, output }).toEqual({ exit: 0, error: "", output: "SERVER_LIFECYCLE_OK\n" })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}, 30000)
