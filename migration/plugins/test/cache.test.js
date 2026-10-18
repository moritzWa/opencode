import { expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

test("memory wire prefix, initial recall, updates, ignore, compaction and restart stay durable", async () => {
  const home = mkdtempSync(join(tmpdir(), "v2-memory-cache-"))
  mkdirSync(join(home, "tmp"))
  try {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "cache-scenario.js")], { cwd: home, stdout: "pipe", stderr: "pipe", env: {
      ...process.env, HOME: home, TMPDIR: join(home, "tmp"), CLAUDE_CONFIG_DIR: join(home, ".claude"), XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local/share"), XDG_STATE_HOME: join(home, ".local/state"), XDG_CACHE_HOME: join(home, ".cache"), OPENCODE_V2_HOST: process.env.OPENCODE_V2_HOST ?? join(import.meta.dir, "../../.."),
    } })
    const [output, error] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
    if (await child.exited) throw new Error(`${output}\n${error}`)
    expect({ output, error }).toEqual({ output: "DURABLE_MEMORY_CACHE_OK\n", error: "" })
  } finally { rmSync(home, { recursive: true, force: true }) }
}, 120000)
