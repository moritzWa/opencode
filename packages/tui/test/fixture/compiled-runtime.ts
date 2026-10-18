import { ensurePluginRuntime } from "@opencode/plugin/runtime"
import assert from "node:assert/strict"
import { Host } from "@opencode/plugin/host"
import { readdirSync } from "node:fs"
import path from "node:path"
import { TextRenderable } from "@opentui/core"
import { createElement } from "@opentui/solid"
import { createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import { createAppFixture } from "./app"

// Server/SDK consumers may initialize first; TUI sharing must extend that same
// canonical runtime rather than depending on being the first initializer.
ensurePluginRuntime()
await import("../../src/plugin/runtime-plugin-support.bun")

const directory = process.argv[2]
assert.ok(directory, "physical NPM package directory is required")
const wrapper = process.argv[3]
const entry = Host.resolve({ directory, name: "compiled-runtime-peer" }).tui
assert.ok(
  entry,
  JSON.stringify({
    directory,
    wrapper,
    argv: process.argv,
    files: readdirSync(directory),
    package: await Bun.file(path.join(directory, "package.json")).json(),
  }),
)
await using setup = await createAppFixture({
  config: { animations: false, tabs: { mode: "off" }, plugins: [wrapper ?? "compiled-runtime-peer"] },
  packages: { prepare: async () => ({ directory, name: "compiled-runtime-peer" }) },
})
await setup.ready
async function frame(text: string) {
  const deadline = Date.now() + 10_000
  while (!setup.captureCharFrame().includes(text)) {
    assert.ok(Date.now() < deadline, `missing ${text}:\n${setup.captureCharFrame()}`)
    await setup.renderOnce()
    await Bun.sleep(10)
  }
}
await frame("Shared runtime 0")
await frame("ctrl+p commands")
const peer = (await Host.load(entry)) as { probe(input: object): Record<string, boolean> }
assert.deepEqual(peer.probe({ TextRenderable, createElement, createSignal, createStore }), {
  core: true,
  solid: true,
  signals: true,
  stores: true,
})
setup.mockInput.pressKey("s", { ctrl: true })
await frame("Shared runtime 1")
console.log("COMPILED_RUNTIME_SHARED_OK")
