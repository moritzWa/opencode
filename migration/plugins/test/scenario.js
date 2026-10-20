import { strict as assert } from "node:assert"
import { mkdirSync, readFileSync, existsSync } from "node:fs"
import { execFileSync, spawn } from "node:child_process"
import { join } from "node:path"
import { host } from "./host.js"
import plugin, { activate } from "../server.js"
import { PeersPlugin } from "opencode-plugin-peers"
import { legacyEvents, legacyMessage, legacyHistory, makeClient } from "../bridge.js"
import { BackgroundShell } from "../legacy/plugins/background-shell.js"
import { SELECT_MEMORIES_FORMAT, selectRelevantMemoryFilenames } from "../node_modules/opencode-claude-memory/dist/recall/selector.js"
import { buildAgentDefaults } from "../node_modules/opencode-claude-memory/dist/agents.js"

const home = process.env.HOME
mkdirSync(join(home, ".claude"), { recursive: true })
await Bun.write(join(home, ".claude/settings.json"), JSON.stringify({ hooks: {
  PreToolUse: [{ matcher: "Bash|mcp__gmail.*", hooks: [{ type: "command", command: `python3 -c 'import sys,json,os; p=json.load(sys.stdin); open(os.environ["HOME"]+"/hooks.log","a").write(json.dumps(p)+"\\n"); sys.exit(2 if p["tool_input"].get("command")=="blocked" else 0)'` }] }],
  PostToolUse: [{ matcher: "Edit|Write", hooks: [{ type: "command", command: `python3 -c 'import sys,json,os; p=json.load(sys.stdin); open(os.environ["HOME"]+"/post.log","a").write(json.dumps(p)+"\\n")'` }] }],
} }))
const fixture = host(home, { adrafinil: false, memory: { extract: { enabled: false }, recall: { enabled: false } }, peers: { name: "v2-fixture" } })
const cleanup = await plugin.setup(fixture.context)
const receiver = host(home, {}, "ses_receiver")
const cleanupReceiver = await activate(receiver.context, [(input) => PeersPlugin(input, { name: "v2-receiver" })])
await fixture.invoke("prompt", { sessionID: "ses_fixture", prompt: { text: "fixture activity" } })
await receiver.invoke("prompt", { sessionID: "ses_receiver", prompt: { text: "receiver activity" } })
try {
  assert.deepEqual([...fixture.tools.keys()].sort(), ["monitor", "monitor_stop", "monitor_list", "worktree_create", "worktree_list", "worktree_remove", "memory_save", "memory_read", "memory_search", "memory_list", "memory_delete", "list_agents", "send_message", "peer_message_status"].sort())
  await fixture.invoke("execute.before", { tool: "bash", id: "c1", sessionID: "ses_fixture", cwd: home, input: { command: "allowed" } })
  await fixture.invoke("execute.before", { tool: "shell", id: "native", sessionID: "ses_fixture", cwd: home, input: { command: "native" } })
  await assert.rejects(() => fixture.invoke("execute.before", { tool: "bash", id: "c2", sessionID: "ses_fixture", cwd: home, input: { command: "blocked" } }), /Blocked by hook/)
  await fixture.invoke("execute.before", { tool: "mcp__gmail-arca__send_email", id: "c3", sessionID: "ses_fixture", cwd: home, input: { body: "hello", htmlBody: "<p>hello</p>", mimeType: "multipart/alternative" } })
  const payloads = readFileSync(join(home, "hooks.log"), "utf8").trim().split("\n").map(JSON.parse)
  assert.equal(payloads.at(-1).tool_name, "mcp__gmail-arca__send_email")
  assert.equal(payloads.at(-1).session_id, "ses_fixture")
  await fixture.invoke("execute.after", { tool: "apply_patch", id: "c4", sessionID: "ses_fixture", cwd: home, input: { patchText: "*** Update File: a.txt\n*** Add File: b.txt\n*** Move to: c.txt" }, status: "completed", result: { content: "done" } })
  assert.deepEqual(readFileSync(join(home, "post.log"), "utf8").trim().split("\n").map(JSON.parse).map((p) => p.tool_input.file_path), ["a.txt", "b.txt", "c.txt"].map((p) => join(home, p)))
  await fixture.invoke("execute.after", { tool: "write", id: "native-write", sessionID: "ses_fixture", cwd: home, input: { path: "native.txt", content: "x" }, status: "completed", result: { content: "done" } })
  assert.equal(JSON.parse(readFileSync(join(home, "post.log"), "utf8").trim().split("\n").at(-1)).tool_input.file_path, join(home, "native.txt"))
  const shell = { sessionID: "ses_fixture", env: {} }
  await fixture.invoke("shell.create.before", shell)
  assert.equal(shell.env.CLAUDE_CODE_SESSION_ID, "ses_fixture")
  await fixture.call("memory_save", { file_name: "team/test", name: "Fixture", description: "parity", type: "reference", content: "fixture memory" })
  assert.match((await fixture.call("memory_read", { file_name: "team/test" })).content, /fixture memory/)
  assert.match((await fixture.call("memory_search", { query: "parity" })).content, /Fixture/)
  assert.match((await fixture.call("memory_list", {})).content, /Fixture/)
  const context = { sessionID: "ses_fixture", tools: {}, system: [], model: { providerID: "openai", modelID: "fixture" } }
  await fixture.invoke("context", context)
  assert.equal(context.system.length, 0, "live memory must not rewrite the request system prefix")
  assert.match(fixture.instructions.get("ses_fixture").get("memory.base"), /Auto Memory/)
  await fixture.call("memory_delete", { file_name: "team/test" })
  const armed = await fixture.call("monitor", { command: "printf 'ready\\n'; read ignored", description: "output then exit", timeout_ms: 2000 })
  assert.match(armed.content, /armed/)
  const deadline = Date.now() + 8000
  while (!fixture.prompts.some((p) => p.text.includes("exited with code")) && Date.now() < deadline) await Bun.sleep(20)
  assert(fixture.prompts.some((p) => p.text.includes("ready")), "monitor exit wake carries output")
  const next = await fixture.call("monitor", { command: "sleep 20", description: "explicit stop", timeout_ms: 30000 })
  const group = Number(/process group (\d+)/.exec(next.content)[1])
  assert(existsSync(join(home, ".local/state/agentview/holds/opencode/ses_fixture", `${process.pid}-m2.json`)))
  const stopped = await fixture.call("monitor_stop", { id: "m2" })
  assert.match(stopped.content, /is gone/)
  assert.throws(() => process.kill(-group, 0))
  await assert.rejects(() => fixture.call("monitor", { command: "tail -f log", description: "unbounded" }), /cannot end/)
  const streaming = await fixture.call("monitor", { command: "printf 'READY\\n'; sleep 2; printf 'finished\\n'", description: "matching stdout", pattern: "READY|fail|error", timeout_ms: 10000 })
  const streamingID = /Monitor (m\d+)/.exec(streaming.content)[1]
  await until(() => fixture.prompts.some((p) => p.text.includes(`[monitor ${streamingID}] matching stdout: READY`)))
  assert.match((await fixture.call("monitor_list", {})).content, new RegExp(`${streamingID} \\[running\\]`))
  await fixture.call("monitor_stop", { id: streamingID })
  const timed = await fixture.call("monitor", { command: "sleep 20", description: "timeout", timeout_ms: 1000 })
  const timeoutID = /Monitor (m\d+)/.exec(timed.content)[1]
  await until(() => fixture.prompts.some((p) => p.text.includes(`[monitor ${timeoutID}] timeout: timed out`)))
  assert.match((await fixture.call("monitor_list", {})).content, new RegExp(`${timeoutID} \\[timeout\\]`))

  execFileSync("git", ["init", "-q", home])
  await Bun.write(join(home, "seed.txt"), "seed")
  execFileSync("git", ["-C", home, "add", "seed.txt"])
  execFileSync("git", ["-C", home, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "fixture"])
  const worktree = await fixture.call("worktree_create", { name: "fixture-worktree" })
  assert.match(worktree.content, /Created worktree/)
  assert.match((await fixture.call("worktree_list", {})).content, /fixture-worktree/)
  await Bun.write(join(home, ".claude/worktrees/fixture-worktree/dirty.txt"), "dirty")
  assert.match((await fixture.call("worktree_remove", { name: "fixture-worktree" })).content, /uncommitted changes/)
  assert.match((await fixture.call("worktree_remove", { name: "fixture-worktree", force: true })).content, /Removed/)
  assert(!existsSync(join(home, ".claude/worktrees/fixture-worktree")))

  const shellLog = join(home, "background.log")
  const background = spawn("/bin/sh", ["-c", `printf background-finished > '${shellLog}'; sleep 1`], { detached: true, stdio: "ignore" })
  await fixture.invoke("execute.after", { tool: "shell", id: "background", sessionID: "ses_fixture", input: { command: "background fixture" }, status: "completed", result: { content: `__CURSOR_BACKGROUND_SHELL__${background.pid}:${shellLog}` } })
  await until(() => fixture.prompts.some((p) => p.text.includes("background-finished")))
  assert.throws(() => process.kill(background.pid, 0))
  const reloading = host(home, {}, "ses_reload")
  const beforeReload = await activate(reloading.context, [BackgroundShell])
  const survivorLog = join(home, "survivor.log")
  const survivor = spawn("/bin/sh", ["-c", `printf adopted > '${survivorLog}'; sleep 1`], { detached: true, stdio: "ignore" })
  await reloading.invoke("execute.after", { tool: "shell", id: "survivor", sessionID: "ses_reload", input: { command: "reload fixture" }, status: "completed", result: { content: `__CURSOR_BACKGROUND_SHELL__${survivor.pid}:${survivorLog}` } })
  await beforeReload()
  const afterReload = await activate(reloading.context, [BackgroundShell])
  try { await until(() => reloading.prompts.some((p) => p.text.includes("adopted"))) }
  finally { await afterReload() }
  assert.throws(() => process.kill(survivor.pid, 0))

  fixture.event({ type: "session.created", data: { sessionID: "ses_spawned", location: { directory: home }, title: "spawned" } })
  await Bun.sleep(0)
  await fixture.invoke("execute.after", { tool: "shell", id: "spawn", sessionID: "ses_fixture", input: {}, status: "completed", result: { content: "created ses_spawned" } })
  assert.match(readFileSync(join(home, ".local/state/agentview/opencode/session-parents.jsonl"), "utf8"), /"child":"ses_spawned","parent":"ses_fixture"/)
  const peers = await fixture.call("list_agents", {})
  assert.equal(typeof peers.content, "string")
  let other
  await until(async () => {
    const listed = await fixture.call("list_agents", {})
    other = /"v2-receiver" \(id ([^)]+)\)/.exec(listed.content)?.[1]
    return other !== undefined
  })
  const delivery = await fixture.call("send_message", { to: other, message: "portable V2 peer fixture" })
  assert.match(delivery.content, /Message delivered/)
  await until(() => receiver.prompts.some((prompt) => prompt.text.includes("portable V2 peer fixture")))
  const injected = receiver.prompts.find((prompt) => prompt.text.includes("portable V2 peer fixture"))
  assert.equal(injected.sessionID, "ses_receiver")
  assert.equal(injected.metadata.peerMessage.version, 2)
  assert.equal(injected.resume, true)
  const messageID = /Tracking ID: ([^.]+)\./.exec(delivery.content)[1]
  assert.match((await fixture.call("peer_message_status", { message_id: messageID })).content, /receipt: delivered/)
  await fixture.commands.get("peers").execute({ sessionID: "ses_fixture", prompt: { text: "" } })
  assert(fixture.prompts.some((p) => p.description === "/peers"))
  assert.equal(fixture.prompts.find((p) => p.description === "/peers").resume, true, "V1 command interception asks the model to display the handled result")
  assert(Array.isArray((await makeClient(fixture.context).command.list()).data))
  assert.equal(legacyEvents({ type: "session.created", data: { sessionID: "ses_x", location: { directory: home } } })[0].properties.info.id, "ses_x")
  assert.equal(legacyMessage({ id: "msg_x", type: "assistant", content: [{ type: "reasoning", text: "r" }, { type: "text", text: "same" }] }, "ses_x").parts[1].id, "1")
  assert.equal(legacyHistory([{ id: "msg_x", type: "assistant", content: [{ type: "text", text: "done" }] }, { id: "msg_idle", type: "idle", outcome: "succeeded" }], "ses_x").at(-1).info.role, "assistant")
  const strict = host(home, { agentModels: { "opencode-memory-recall": { providerID: "openai", id: "gpt-6-luna" } } }, "ses_selector_parent")
  let selectorClient
  const closeStrict = await activate(strict.context, [(input) => { selectorClient = input.client; return { config: (cfg) => { Object.assign(cfg.agent, buildAgentDefaults({ recall: "opencode-memory-recall", extract: "opencode-memory-extract", dream: "opencode-memory-dream" })) } } }])
  const owned = []
  try {
    const selected = await selectRelevantMemoryFilenames({
      client: selectorClient, directory: home, parentSessionID: "ses_selector_parent", query: "fixture memory useful for parity", recentTools: [],
      memories: [{ filename: "team/test.md", name: "Fixture", type: "reference", description: "parity", body: "fixture", filePath: "fixture", mtimeMs: 1, hasFrontmatter: true }],
      agent: "opencode-memory-recall", timeoutMs: 5000, maxMemories: 5,
      onSessionCreated: (id) => owned.push(["created", id]), onSessionFinished: (id) => owned.push(["finished", id]),
    })
    assert.deepEqual(selected, ["team/test.md"])
    assert.deepEqual(strict.structured[0].input.schema, SELECT_MEMORIES_FORMAT.schema)
    assert.match(strict.structured[0].input.prompt, /fixture memory useful for parity/)
    assert.equal(strict.structured[0].session.agent, "opencode-memory-recall")
    assert.deepEqual(strict.structured[0].session.model, { providerID: "openai", id: "gpt-6-luna" }, "the selector fork must run on the recall agent's model, not the global default")
    assert(strict.structured[0].options.signal instanceof AbortSignal)
    assert.equal(strict.structured[0].draft.system.filter((part) => part.text.includes("You are selecting memories")).length, 1)
    assert.deepEqual(strict.structured[0].draft.tools, {})
    assert.equal(strict.structured[0].draft.options.temperature, 0)
    assert.equal(strict.prompts.length, 0, "strict selector must not admit a prose prompt or execute a tool loop")
    assert.equal(strict.sessions.size, 1, "original owned fork cleanup must remove selector child")
    assert.equal(strict.sessions.get("ses_selector_parent").agent, undefined)
    assert.deepEqual(owned.map(([event]) => event), ["created", "finished"])
    assert.equal(owned[0][1], owned[1][1])
    strict.context.model.list = async () => ({ location: { directory: home }, data: [{ providerID: "openai", id: "fixture", capabilities: { temperature: false } }] })
    const unsupportedTemperature = { sessionID: "ses_selector_parent", agent: "opencode-memory-recall", model: { providerID: "openai", id: "fixture" }, options: {}, tools: {}, system: [] }
    await strict.invoke("generate", unsupportedTemperature)
    assert.equal(unsupportedTemperature.options.temperature, undefined, "V1 omits temperature for unsupported models such as Luna")
    const full = [
      { id: "msg_control", type: "model-switched", model: { providerID: "openai", id: "fixture" } },
      { id: "msg_before_user", type: "user", text: "before compaction", time: { created: 1 } },
      { id: "msg_before_assistant", type: "assistant", content: [{ type: "text", text: "old answer" }], time: { created: 2, completed: 3 } },
      { id: "msg_compaction", type: "compaction", status: "completed", summary: "summary", time: { created: 4 } },
      { id: "msg_after_user", type: "user", text: "after compaction", time: { created: 5 } },
      { id: "msg_partial", type: "assistant", content: [{ type: "text", text: "still streaming" }], time: { created: 6 } },
      { id: "msg_idle", type: "idle", outcome: "succeeded", time: { created: 7 } },
    ]
    const before = JSON.stringify(full)
    const pages = []
    const signal = new AbortController().signal
    strict.context.message.list = async (input, options) => {
      pages.push({ input, options })
      if (!input.cursor) return { data: full.slice(0, 3), cursor: { next: "page1" } }
      if (input.cursor === "page1") return { data: full.slice(3, 5), cursor: { next: "page2" } }
      if (input.cursor === "page2") return { data: full.slice(5), cursor: { next: "empty" } }
      if (input.cursor === "empty") return { data: [], cursor: { next: "must-not-follow" } }
      throw new Error("followed an empty page")
    }
    const raw = await selectorClient.session.messages({ path: { id: "ses_selector_parent" }, signal })
    assert.deepEqual(raw.data.map((message) => message.info.id), ["msg_before_user", "msg_before_assistant", "msg_compaction", "msg_after_user", "msg_partial"])
    assert.equal(new Set(raw.data.map((message) => message.info.id)).size, raw.data.length)
    assert.equal(raw.data.find((message) => message.info.id === "msg_compaction").info.time.completed, 4)
    assert.equal(pages.length, 4)
    assert.equal(pages[0].input.order, "asc")
    assert(pages.slice(1).every((page) => !("order" in page.input)))
    assert(pages.every((page) => page.input.limit === 200 && page.options.signal === signal))
    const limited = await selectorClient.session.messages({ path: { id: "ses_selector_parent" }, query: { limit: 2 } })
    assert.deepEqual(limited.data.map((message) => message.info.id), ["msg_after_user", "msg_partial"])
    assert.equal((await selectorClient.session.message({ path: { id: "ses_selector_parent", messageID: "msg_before_assistant" } })).data.parts[0].text, "old answer")
    assert.equal((await selectorClient.session.message({ path: { id: "ses_selector_parent", messageID: "msg_partial" } })).data.info.time.completed, undefined)
    assert.equal(JSON.stringify(full), before)
    const visible = legacyHistory([{ id: "msg_shell", type: "shell", shellID: "shl_fixture", command: "fixture", status: "exited", output: { output: "native shell output" }, time: { created: 1, completed: 2 } }, { id: "msg_skill", type: "skill", name: "fixture-skill", text: "skill instructions", time: { created: 3 } }], "ses_selector_parent")
    assert.deepEqual(visible.map((message) => message.parts[0].tool), ["bash", "skill"])
    assert.equal(visible[0].parts[0].state.output, "native shell output")
    assert.equal(visible[0].parts[0].callID, "shl_fixture")
    assert.equal(visible[1].info.time.completed, 3)
  } finally { await closeStrict() }
} finally {
  await cleanupReceiver()
  await cleanup()
}
assert.equal(fixture.tools.size, 0)
console.log("SERVER_LIFECYCLE_OK")

async function until(test) {
  const deadline = Date.now() + 10000
  while (!(await test()) && Date.now() < deadline) await Bun.sleep(10)
  assert(await test(), "expected lifecycle transition before deadline")
}
