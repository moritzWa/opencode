import { strict as assert } from "node:assert"
import { mkdirSync, readFileSync, realpathSync } from "node:fs"
import { dirname, join } from "node:path"

const host = process.env.OPENCODE_V2_HOST
const root = join(import.meta.dir, "..")
const home = process.env.HOME
mkdirSync(join(home, "workspace"), { recursive: true })
const workspace = realpathSync(join(home, "workspace"))
const { ensurePluginRuntime } = await import(`${host}/packages/plugin/src/runtime.ts`)
ensurePluginRuntime()
const { create } = await import(`${host}/packages/sdk/src/opencode.ts`)
const { toolCallChunk, finishChunk, deltaChunk } = await import(`${host}/packages/ai/test/lib/openai-chunks.ts`)
const { sseEvents } = await import(`${host}/packages/ai/test/lib/sse.ts`)
const contexts = new Map()
const primary = []
const selections = []
let target
let sdk
let indexPath
let fileA
let firstSelectionEmptyParent = false
const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const body = await request.json()
  const sessionID = request.headers.get("x-opencode-session-id")
  const kind = request.headers.get("x-cache-kind")
  if (body.tool_choice?.function?.name === "generate_object") {
    const text = JSON.stringify(body.messages)
    selections.push({ body, sessionID, parent: request.headers.get("x-opencode-parent-session-id") })
    if (selections.length === 1) firstSelectionEmptyParent = (await sdk.session.context({ sessionID: target })).length === 0
    const files = text.includes("CACHE_QUERY_NEW") ? ["cache_b.md"] : ["cache_a.md"]
    return new Response(sseEvents(toolCallChunk("call_selection", "generate_object", JSON.stringify({ selected_memories: files })), finishChunk("tool_calls")), { headers: { "content-type": "text/event-stream" } })
  }
  if (kind === "compaction") return new Response(sseEvents(deltaChunk({ role: "assistant", content: "## Objective\n- Continue the cache fixture.\n## Requirements\n- Memory remains disabled until explicitly resumed.\n## Decisions\n- Use durable context.\n## Work State\n### Completed\n- Earlier fixture steps.\n### Active\n- Policy verification.\n### Blocked\n- (none)\n## Next Move\n1. Continue the fixture.\n## Relevant Files\n- (none)\n## Important Context\n- Honor the current memory policy." }), finishChunk("stop")), { headers: { "content-type": "text/event-stream" } })
  if (sessionID !== target || kind !== "primary") return new Response(sseEvents(deltaChunk({ role: "assistant", content: "bootstrap ready" }), finishChunk("stop")), { headers: { "content-type": "text/event-stream" } })
  const step = primary.length
  primary.push(structuredClone(body))
  if (step === 1) {
    await Bun.write(indexPath, readFileSync(indexPath, "utf8") + "\nEXTERNAL_INDEX_DURING_TOOLS\n")
    await Bun.write(fileA, readFileSync(fileA, "utf8").replace("CACHE_BODY_A", "CACHE_BODY_A_LIVE_UPDATED"))
  }
  const chunks = step < 2
    ? [toolCallChunk(`call_cache_${step}`, "shell", JSON.stringify({ command: "true", workdir: workspace })), finishChunk("tool_calls")]
    : [deltaChunk({ role: "assistant", content: `CACHE_DONE_${step}` }), finishChunk("stop")]
  return new Response(sseEvents(...chunks), { headers: { "content-type": "text/event-stream" } })
} })
const agents = JSON.parse(await Bun.file(join(root, "config-fragment.json")).text()).agents
const options = {
  config: { directory: workspace, project: false, content: JSON.stringify({
    model: "cache-fixture/chat", permissions: [{ action: "*", resource: "*", effect: "allow" }],
    compaction: { auto: false, keep: { tokens: 0 } },
    agents: { ...Object.fromEntries(Object.entries(agents).map(([id, info]) => [id, { ...info, model: "cache-fixture/chat" }])), compaction: { model: "cache-fixture/chat" } },
    providers: { "cache-fixture": { package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: `${provider.url}v1/`, apiKey: "local-fixture-only" }, models: { chat: { capabilities: { tools: true, input: ["text"], output: ["text"], temperature: false }, limit: { context: 200000, output: 8192 } } } } },
    plugins: [{ package: join(root, "server-only"), options: { quiet: true, adrafinil: false, memory: { extract: { enabled: false }, recall: { enabled: true, waitMs: 1500, timeoutMs: 10000 } } } }],
  }) },
  models: { fetch: false }, fs: { filewatcher: false }, database: { path: join(home, "cache-profile.db") },
  plugins: [{ id: "cache-wire-probe", async setup(context) {
    contexts.set(context.location.directory, context)
    await context.session.hook("model.request", (input) => { input.headers["x-cache-kind"] = input.kind })
  } }],
}
const prefix = (before, after) => {
  assert.deepEqual(after.messages.slice(0, before.messages.length), before.messages, "old provider messages/system must remain an exact prefix")
}
const ask = async (text) => {
  const before = primary.length
  await sdk.session.prompt({ sessionID: target, text })
  await sdk.session.wait({ sessionID: target }, { signal: AbortSignal.timeout(30000) })
  assert(primary.length > before)
  return primary.at(-1)
}
try {
  sdk = await create(options)
  const bootstrap = await sdk.session.create({ title: "Cache scope bootstrap", location: { directory: workspace } })
  await sdk.session.generate({ sessionID: bootstrap.id, prompt: "Initialize plugin scope only" })
  const context = contexts.get(workspace)
  const save = (await context.tool.list()).find((tool) => tool.id === "memory_save")
  const seed = async (file, content) => {
    const result = await save.execute({ file_name: file, name: file === "cache_a" ? "Cache A" : "Cache B", description: "cache fixture guidance", type: "reference", content }, { sessionID: bootstrap.id, agent: "build", id: "call_seed", messageID: "msg_seed", signal: new AbortController().signal, progress: async () => {} })
    const text = typeof result.content === "string" ? result.content : result.content.map((part) => part.text ?? "").join("\n")
    return /Memory saved to ([^\n]+)/.exec(text)[1]
  }
  fileA = await seed("cache_a", "CACHE_BODY_A")
  await seed("cache_b", "CACHE_BODY_B")
  indexPath = join(dirname(fileA), "MEMORY.md")
  target = (await sdk.session.create({ title: "Genuine empty-parent memory cache proof", location: { directory: workspace } })).id
  assert.deepEqual(await sdk.session.context({ sessionID: target }), [])
  await ask("CACHE_QUERY_ONE What should I know about this fixture workflow?")
  assert(firstSelectionEmptyParent, "first-user recall must work before any parent message is projected")
  assert.equal(selections[0].parent, target)
  assert(JSON.stringify(selections[0].body.messages).includes("CACHE_QUERY_ONE"))
  assert.equal(primary.length, 3)
  assert(JSON.stringify(primary[0].messages).includes("CACHE_BODY_A"), "first actual provider request must contain selected memory")
  prefix(primary[0], primary[1])
  prefix(primary[1], primary[2])
  assert(JSON.stringify(primary[2].messages).includes("EXTERNAL_INDEX_DURING_TOOLS"))
  assert(JSON.stringify(primary[2].messages).includes("CACHE_BODY_A_LIVE_UPDATED"), "selected content updates must be delivered after consumption without rebuilding the prefix")
  const firstSystem = structuredClone(primary[0].messages[0])
  const next = await ask("CACHE_QUERY_NEW Use the other fixture guidance for the next task.")
  prefix(primary[2], next)
  assert.deepEqual(next.messages[0], firstSystem)
  assert(JSON.stringify(next.messages).includes("CACHE_BODY_B"))
  await Bun.write(indexPath, readFileSync(indexPath, "utf8") + "\nEXTERNAL_INDEX_NEW_USER\n")
  const edited = await ask("CACHE_QUERY_OTHER Continue this task with the current shared index.")
  prefix(next, edited)
  assert.deepEqual(edited.messages[0], firstSystem)
  assert(JSON.stringify(edited.messages).includes("EXTERNAL_INDEX_NEW_USER"))
  const selectedBeforeIgnore = selections.length
  const ignored = await ask("ignore memory CACHE_IGNORE and do not use any remembered facts")
  prefix(edited, ignored)
  assert.deepEqual(ignored.messages[0], firstSystem)
  const disabled = await context.session.instructions.entry.list({ sessionID: target })
  assert(!disabled.some((entry) => ["memory.index", "memory.recalled"].includes(entry.key)))
  assert(disabled.find((entry) => entry.key === "memory.mode").value.includes("Memory is disabled"))
  await ask("CACHE_STILL_IGNORED Continue the task without another selection.")
  assert.equal(selections.length, selectedBeforeIgnore)
  await sdk.session.compact({ sessionID: target })
  await sdk.session.wait({ sessionID: target }, { signal: AbortSignal.timeout(30000) })
  const compactedHistory = await sdk.session.context({ sessionID: target })
  if (!compactedHistory.some((message) => message.type === "compaction" && message.status === "completed")) console.error(JSON.stringify(compactedHistory, null, 2))
  assert(compactedHistory.some((message) => message.type === "compaction" && message.status === "completed"))
  const compacted = await ask("CACHE_AFTER_COMPACTION Keep the current memory policy.")
  assert(!JSON.stringify(compacted.messages[0]).includes("CACHE_BODY_A"))
  assert(!JSON.stringify(compacted.messages[0]).includes("CACHE_BODY_B"))
  assert(JSON.stringify(compacted.messages[0]).includes("Memory is disabled"))
  assert.equal(selections.length, selectedBeforeIgnore)
  await sdk.close()
  sdk = await create(options)
  const restarted = await ask("CACHE_AFTER_RESTART Continue under the existing memory policy.")
  prefix(compacted, restarted)
  assert.equal(selections.length, selectedBeforeIgnore, "ignore state must survive compaction plus process-local coordinator loss")
  await Bun.write(fileA, readFileSync(fileA, "utf8").replace("CACHE_BODY_A_LIVE_UPDATED", "CACHE_BODY_A_UPDATED"))
  await Bun.write(indexPath, readFileSync(indexPath, "utf8") + "\nINDEX_WHILE_IGNORED\n")
  const resumed = await ask("resume memory CACHE_RESUME and use the latest shared guidance")
  prefix(restarted, resumed)
  assert.deepEqual(resumed.messages[0], compacted.messages[0])
  assert(JSON.stringify(resumed.messages).includes("CACHE_BODY_A_UPDATED"))
  assert(JSON.stringify(resumed.messages).includes("INDEX_WHILE_IGNORED"))
  assert.equal(selections.length, selectedBeforeIgnore + 1)
  console.log("DURABLE_MEMORY_CACHE_OK")
} finally {
  await sdk?.close()
  await provider.stop(true)
}
