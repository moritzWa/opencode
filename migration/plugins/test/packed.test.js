import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"

test("packed speech and UI plugins load through the real V2 host runtime", async () => {
  const home = mkdtempSync(join(tmpdir(), "v2-packed-plugin-"))
  const root = join(import.meta.dir, "..")
  const speech = dirname(Bun.resolveSync("opencode-read-aloud/v2", root))
  const env = { ...process.env, HOME: home, XDG_CACHE_HOME: join(home, ".cache"), XDG_DATA_HOME: join(home, ".local/share"), XDG_STATE_HOME: join(home, ".local/state"), XDG_CONFIG_HOME: join(home, ".config"), OPENCODE_V2_HOST: process.env.OPENCODE_V2_HOST ?? join(root, "../..") }
  const run = async (args, cwd) => {
    const child = Bun.spawn([process.execPath, ...args], { cwd, env, stdout: "pipe", stderr: "pipe" })
    const output = await new Response(child.stdout).text()
    const error = await new Response(child.stderr).text()
    if (await child.exited) throw new Error(`${args.join(" ")}\n${output}\n${error}`)
    return output
  }
  try {
    await run(["pm", "pack", "--destination", home], speech)
    await run(["pm", "pack", "--destination", home], root)
    await Bun.write(join(home, "package.json"), JSON.stringify({ private: true, type: "module", dependencies: {
      "opencode-read-aloud": `file:${join(home, "opencode-read-aloud-0.1.0.tgz")}`,
      "@moritz/opencode-parity-plugins": `file:${join(home, "moritz-opencode-parity-plugins-0.0.0-migration.tgz")}`,
      "@opentui/core": "0.5.17", "@opentui/solid": "0.5.17", "solid-js": "1.9.15",
    } }))
    await run(["install", "--ignore-scripts"], home)
    const runner = join(import.meta.dir, "host-runtime.js")
    expect(await run([runner, join(home, "node_modules/opencode-read-aloud/v2.js")], home)).toContain("V2_HOST_LOADER_OK opencode-read-aloud")
    expect(await run([runner, join(home, "node_modules/@moritz/opencode-parity-plugins/tui.js")], home)).toContain("V2_HOST_LOADER_OK moritz-parity-tui")
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}, 120000)
