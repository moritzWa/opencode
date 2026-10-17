import assert from "node:assert/strict"
import { CodeRenderable, type Renderable } from "@opentui/core"
import { createAppFixture } from "./app"
import { directory, json } from "./tui-client"
import { waitForHighlightedFrame } from "./frame"

const plain = "https://example.com/catalog/long-wrapped-path/reference?part=1234"
const labeled = "https://example.com/labeled"
const plugin = process.env.OPENCODE_LINK_QA_PARITY_TUI
const record = process.env.OPENCODE_LINK_QA_RECORD ?? assert.fail("recording opener path is required")
const session = {
  id: "ses_links",
  title: "Link QA",
  projectID: "project",
  location: { directory },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 0, updated: 0 },
}
const message = {
  id: "msg_links",
  type: "assistant",
  agent: "build",
  model: { providerID: "provider", id: "model" },
  content: [{ type: "text", text: `Plain ${plain}\n\nRead [documentation](${labeled}) here.` }],
  finish: "stop",
  time: { created: 1, completed: 2 },
}

await using setup = await createAppFixture({
  width: Number(process.env.OPENCODE_LINK_QA_WIDTH ?? 80),
  height: 28,
  args: { sessionID: session.id },
  config: {
    animations: false,
    terminal: { copy: "manual" },
    tabs: { mode: "off" },
    session: { sidebar: "hide" },
    plugins: plugin ? [plugin] : [],
  },
  fetch: (url) => {
    if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
    if (url.pathname === `/api/session/${session.id}/message`) return json({ data: [message], cursor: {} })
    if (url.pathname === `/api/session/${session.id}/inbox`) return json({ data: [] })
    return undefined
  },
})
await setup.ready
await waitForHighlightedFrame(
  setup,
  (frame) => frame.includes("documentation") && frame.replace(/\s/g, "").includes(plain),
)
if (plugin) {
  // Title installs after clickable-links in the real parity setup. Waiting for
  // it prevents native clicks from racing asynchronous plugin activation.
  await setup.waitForFrame((frame) => frame.includes(session.title))
}

function cell(text: string) {
  const rows = setup.captureCharFrame().split("\n")
  const y = rows.findIndex((row) => row.includes(text))
  assert.ok(y >= 0, `missing visible text ${text}:\n${setup.captureCharFrame()}`)
  return { x: rows[y].indexOf(text), y }
}
async function entries() {
  if (!(await Bun.file(record).exists())) return [] as Array<{ scenario?: string; args: string[] }>
  return (await Bun.file(record).text())
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { scenario?: string; args: string[] })
}
async function opened(count: number) {
  const deadline = Date.now() + 2_000
  while ((await entries()).length < count) {
    assert.ok(Date.now() < deadline, `timed out waiting for opener ${count}; frame:\n${setup.captureCharFrame()}`)
    await Bun.sleep(10)
  }
  // The executable records both independent handlers. Leave time for a second
  // asynchronously spawned opener to arrive before asserting exact ownership.
  await Bun.sleep(100)
  assert.equal((await entries()).length, count, "one opener per gesture")
}
async function click(scenario: string, text: string, count: number, offset = 0) {
  setup.renderer.clearSelection()
  process.env.OPENCODE_LINK_QA_SCENARIO = scenario
  const at = cell(text)
  if (scenario.startsWith("fallback-"))
    assert.equal(setup.renderer.getLinkAt(at.x + offset, at.y), null, `${scenario} must exercise the raw fallback`)
  else assert.equal(setup.renderer.getLinkAt(at.x + offset, at.y), text === "documentation" ? labeled : plain)
  await setup.mockMouse.click(at.x + offset, at.y)
  await opened(count)
}

const at = cell("https://")
assert.equal(setup.renderer.getLinkAt(at.x, at.y), plain)
await click("native-plain", "https://", 1)
// SGR/OpenTUI has shift, alt, ctrl only. A forwarded Cmd click has the same
// unmodified packet as plain click; OS/terminal Cmd interception is outside App.
await click("native-cmd-forwarded", "1234", 2)
await click("native-labeled", "documentation", 3)

async function guards(prefix: string) {
  const at = cell("https://")
  setup.renderer.clearSelection()
  process.env.OPENCODE_LINK_QA_SCENARIO = `${prefix}-option`
  await setup.mockMouse.click(at.x, at.y, 0, { modifiers: { alt: true } })
  setup.renderer.clearSelection()
  process.env.OPENCODE_LINK_QA_SCENARIO = `${prefix}-drag`
  await setup.mockMouse.drag(at.x, at.y, at.x + 10, at.y)
  assert.ok(setup.renderer.getSelection()?.getSelectedText(), "drag must retain a selection")
  // Word-selection release must not be mistaken for the first cell click.
  setup.renderer.clearSelection()
  const label = cell("documentation")
  process.env.OPENCODE_LINK_QA_SCENARIO = `${prefix}-selection-prime`
  const before = (await entries()).length
  await setup.mockMouse.click(label.x, label.y)
  process.env.OPENCODE_LINK_QA_SCENARIO = `${prefix}-selection`
  await setup.mockMouse.click(label.x, label.y)
  assert.ok(setup.renderer.getSelection()?.getSelectedText(), "second click must select a word")
  await opened(before + 1)
}
await guards("native")
await opened(4)

if (plugin) {
  const source = setup.renderer.root.findDescendantById(`message:${message.id}:part:0`)
  assert.ok(source, "real source identity wrapper")
  const codes = (node: Renderable): CodeRenderable[] => [
    ...(node instanceof CodeRenderable ? [node] : []),
    ...node.getChildren().flatMap((child) => codes(child as Renderable)),
  ]
  const nodes = codes(source)
  assert.ok(nodes.length > 0, "real Markdown CodeRenderable children")
  // Read-aloud rebuilds styled chunks, which can drop native link metadata.
  // Exercise that state through the real public chunk transform, without
  // replacing App, clickable-links, the hit grid, or mouse propagation.
  nodes.forEach((node) => {
    node.onChunks = (chunks) => chunks.map((chunk) => ({ ...chunk, link: undefined }))
  })
  await setup.renderOnce()
  await Promise.all(nodes.map((node) => node.highlightingDone))
  await setup.renderOnce()
  const stripped = cell("https://")
  assert.equal(
    setup.renderer.getLinkAt(stripped.x, stripped.y),
    null,
    "speech-style rewrite must remove native link attrs",
  )
  await click("fallback-plain", "https://", 5)
  await click("fallback-wrapped-tail", "1234", 6)
  await click("fallback-labeled", "documentation", 7)
  await click("fallback-labeled-tail", "documentation", 8, "documentation".length - 1)
  await guards("fallback")
  await opened(9)
}

await setup.renderOnce()
await Bun.sleep(100)
const recorded = await entries()
// Scoped Bun.spawn captures the plugin environment at setup. Runtime scenario
// labels therefore do not propagate to its children; exact ordered URLs and
// per-gesture counts cover both real opener paths without depending on them.
assert.deepEqual(
  recorded.map((entry) => entry.args.at(-1)),
  [plain, plain, labeled, labeled, ...(plugin ? [plain, plain, labeled, labeled, labeled] : [])],
)
console.log(
  `LINK_QA_RESULT ${JSON.stringify({ native: 3, fallback: plugin ? 4 : 0, guarded: 0, opened: recorded.length })}`,
)
