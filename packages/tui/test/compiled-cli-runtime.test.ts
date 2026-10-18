import { expect, test } from "bun:test"
import path from "node:path"
import { mkdir } from "node:fs/promises"
import { existsSync } from "node:fs"
import { EmbeddedTerminalRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { tmpdir } from "./fixture/fixture"
import { createEventStream, createFetch, json } from "./fixture/tui-client"
import { install, installRuntimePeer } from "./fixture/runtime-peer"
import type { Config } from "../src/config"

const binary = process.env.OPENCODE_COMPILED_CLI
if (binary && (await Bun.file(binary).slice(0, 2).text()) === "#!")
  throw new Error(
    "OPENCODE_COMPILED_CLI must be the native executable, not a profile launcher that overrides isolation",
  )

// Run after the normal CLI build. This boots the production default command,
// configuration loader and external plugin loader through an actual local PTY.
test.skipIf(!binary || process.platform === "win32")(
  "production compiled CLI shares physical NPM peers through profile-style wrappers",
  async () => {
    await using root = await tmpdir()
    const peer = await installRuntimePeer(root.path)
    for (const native of [false, true]) {
      await peer.entry(native)
      await runCLI(
        peer.consumer,
        [peer.wrapper],
        ["Shared runtime 0", "ctrl+p commands"],
        ["Shared action 1", "Shared runtime 1"],
      )
    }
  },
  60_000,
)

const profile = process.env.OPENCODE_COMPILED_PROFILE_PACKAGES
test.skipIf(!binary || !profile || process.platform === "win32")(
  "production compiled CLI activates exact packed speech parity and todo wrappers with physical peers",
  async () => {
    await using root = await tmpdir()
    const manifest = await Bun.file(profile ?? "").json()
    const consumer = path.join(root.path, "profile")
    await mkdir(consumer)
    await Bun.write(
      path.join(consumer, "package.json"),
      JSON.stringify({
        private: true,
        type: "module",
        dependencies: {
          ...manifest.dependencies,
          "@opentui/core": "0.6.6",
          "@opentui/solid": "0.6.6",
          "solid-js": "1.9.15",
        },
      }),
    )
    await install(consumer)
    for (const entry of ["tui", "v2"]) {
      const plugins = []
      for (const [name, target] of [
        ["speech", `opencode-read-aloud/${entry}`],
        ["parity-ui", "@moritz/opencode-parity-plugins/tui"],
        ["todo-ui", "@moritz/opencode-todo/tui"],
      ]) {
        const directory = path.join(consumer, "ports", name)
        await mkdir(directory, { recursive: true })
        await Bun.write(path.join(directory, "tui.js"), `export { default } from ${JSON.stringify(target)}\n`)
        plugins.push({ package: directory, ...(name === "speech" ? { options: { placement: "footer" } } : {}) })
      }
      await runCLI(consumer, plugins, ["Compiled durable TODO", "ctrl+p commands"], ["No answer to read yet"], true)
    }
  },
  120_000,
)

async function runCLI(
  consumer: string,
  plugins: NonNullable<Config.Info["plugins"]>,
  ready: string[],
  changed: string[],
  media = false,
) {
  const { spawn } = await import("../../core/node_modules/bun-pty")
  const session = {
    id: "ses_compiled_runtime",
    title: "Compiled runtime",
    projectID: "project",
    location: { directory: consumer },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 1 },
  }
  const events = createEventStream()
  const calls = createFetch((url) => {
    if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
    if (url.pathname.endsWith("/message") || url.pathname.endsWith("/inbox")) return json({ data: [], cursor: {} })
    if (url.pathname === "/api/rpc/moritz-todo/get")
      return json({
        output: {
          sessionID: session.id,
          revision: 0,
          todos: [{ content: "Compiled durable TODO", status: "in_progress", priority: "high" }],
        },
      })
    return undefined
  }, events)
  const server = Bun.serve({ port: 0, idleTimeout: 0, fetch: (request) => calls.fetch(request) })
  const output = await createTestRenderer({ width: 140, height: 38, useThread: false, remote: true })
  const child = spawn(binary ?? "", ["--server", server.url.toString(), "--session", session.id], {
    name: "xterm-256color",
    cols: 140,
    rows: 38,
    cwd: consumer,
    env: {
      // No Swift compiler/media helper or other host utility discovery in the
      // real speech setup. The idle/no-answer action never synthesizes audio.
      PATH: media ? path.join(consumer, "no-host-utilities") : (process.env.PATH ?? "/usr/bin:/bin"),
      LANG: "en_US.UTF-8",
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      HOME: consumer,
      OPENCODE_TEST_HOME: consumer,
      XDG_CONFIG_HOME: path.join(consumer, "config"),
      XDG_DATA_HOME: path.join(consumer, "data"),
      XDG_STATE_HOME: path.join(consumer, "state"),
      XDG_CACHE_HOME: path.join(consumer, "cache"),
      OPENCODE_CONFIG_DIR: path.join(consumer, "config"),
      OPENCODE_CONFIG_CONTENT: "{}",
      OPENCODE_DB: path.join(consumer, "isolated.sqlite"),
      OPENCODE_DISABLE_MODELS_FETCH: "true",
      OPENCODE_DISABLE_FILEWATCHER: "true",
      OPENCODE_DISABLE_AUTOUPDATE: "true",
      OPENCODE_CLI_CONFIG_CONTENT: JSON.stringify({ animations: false, tabs: { mode: "off" }, plugins }),
    },
  })
  const terminal = new EmbeddedTerminalRenderable(output.renderer, {
    id: "compiled-cli",
    width: 140,
    height: 38,
    cols: 140,
    rows: 38,
    onData: (data) => child.write(Buffer.from(data).toString("utf8")),
  })
  output.renderer.root.add(terminal)
  let raw = ""
  let exited = false
  const exit = Promise.withResolvers<void>()
  const data = child.onData((text) => {
    raw = (raw + text).slice(-1_000_000)
    terminal.write(text)
  })
  const done = child.onExit(() => {
    exited = true
    exit.resolve()
  })
  async function frame(text: string) {
    const deadline = Date.now() + 15_000
    while (!exited && Date.now() < deadline) {
      await output.renderOnce()
      if (terminal.screen().text.includes(text)) return
      await Bun.sleep(10)
    }
    const logs = []
    if (existsSync(path.join(consumer, "data"))) {
      for await (const file of new Bun.Glob("**/*.log").scan({ cwd: path.join(consumer, "data"), absolute: true }))
        logs.push((await Bun.file(file).text()).slice(-16_384))
    }
    throw new Error(
      `Production CLI missing ${text}; exited=${exited}\n${terminal.screen().text}\n${raw.slice(-2_000)}\n${logs.join("\n")}`,
    )
  }
  async function waitExit(milliseconds: number) {
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      exit.promise,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, milliseconds)
      }),
    ])
    clearTimeout(timer)
    return exited
  }
  try {
    for (const text of ready) await frame(text)
    child.write("\x13")
    for (const text of changed) await frame(text)
    expect(raw).not.toContain("already registered with a different configuration")
    expect(raw).not.toContain("ConfigProvider is missing")
  } finally {
    child.write("\x03")
    if (!(await waitExit(1_000))) {
      const group = Number(
        Bun.spawnSync(["ps", "-o", "pgid=", "-p", String(child.pid)])
          .stdout.toString()
          .trim(),
      )
      const parent = Number(
        Bun.spawnSync(["ps", "-o", "pgid=", "-p", String(process.pid)])
          .stdout.toString()
          .trim(),
      )
      if (group > 1 && group !== parent) {
        process.kill(-group, "SIGTERM")
        if (!(await waitExit(1_000))) process.kill(-group, "SIGKILL")
      }
      expect(await waitExit(1_000)).toBe(true)
    }
    data.dispose()
    done.dispose()
    output.renderer.destroy()
    await server.stop(true)
  }
}
