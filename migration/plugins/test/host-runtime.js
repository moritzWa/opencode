// Run in a fresh process through the *actual V2* source loader and runtime
// redirection, not a bundled 0.4 renderer. The caller isolates HOME/XDG.
import { strict as assert } from "node:assert"
import { dirname, join } from "node:path"
const host = process.env.OPENCODE_V2_HOST
if (!host) throw new Error("Set OPENCODE_V2_HOST to the candidate development checkout")
const corePath = Bun.resolveSync("@opentui/core", `${host}/packages/tui`)
const hostCore = await import(corePath)
await import(`${host}/packages/tui/src/plugin/runtime-plugin-support.bun.ts`)
await import(`${host}/packages/tui/node_modules/@opentui/solid/scripts/preload.js`)
const { createPluginSources } = await import(`${host}/packages/plugin/src/source.ts`)
const { createTestRenderer } = await import(Bun.resolveSync("@opentui/core/testing", `${host}/packages/tui`))
const { CodeRenderable, MarkdownRenderable, RGBA } = hostCore
const { createStorage } = await import(`${host}/packages/tui/src/context/storage.tsx`)
const sources = createPluginSources(async () => {})
const probe = await sources.read(new URL("./runtime-probe.js", import.meta.url).href)
const { createRoot } = probe.module
const entry = process.argv[2]
const { Host } = await import(`${host}/packages/plugin/src/host.ts`)
const packageName = entry.includes("opencode-read-aloud") ? "opencode-read-aloud" : "@moritz/opencode-parity-plugins"
const targets = Host.resolve({ directory: dirname(entry), name: packageName })
assert(targets.tui, `native V2 package discovery must resolve ${packageName}/tui`)
assert(Host.resolve({ directory: dirname(entry) }).tui, "local directory discovery must also resolve a conventional tui entrypoint")
if (packageName === "@moritz/opencode-parity-plugins") {
  const npmServerOnly = Host.resolve({ directory: dirname(entry), name: "@moritz/opencode-parity-plugins/server-only" })
  assert(npmServerOnly.server)
  assert.equal(npmServerOnly.tui, undefined)
  const serverOnly = Host.resolve({ directory: `${dirname(entry)}/server-only` })
  assert(serverOnly.server)
  assert.equal(serverOnly.tui, undefined)
  const uiOnly = Host.resolve({ directory: `${dirname(entry)}/ui-only` })
  assert(uiOnly.tui)
  assert.equal(uiOnly.server, undefined)
}
const loaded = await sources.read(targets.tui)
const plugin = loaded.module.default
assert.equal(typeof plugin.setup, "function")
assert.equal(probe.module.CodeRenderable, CodeRenderable, "plugin and host must share OpenTUI constructors")
const storageRoot = join(process.env.HOME, "native-storage")
const nativeStorage = createStorage(storageRoot, "migration-fixture")
await Bun.write(join(process.env.XDG_STATE_HOME, "opencode/kv.json"), JSON.stringify({ speech_speed: 1.9, unrelated: "not migrated" }))
const layers = []
const claims = []
const fixture = await createTestRenderer({ width: 100, height: 20, remote: true, useThread: false })
assert(fixture.renderer instanceof hostCore.CliRenderer, "fixture renderer must use host OpenTUI instance")
const color = RGBA.fromHex("#ffffff")
const action = { primary: { base: color } }
const feedback = { success: { base: color }, error: { base: color } }
const context = {
  options: { placement: "footer", speechify: { voice: "dominic", model: "simba-3.0" } },
  renderer: fixture.renderer, location: { directory: process.env.HOME },
  storage: nativeStorage.storage,
  theme: { background: { base: color, raised: { base: color } }, text: { base: color, muted: color, action, feedback } },
  data: {
    listen: () => () => {},
    session: { list: () => [], message: { list: () => [], get: () => undefined }, get: () => ({ title: "V2 fixture title", location: { directory: process.env.HOME } }) },
    location: { default: () => ({ directory: process.env.HOME }) },
  },
  keymap: { layer: (factory) => layers.push(factory()), commands: () => [], mode: { current: () => "base" }, dispatch: () => {} },
  ui: {
    router: { current: () => ({ type: "session", sessionID: "ses_fixture" }) },
    slot: (claim) => { claims.push(claim); return () => {} },
    toast: { show: () => {} },
  },
  client: { command: { list: async () => [] } },
}
let owner
const cleanup = await new Promise((resolve, reject) => createRoot((dispose) => {
  owner = dispose
  Promise.resolve(plugin.setup(context)).then(resolve, reject)
}))
try {
  assert(claims.length > 0)
  assert(layers.length > 0)
  const keys = layers.flatMap((layer) => layer.commands)
  if (plugin.id === "opencode-read-aloud") {
    assert(keys.some((command) => command.id === "speech.toggle" && command.bind === "ctrl+s"))
    assert(claims.some((claim) => claim.append === "prompt.footer"))
    await nativeStorage.storage.flush()
    const [saved, update] = nativeStorage.storage.store("v1-options", { initial: {} })
    assert.equal(saved.speech_speed, 1.9, "copied V1 speed must seed native persistent plugin storage")
    assert.equal(saved.unrelated, undefined)
    await update((draft) => { draft.speech_speed = 2.2 })
    const reopened = createStorage(storageRoot, "migration-fixture")
    try {
      const { adapt } = await import(join(dirname(entry), "v2-compat.js"))
      const bridge = adapt({ ...context, storage: reopened.storage })
      assert.equal(bridge.api.kv.get("speech_speed", 1.7), 2.2, "persisted V2 value must win over legacy seed after reopening")
      await bridge.dispose()
    } finally {
      await reopened.storage.flush()
      reopened.close()
    }
  }
  if (plugin.id === "moritz-parity-tui") {
    const { BoxRenderable, TextRenderable, ScrollBoxRenderable } = hostCore
    const transcript = new ScrollBoxRenderable(fixture.renderer, { id: "session:ses_fixture:transcript", height: 20, stickyScroll: true, stickyStart: "bottom" })
    // Native path headers are nested boxes, unlike the old flat title node.
    const block = new BoxRenderable(fixture.renderer, { flexDirection: "column", gap: 1 })
    const heading = new BoxRenderable(fixture.renderer, { flexDirection: "row", gap: 1 })
    heading.add(new TextRenderable(fixture.renderer, { content: "← Edit" }))
    heading.add(new TextRenderable(fixture.renderer, { content: "fixture.ts" }))
    block.add(heading)
    const body = new BoxRenderable(fixture.renderer, { flexDirection: "column" })
    body.add(new CodeRenderable(fixture.renderer, { content: "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight", filetype: "text" }))
    block.add(body)
    block.add(new TextRenderable(fixture.renderer, { content: "fixture diagnostic remains visible" }))
    transcript.add(block)
    fixture.renderer.root.add(transcript)
    const deadline = Date.now() + 5000
    while (!fixture.captureCharFrame().includes("8 lines") && Date.now() < deadline) { await Bun.sleep(20); await fixture.renderOnce() }
    await fixture.renderOnce()
    const frame = fixture.captureCharFrame()
    assert(frame.includes("8 lines"), `fold stats missing in native nested header: ${frame}`)
    assert(frame.includes("diagnostic remains visible"))
    assert(!frame.includes("seven"))
    keys.find((command) => command.id === "fold_diffs.toggle").run()
    await fixture.renderOnce()
    assert(fixture.captureCharFrame().includes("seven"), "native fold command must restore body")
  }
  // Load view through the same runtime resolver and prove its markdown class
  // is the host class, including the real per-word onHighlight callback.
  const viewPath = entry.endsWith("v2.js") ? entry.replace(/v2\.js$/, "view.ts") : undefined
  if (viewPath) {
    const { blocks, show, clear, tint, pick } = await import(viewPath)
    const wrapper = new hostCore.BoxRenderable(fixture.renderer, { id: "message:msg_native:part:1" })
    const markdown = new MarkdownRenderable(fixture.renderer, { content: "Read these words.", internalBlockMode: "top-level", syntaxStyle: hostCore.SyntaxStyle.create() })
    wrapper.add(markdown)
    fixture.renderer.root.add(wrapper)
    await fixture.renderOnce()
    const deadline = Date.now() + 5000
    while (!blocks(markdown)?.length && Date.now() < deadline) { await Bun.sleep(10); await fixture.renderOnce() }
    const block = blocks(markdown)[0]
    assert(block instanceof CodeRenderable)
    const speechColors = { background: RGBA.fromHex("#0a0a0a"), primary: RGBA.fromHex("#fab283") }
    const wordColor = tint(speechColors.background, speechColors.primary, 0.4)
    const painted = () => fixture.captureSpans().lines.flatMap((line) => line.spans).filter((span) => {
      const [r, g, b] = span.bg.buffer
      return Math.abs(r - wordColor.r * 255) < 2 && Math.abs(g - wordColor.g * 255) < 2 && Math.abs(b - wordColor.b * 255) < 2
    }).map((span) => span.text).join("").trim()
    show(block, { start: 0, end: 17 }, { start: 5, end: 10 }, speechColors)
    assert.equal(typeof block.onHighlight, "function")
    const paintedDeadline = Date.now() + 5000
    while (painted() !== "these" && Date.now() < paintedDeadline) { await Bun.sleep(10); await fixture.renderOnce() }
    assert.equal(painted(), "these", "native V2 renderer must paint only the spoken word with its word highlight")
    const spot = pick(markdown, "1", "msg_native", { target: block, x: block.x + 5, y: block.y, modifiers: { alt: true }, stopPropagation() {} })
    assert.equal(spot.partID, "1")
    assert.equal(spot.messageID, "msg_native")
    assert.equal(block.content.slice(spot.offset, spot.offset + 5), "these")
    const { adapt } = await import(join(dirname(entry), "v2-compat.js"))
    const bridge = adapt(context)
    assert.deepEqual(bridge.api.renderedOwner(markdown), { messageID: "msg_native", partID: "1" })
    await bridge.dispose()
    clear()
  }
} finally {
  await cleanup?.()
  owner()
  fixture.renderer.destroy()
  await nativeStorage.storage.flush()
  nativeStorage.close()
  sources.dispose()
}
console.log(`V2_HOST_LOADER_OK ${plugin.id}`)
