// Compile read-only V1 inputs into portable, frozen modules. Source maps retain
// the exact original source so the packed artifact is independently auditable.
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { buildAgentDefaults } from "./node_modules/opencode-claude-memory/dist/agents.js"

const config = process.env.PARITY_SOURCE_CONFIG ?? join(homedir(), ".config/opencode")
const manifest = []
for (const [kind, names] of Object.entries({
  plugins: ["adrafinil.ts", "background-shell.js", "claude-hooks.js", "monitor.js", "spawned-sessions.js", "worktree.js"],
  "tui-plugins": ["backslash-newline.js", "clickable-links.js", "fold-diffs.js", "pr-footer.js", "session-title.js"],
})) {
  for (const name of names) manifest.push({ source: `${kind}/${name}`, sha256: new Bun.CryptoHasher("sha256").update(await Bun.file(join(config, kind, name)).arrayBuffer()).digest("hex") })
  const result = await Bun.build({
    entrypoints: names.map((name) => join(config, kind, name)),
    outdir: join(import.meta.dir, "legacy", kind),
    naming: "[name].js",
    target: "bun",
    format: "esm",
    sourcemap: "external",
    packages: "external",
    plugins: [{ name: "v2-fold-render-tree", setup(build) {
      build.onLoad({ filter: /fold-diffs\.js$/ }, async (args) => ({
        loader: "js",
        contents: ('import { TextRenderable } from "@opentui/core"\n' + await Bun.file(args.path).text())
          .replace('return typeof value === "string" ? value : undefined', 'return typeof value === "string" ? value : children(node).map(plain).filter(Boolean).join(" ") || undefined')
          .replace('node.stickyScroll === true &&\n    node.stickyStart === "bottom"', '((typeof node.id === "string" && /^session:.*:transcript$/.test(node.id)) || (node.stickyScroll === true && node.stickyStart === "bottom"))')
          .replace('const known = new WeakMap()', 'const known = new WeakMap()\n    const owned = new Set()')
          .replace('      const head = kids[0]\n      const state', '      const head = kids[0]\n      const titleNode = typeof head.plainText === "string" ? head : new TextRenderable(api.renderer, { content: "", fg: api.theme.current.textMuted })\n      if (titleNode !== head) head.add(titleNode)\n      const state')
          .replace('title: plain(head) === title ? { node: head, text: title } : undefined,', 'title: { node: titleNode, text: titleNode === head ? title : "" },\n        inserted: titleNode !== head,')
          .replaceAll('known.set(block, state)', 'known.set(block, state)\n      owned.add(state)')
          .replace('    function sweep() {', '    function sweep() {\n      for (const state of owned) if (state.block.isDestroyed) owned.delete(state)')
          .replace('      clearInterval(timer)', '      for (const state of owned) {\n        if (state.block.isDestroyed) continue\n        apply(state, false)\n        if (state.inserted) state.title.node.destroy()\n        if (state.inner) state.body[0].onMouseUp = undefined\n        else state.block.onMouseUp = undefined\n      }\n      owned.clear()\n      clearInterval(timer)'),
      }))
      build.onLoad({ filter: /background-shell\.js$/ }, async (args) => ({
        loader: "js",
        contents: (await Bun.file(args.path).text())
          .replace('  let timer\n', '  let timer\n  let disposed = false\n  const settleTimers = new Set()\n')
          .replace('    polls++', '    if (disposed) return\n    polls++')
          .replace('          owner: process.pid,', '          owner: process.pid,\n          released: shell.released === true,')
          .replace('hold.owner === process.pid || alive(hold.owner)', '(!hold.released && (hold.owner === process.pid || alive(hold.owner)))')
          .replace('      clearInterval(timer)', '      disposed = true\n      for (const pending of settleTimers) clearTimeout(pending)\n      settleTimers.clear()\n      for (const shell of watched.values()) { shell.released = true; save(shell) }\n      clearInterval(timer)')
          .replace('      setTimeout(() => void sweep(began, input.sessionID), SETTLE_MS)', '      const pending = setTimeout(() => { settleTimers.delete(pending); if (!disposed) void sweep(began, input.sessionID) }, SETTLE_MS)\n      settleTimers.add(pending)'),
      }))
      build.onLoad({ filter: /clickable-links\.js$/ }, async (args) => ({
        loader: "js",
        contents: (await Bun.file(args.path).text())
          .replace('function linkAt(renderer, event) {', 'function linkAt(renderer, event) {\n  // V2 App owns native cell links. Only recover links whose speech highlights removed the attributes.\n  if (renderer.getLinkAt?.(event.x, event.y)) return')
          // Concealed Markdown's first visible label cell maps to the opening
          // bracket in the raw source, not to the character after it.
          .replace('(label < 0 ? match.index : label + 1)', '(label < 0 ? match.index : label)'),
      }))
    } }],
  })
  if (!result.success) throw new AggregateError(result.logs, `Could not freeze ${kind}`)
}

const defaults = buildAgentDefaults({ recall: "opencode-memory-recall", extract: "opencode-memory-extract", dream: "opencode-memory-dream" })
const memoryEntry = Bun.resolveSync("opencode-claude-memory", import.meta.dir)
const memoryBuild = await Bun.build({
  entrypoints: [memoryEntry], outdir: join(import.meta.dir, "legacy"), naming: "memory.js", target: "bun", format: "esm", sourcemap: "external",
  external: ["@opencode-ai/plugin", "@opencode-ai/plugin/tool"],
  plugins: [{ name: "memory-domain-access", setup(build) {
    build.onLoad({ filter: /opencode-claude-memory[/\\]dist[/\\]index\.js$/ }, async (args) => {
      const source = await Bun.file(args.path).text()
      const contents = source.replace('    return {\n        config:', '    return {\n        memory: { store, recall, config, owned },\n        config:')
      if (source === contents) throw new Error("Pinned memory assembly changed; cannot expose its observed domain safely")
      return { loader: "js", contents: contents + '\nexport { buildMemorySystemPrompt, formatRecalledMemories };\nexport { recallSelectedMemories } from "./recall/format.js";\n' }
    })
  } }],
})
if (!memoryBuild.success) throw new AggregateError(memoryBuild.logs, "Could not compile pinned memory domain")
manifest.push({ source: "npm:opencode-claude-memory@2.0.2/dist/index.js", sha256: new Bun.CryptoHasher("sha256").update(await Bun.file(memoryEntry).arrayBuffer()).digest("hex") })
await Bun.write(join(import.meta.dir, "legacy", "memory.LICENSE"), await Bun.file(join(dirname(dirname(memoryEntry)), "LICENSE")).text())
const zod = dirname(Bun.resolveSync("zod/package.json", dirname(memoryEntry)))
await Bun.write(join(import.meta.dir, "legacy", "memory-zod.LICENSE"), await Bun.file(join(zod, "LICENSE")).text())
await Bun.write(join(import.meta.dir, "legacy", "manifest.json"), JSON.stringify(manifest, null, 2) + "\n")
await Bun.write(join(import.meta.dir, "config-fragment.json"), JSON.stringify({
  plugins: [{ package: "./migration/plugins/server-only", options: { memory: { autodream: { enabled: false } } } }],
  agents: Object.fromEntries(Object.entries(defaults).map(([name, agent]) => [name, {
    mode: agent.mode, hidden: agent.hidden, system: agent.prompt,
    ...(agent.steps ? { steps: agent.steps } : {}),
    ...(name === "opencode-memory-recall" ? { model: "openai/gpt-6-luna" } : name === "opencode-memory-extract" ? { model: "anthropic/claude-sonnet-5-5" } : {}),
    permissions: Object.entries(agent.tools).map(([action, enabled]) => ({ action, resource: "*", effect: enabled ? "allow" : "deny" })),
  }])),
}, null, 2) + "\n")
await Bun.write(join(import.meta.dir, "tui-fragment.json"), JSON.stringify({ plugins: [
  { package: "./migration/plugins/node_modules/opencode-read-aloud", options: { placement: "footer", speechify: { voice: "dominic", model: "simba-3.0" } } },
  "./migration/plugins/ui-only",
] }, null, 2) + "\n")
