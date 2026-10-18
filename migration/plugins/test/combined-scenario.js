import { strict as assert } from "node:assert"
import { mkdirSync, readFileSync, existsSync, realpathSync, readdirSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { join } from "node:path"

const host = process.env.OPENCODE_V2_HOST
const root = join(import.meta.dir, "..")
const home = process.env.HOME
mkdirSync(join(home, "workspace"), { recursive: true })
const workspace = realpathSync(join(home, "workspace"))
const watchOnce = join(workspace, "watch-once.txt")
const backgroundOnce = join(workspace, "background-once.txt")
const backgroundLog = join(workspace, "background.log")
const backgroundBody = `printf 'BG_ONCE\\n' >> "${backgroundOnce}"; sleep 8; printf 'BG_FINISHED\\n'`
mkdirSync(join(home, ".claude/hooks"), { recursive: true })
const realEmailHook = join(home, ".claude/hooks/gmail-html-only.py")
await Bun.write(realEmailHook, await Bun.file(process.env.PARITY_EMAIL_HOOK_SOURCE).text())
const auditHook = join(home, ".claude/hooks/audit.py")
await Bun.write(auditHook, [
  "import json,os,sys",
  "p=json.load(sys.stdin)",
  "p['hook_session_env']=os.environ.get('CLAUDE_CODE_SESSION_ID')",
  "with open(os.path.join(os.environ['HOME'],'combined-hooks.jsonl'),'a') as f: f.write(json.dumps(p)+'\\n')",
].join("\n"))
await Bun.write(join(home, ".claude/settings.json"), JSON.stringify({ hooks: {
  PreToolUse: [{ matcher: "Bash|mcp__gmail-arca__send_email", hooks: [
    { type: "command", command: `python3 "${auditHook}"` },
    { type: "command", command: `python3 "${realEmailHook}"` },
  ] }],
  PostToolUse: [{ matcher: "Edit|Write", hooks: [{ type: "command", command: `python3 "${auditHook}"` }] }],
} }))

const sendCalls = []
const mcp = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } })
  const rpc = await request.json()
  if (!Object.hasOwn(rpc, "id")) return new Response(null, { status: 202 })
  const result = (() => {
    if (rpc.method === "initialize") return { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "token-free-gmail-fixture", version: "1" } }
    if (rpc.method === "tools/list") return { tools: [{ name: "send_email", description: "LOCAL FIXTURE ONLY", inputSchema: { type: "object", properties: {
      to: { type: "array", items: { type: "string" } }, subject: { type: "string" }, body: { type: "string" }, htmlBody: { type: "string" }, mimeType: { type: "string" },
    }, required: ["to", "subject", "body"] } }] }
    if (rpc.method === "tools/call") { sendCalls.push(rpc.params); return { content: [{ type: "text", text: "LOCAL_FIXTURE_ACCEPTED" }] } }
    if (rpc.method === "prompts/list") return { prompts: [] }
    if (rpc.method === "resources/list") return { resources: [] }
    return {}
  })()
  return Response.json({ jsonrpc: "2.0", id: rpc.id, result })
} })
const { toolCallChunk, finishChunk, deltaChunk } = await import(`${host}/packages/ai/test/lib/openai-chunks.ts`)
const { sseEvents } = await import(`${host}/packages/ai/test/lib/sse.ts`)
const payloads = [
  { to: ["fixture@example.test"], subject: "missing-html", body: "fixture", mimeType: "multipart/alternative" },
  { to: ["fixture@example.test"], subject: "invalid-mime", body: "fixture", htmlBody: "<p>fixture</p>", mimeType: "text/plain" },
  { to: ["fixture@example.test"], subject: "valid-fixture", body: "fixture", htmlBody: "<p>fixture</p>", mimeType: "multipart/alternative" },
]
const modelRequests = []
const structuredRequests = []
const logs = []
const contexts = new Map()
const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const body = await request.json()
  if (JSON.stringify(body.messages).includes("INITIALIZE_PLUGIN_FIXTURE")) return new Response(sseEvents(deltaChunk({ role: "assistant", content: "initialized" }), finishChunk("stop")), { headers: { "content-type": "text/event-stream" } })
  if (body.tool_choice?.function?.name === "generate_object") {
    structuredRequests.push(body)
    return new Response(sseEvents(toolCallChunk("call_native_object", "generate_object", JSON.stringify({ selected_memories: ["sandbox_fixture.md"] })), finishChunk("tool_calls")), { headers: { "content-type": "text/event-stream" } })
  }
  const stage = modelRequests.length
  modelRequests.push({ body, sendCount: sendCalls.length, path: new URL(request.url).pathname })
  const chunks = stage < 3
    ? [toolCallChunk(`call_execute_${stage}`, "execute", JSON.stringify({ code: `return await tools["gmail-arca"].send_email(${JSON.stringify(payloads[stage])});` })), finishChunk("tool_calls")]
    : stage === 3
      ? [toolCallChunk("call_native_shell", "shell", JSON.stringify({ command: `python3 -c 'import os; s=os.environ["CLAUDE_CODE_SESSION_ID"]; open("shell-env.txt","w").write(s); print(s)'`, workdir: workspace })), toolCallChunk("call_native_write", "write", JSON.stringify({ path: join(workspace, "native-output.txt"), content: "native write accepted" }), 1), finishChunk("tool_calls")]
      : stage === 5
        ? [toolCallChunk("call_memory_save", "memory_save", JSON.stringify({ file_name: "sandbox_fixture", name: "Sandbox fixture", description: "real native extraction sandbox", type: "reference", content: "NATIVE_MEMORY_SANDBOX_SAVED" })), finishChunk("tool_calls")]
        : stage === 7
          ? [toolCallChunk("call_live_monitor", "monitor", JSON.stringify({ command: `printf 'WATCH_ONCE\\n' >> "${watchOnce}"; sleep 60`, description: "SDK reopen monitor", timeout_ms: 60000 })), toolCallChunk("call_live_background", "shell", JSON.stringify({ command: `nohup /bin/sh -c ${JSON.stringify(backgroundBody)} > "${backgroundLog}" 2>&1 & bg=$!; printf '__CURSOR_BACKGROUND_SHELL__%s:%s\\n' "$bg" "${backgroundLog}"`, workdir: workspace }), 1), finishChunk("tool_calls")]
          : [deltaChunk({ role: "assistant", content: stage === 8 ? "LIFECYCLE_ARMED" : stage > 8 ? "RECOVERY_READY" : stage > 5 ? "MEMORY_SANDBOX_READY" : "COMBINED_READY" }), finishChunk("stop")]
  return new Response(sseEvents(...chunks), { headers: { "content-type": "text/event-stream" } })
} })

let sdk
try {
  const { ensurePluginRuntime } = await import(`${host}/packages/plugin/src/runtime.ts`)
  ensurePluginRuntime()
  const { create } = await import(`${host}/packages/sdk/src/opencode.ts`)
  const memoryAgents = JSON.parse(await Bun.file(join(root, "config-fragment.json")).text()).agents
  const options = {
    config: { directory: workspace, project: false, content: JSON.stringify({
      model: "local-fixture/fixture-chat",
      agents: Object.fromEntries(Object.entries(memoryAgents).map(([id, agent]) => [id, { ...agent, model: "local-fixture/fixture-chat" }])),
      permissions: [{ action: "*", resource: "*", effect: "allow" }],
      providers: {
        "local-fixture": {
          package: "@opencode/ai/providers/openai-compatible",
          settings: { baseURL: `${provider.url}v1/`, apiKey: "fixture-only-no-real-token" },
          models: { "fixture-chat": { capabilities: { tools: true, input: ["text"], output: ["text"], temperature: true }, limit: { context: 200000, output: 8192 } } },
        },
      },
      mcp: { servers: { "gmail-arca": { type: "remote", url: String(mcp.url), oauth: false, codemode: true } } },
      plugins: [{ package: join(root, "server-only"), options: { quiet: true, adrafinil: false, memory: { recall: { enabled: false }, extract: { enabled: false } } } }],
    }) },
    models: { fetch: false }, fs: { filewatcher: false }, log: { level: "error", emit: (entry) => logs.push(entry) },
    database: { path: join(home, "profile.db") },
    plugins: [{ id: "parity-fixture-catalogue", setup: (context) => { contexts.set(context.location.directory, context) } }],
  }
  sdk = await create(options)
  const session = await sdk.session.create({ title: "Combined plugin hook proof", location: { directory: workspace } })
  await sdk.session.generate({ sessionID: session.id, prompt: "INITIALIZE_PLUGIN_FIXTURE" })
  const inventory = await sdk.plugin.list({ location: { directory: workspace } })
  assert(inventory.data.some((plugin) => plugin.id === "moritz-parity"), JSON.stringify(inventory))
  await sdk.mcp.connect({ server: "gmail-arca", location: { directory: workspace } })
  const discoveryDeadline = Date.now() + 10000
  while (!(await contexts.get(workspace)?.tool.list())?.some((tool) => tool.id === "gmail-arca_send_email") && Date.now() < discoveryDeadline) await Bun.sleep(10)
  assert((await contexts.get(workspace).tool.list()).some((tool) => tool.id === "gmail-arca_send_email"), "wait for actual asynchronous MCP tool registration before scripted calls")
  await sdk.session.prompt({ sessionID: session.id, text: "Run the local hook fixtures, then finish." })
  await sdk.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(60000) })
  const history = await sdk.session.context({ sessionID: session.id })
  if (sendCalls.length !== 1) console.error(JSON.stringify({ mcp: await sdk.mcp.list({ location: { directory: workspace } }), plugins: await sdk.plugin.list(), tools: history.flatMap((message) => message.type === "assistant" ? message.content.filter((part) => part.type === "tool") : []), logs }, null, 2))
  assert.equal(modelRequests.length, 5, `runner did not complete five fixture steps: ${JSON.stringify({ history, logs })}`)
  assert.deepEqual(modelRequests.map((item) => item.sendCount), [0, 0, 0, 1, 1], JSON.stringify({ mcp: await sdk.mcp.list({ location: { directory: workspace } }), plugins: await sdk.plugin.list(), tools: history.flatMap((message) => message.type === "assistant" ? message.content.filter((part) => part.type === "tool") : []), logs }))
  assert.equal(sendCalls.length, 1, "invalid Gmail leaf calls must be blocked before reaching the local MCP server")
  assert.equal(sendCalls[0].name, "send_email")
  assert.equal(sendCalls[0].arguments.subject, "valid-fixture")
  assert(modelRequests[0].body.tools.some((item) => item.function?.name === "execute"))
  assert(!modelRequests[0].body.tools.some((item) => item.function?.name === "gmail-arca_send_email"), "MCP leaf must be reached through real Code Mode, not a native tool shortcut")
  assert(JSON.stringify(modelRequests[1].body.messages).includes("BLOCKED: plain-text Gmail body"))
  assert(JSON.stringify(modelRequests[2].body.messages).includes("BLOCKED: plain-text Gmail body"))
  assert.equal(readFileSync(join(workspace, "shell-env.txt"), "utf8"), session.id)
  assert.equal(readFileSync(join(workspace, "native-output.txt"), "utf8"), "native write accepted")
  const audit = readFileSync(join(home, "combined-hooks.jsonl"), "utf8").trim().split("\n").map(JSON.parse)
  const gmail = audit.filter((item) => item.tool_name === "mcp__gmail-arca__send_email")
  assert.deepEqual(gmail.map((item) => item.tool_input.subject), ["missing-html", "invalid-mime", "valid-fixture"])
  assert(audit.every((item) => item.session_id === session.id && item.hook_session_env === session.id))
  assert(audit.every((item) => item.cwd === workspace))
  assert(audit.some((item) => item.tool_name === "Bash" && item.hook_event_name === "PreToolUse"))
  assert(audit.some((item) => item.tool_name === "Write" && item.hook_event_name === "PostToolUse" && item.tool_input.file_path === join(workspace, "native-output.txt")))
  assert(JSON.stringify(history).includes("COMBINED_READY"))
  const extraction = await sdk.session.create({ title: "Memory extraction sandbox proof", agent: "opencode-memory-extract", location: { directory: workspace } })
  await sdk.session.prompt({ sessionID: extraction.id, text: "Save exactly the fixture memory, then finish." })
  await sdk.session.wait({ sessionID: extraction.id }, { signal: AbortSignal.timeout(60000) })
  const extractionHistory = await sdk.session.context({ sessionID: extraction.id })
  assert.equal(modelRequests.length, 7, `native extraction did not finish: ${JSON.stringify({ extractionHistory, logs })}`)
  for (const request of modelRequests.slice(5)) {
    assert.deepEqual(request.body.tools.map((item) => item.function.name).sort(), ["memory_list", "memory_read", "memory_save"])
  }
  assert(!modelRequests[5].body.tools.some((item) => ["execute", "shell", "write", "send_message"].includes(item.function.name)))
  const saved = extractionHistory.flatMap((message) => message.type === "assistant" ? message.content : []).find((part) => part.type === "tool" && part.name === "memory_save")
  assert.equal(saved.state.status, "completed")
  const savedPath = /Memory saved to ([^\n]+)/.exec(saved.state.content.map((part) => part.text ?? "").join("\n"))?.[1]
  assert(savedPath?.startsWith(home), `memory tool must write only to isolated Claude root: ${savedPath}`)
  assert(existsSync(savedPath))
  assert(readFileSync(savedPath, "utf8").includes("NATIVE_MEMORY_SANDBOX_SAVED"))
  const parentBeforeSelector = JSON.stringify(await sdk.session.context({ sessionID: session.id }))
  const { activate } = await import("../server.js")
  const { selectRelevantMemoryFilenames } = await import("../node_modules/opencode-claude-memory/dist/recall/selector.js")
  let selectorClient
  const closeSelector = await activate(contexts.get(workspace), [(input) => { selectorClient = input.client; return {} }])
  const selectorForks = []
  try {
    const selected = await selectRelevantMemoryFilenames({
      client: selectorClient, directory: workspace, parentSessionID: session.id, query: "Find the sandbox fixture memory", recentTools: [],
      memories: [{ filename: "sandbox_fixture.md", name: "Sandbox fixture", type: "reference", description: "native fixture", body: "NATIVE_MEMORY_SANDBOX_SAVED", filePath: savedPath, mtimeMs: 1, hasFrontmatter: true }],
      agent: "opencode-memory-recall", timeoutMs: 10000, maxMemories: 5, onSessionCreated: (id) => selectorForks.push(id),
    })
    assert.deepEqual(selected, ["sandbox_fixture.md"])
    assert.equal(structuredRequests.length, 1, "original selector must reach the real native forced-output provider route")
    assert.deepEqual(structuredRequests[0].tools.map((tool) => tool.function.name), ["generate_object"])
    assert.equal(JSON.stringify(await sdk.session.context({ sessionID: session.id })), parentBeforeSelector)
    await assert.rejects(() => sdk.session.get({ sessionID: selectorForks[0] }), /not found/i)
  } finally { await closeSelector() }
  const lifecycle = await sdk.session.create({ title: "Persistent profile lifecycle proof", location: { directory: workspace } })
  await sdk.session.prompt({ sessionID: lifecycle.id, text: "Arm the harmless finite monitor and background shell, then stop." })
  await sdk.session.wait({ sessionID: lifecycle.id }, { signal: AbortSignal.timeout(60000) })
  assert.equal(modelRequests.length, 9)
  const holdsDirectory = join(process.env.XDG_STATE_HOME, "agentview/holds/opencode", lifecycle.id)
  const holds = readdirSync(holdsDirectory).filter((file) => file.endsWith(".json")).map((file) => ({ file, ...JSON.parse(readFileSync(join(holdsDirectory, file), "utf8")) }))
  const monitor = holds.find((hold) => !hold.file.startsWith("bg-"))
  const background = holds.find((hold) => hold.file.startsWith("bg-"))
  assert(monitor && background, `both real plugin holds must exist before teardown: ${JSON.stringify(holds)}`)
  process.kill(-monitor.pid, 0)
  process.kill(background.pid, 0)
  const backgroundGroup = Number(execFileSync("ps", ["-o", "pgid=", "-p", String(background.pid)], { encoding: "utf8" }).trim())
  await sdk.close()
  assert.throws(() => process.kill(-monitor.pid, 0), "SDK disposal must kill the monitor group, not claim it survived")
  assert(readdirSync(holdsDirectory).some((file) => file.endsWith(".cut.json")), "monitor disposal must leave recovery intent")
  assert(JSON.parse(readFileSync(join(holdsDirectory, background.file), "utf8")).released)
  sdk = await create(options)
  await sdk.session.generate({ sessionID: lifecycle.id, prompt: "INITIALIZE_PLUGIN_FIXTURE" })
  let recovered = []
  const recoveryDeadline = Date.now() + 25000
  do {
    recovered = (await sdk.session.context({ sessionID: lifecycle.id })).filter((message) => message.type === "synthetic" && /<(?:monitor|background-shell)-notification/.test(message.text))
    if (recovered.length >= 2) break
    await Bun.sleep(20)
  } while (Date.now() < recoveryDeadline)
  await sdk.session.wait({ sessionID: lifecycle.id }, { signal: AbortSignal.timeout(10000) })
  assert.equal(recovered.filter((message) => message.text.includes("<monitor-notification")).length, 1, JSON.stringify(recovered))
  assert.equal(recovered.filter((message) => message.text.includes("<background-shell-notification")).length, 1, JSON.stringify(recovered))
  assert(recovered.find((message) => message.text.includes("<monitor-notification")).text.includes("killed because the OpenCode process running it exited"))
  assert.equal(readFileSync(watchOnce, "utf8"), "WATCH_ONCE\n", "reopen must not replay the monitor command")
  assert.equal(readFileSync(backgroundOnce, "utf8"), "BG_ONCE\n", "reopen must adopt, not rerun, the background command")
  assert.equal(readdirSync(holdsDirectory).filter((file) => file.endsWith(".json")).length, 0)
  assert.throws(() => process.kill(-monitor.pid, 0))
  assert.throws(() => process.kill(-backgroundGroup, 0))
  console.log("COMBINED_RUNNER_HOOKS_OK")
} finally {
  await sdk?.close()
  await provider.stop(true)
  await mcp.stop(true)
}
