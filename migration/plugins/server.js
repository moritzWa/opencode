import { $ } from "bun"
import { resolve } from "node:path"
import { homedir } from "node:os"
import { tool } from "@opencode-ai/plugin"
import { MemoryPlugin, createMemoryPlugin } from "./legacy/memory.js"
import { PeersPlugin } from "opencode-plugin-peers"
import { Adrafinil } from "./legacy/plugins/adrafinil.js"
import { BackgroundShell } from "./legacy/plugins/background-shell.js"
import { ClaudeHooks } from "./legacy/plugins/claude-hooks.js"
import { Monitor } from "./legacy/plugins/monitor.js"
import { SpawnedSessions } from "./legacy/plugins/spawned-sessions.js"
import { WorktreePlugin } from "./legacy/plugins/worktree.js"
import { legacyEvents, legacyHistory, legacySession, makeClient, textContent } from "./bridge.js"
import { prepareMemory } from "./memory.js"

export async function activate(ctx, factories) {
  const client = makeClient(ctx)
  const registrations = []
  const hooks = []
  const controller = new AbortController()
  const overrides = new Map()
  let events
  const memoryJobs = new Map()
  const memory = (hook, sessionID, prompt) => {
    const pending = (memoryJobs.get(sessionID) ?? Promise.resolve()).catch(() => {}).then(() => controller.signal.aborted ? undefined : prepareMemory(ctx, hook, sessionID, prompt))
    memoryJobs.set(sessionID, pending)
    return pending.finally(() => { if (memoryJobs.get(sessionID) === pending) memoryJobs.delete(sessionID) })
  }
  const legacy = {
    directory: ctx.location.directory,
    worktree: ctx.location.project.canonical,
    project: { id: ctx.location.project.id, worktree: ctx.location.project.canonical },
    client, $, options: ctx.options,
  }
  // V1 maintenance requests can supply a per-call system/tool sandbox. Keep it
  // scoped to the fork, never the shared parent or unrelated session.
  const original = client.session.prompt
  client.session.prompt = async (input) => {
    overrides.set(input.path.id, input.body)
    try {
      if (input.body.format) {
        if (input.body.format.type !== "json_schema") throw new Error("Unsupported memory selector format")
        if (typeof ctx.session.generateObject !== "function") throw new Error("Strict memory recall requires the V2 session.generateObject API")
        if (input.body.agent) await ctx.session.switchAgent({ sessionID: input.path.id, agent: input.body.agent })
        if (input.body.model) await ctx.session.switchModel({ sessionID: input.path.id, model: { providerID: input.body.model.providerID, id: input.body.model.id ?? input.body.model.modelID } })
        const result = await ctx.session.generateObject({
          sessionID: input.path.id,
          prompt: input.body.parts.filter((part) => part.type === "text").map((part) => part.text).join("\n\n"),
          schema: input.body.format.schema,
        }, { signal: input.signal })
        return { data: { info: { role: "assistant", sessionID: input.path.id, structured: result.object }, parts: [] } }
      }
      return await original(input)
    } finally {
      overrides.delete(input.path.id)
    }
  }
  const cleanup = async () => {
    controller.abort()
    await events
    await Promise.allSettled(memoryJobs.values())
    await Promise.all(hooks.toReversed().map((hook) => hook.dispose?.()))
    await Promise.all(registrations.toReversed().map((entry) => entry.dispose()))
  }
  try {
    for (const factory of factories) hooks.push(await factory(legacy, ctx.options))
    const config = { agent: {}, command: {} }
    for (const hook of hooks) await hook.config?.(config)
    registrations.push(await ctx.command.transform((editor) => {
      for (const [name, definition] of Object.entries(config.command)) {
        editor.add({
          name, description: definition.description,
          execute: async (input) => {
            const output = { parts: [{ type: "text", text: "" }] }
            for (const hook of hooks) await hook["command.execute.before"]?.({ sessionID: input.sessionID, command: name, arguments: input.prompt.text }, output)
            const text = output.parts.filter((part) => part.type === "text").map((part) => part.text).join("\n")
            if (text) await ctx.session.synthetic({ sessionID: input.sessionID, text, resume: true, delivery: input.delivery, description: `/${name}` })
          },
        })
      }
    }))
    registrations.push(await ctx.tool.transform((editor) => {
      for (const hook of hooks) for (const [name, definition] of Object.entries(hook.tool ?? {})) {
        editor.add({
          name, description: definition.description,
          input: tool.schema.object(definition.args),
          options: { codemode: false },
          async execute(input, context) {
            const result = await definition.execute(input, {
              ...context, callID: context.id, abort: context.signal,
              directory: ctx.location.directory, worktree: ctx.location.project.canonical,
              metadata: (value) => context.progress(value),
              ask: async () => {},
            })
            return typeof result === "string" ? { content: result } : { content: result.output, metadata: { ...result.metadata, title: result.title } }
          },
        })
      }
    }))
    registrations.push(await ctx.tool.hook("execute.before", async (input) => {
      const payload = { tool: normalize(input.tool), sessionID: input.sessionID, callID: input.id }
      const output = { args: input.input }
      // Directory is resolved per call. A session moved into a worktree must
      // not run hooks against the Location that happened to load this plugin.
      const claude = await ClaudeHooks({ directory: input.cwd ?? ctx.location.directory })
      await claude["tool.execute.before"](payload, { args: hookArgs(input.input, input.cwd ?? ctx.location.directory) })
      for (const hook of hooks) await hook["tool.execute.before"]?.(payload, output)
      input.input = output.args
    }))
    registrations.push(await ctx.tool.hook("execute.after", async (input) => {
      if (input.status !== "completed") return
      const payload = { tool: normalize(input.tool), sessionID: input.sessionID, callID: input.id, args: input.input }
      const result = { output: textContent(input.result.content), metadata: input.result.metadata, title: input.result.metadata?.title }
      const claude = await ClaudeHooks({ directory: input.cwd ?? ctx.location.directory })
      await claude["tool.execute.after"]({ ...payload, args: hookArgs(input.input, input.cwd ?? ctx.location.directory) }, result)
      for (const hook of hooks) await hook["tool.execute.after"]?.(payload, result)
      for (const hook of hooks) if (hook.memory) await memory(hook, input.sessionID)
    }))
    registrations.push(await ctx.shell.hook("create.before", (input) => {
      if (input.sessionID) input.env.CLAUDE_CODE_SESSION_ID = input.sessionID
    }))
    registrations.push(await ctx.session.hook("prompt", async (input) => {
      for (const hook of hooks) await hook["chat.message"]?.({ sessionID: input.sessionID }, { message: {}, parts: [{ type: "text", text: input.prompt.text }] })
      for (const hook of hooks) if (hook.memory) await memory(hook, input.sessionID, input)
    }))
    const transform = (kind) => async (input) => {
      // Strict object generation runs both native hooks; apply the legacy
      // per-call override once, at the final generate boundary.
      if (kind === "context" && overrides.get(input.sessionID)?.format) return
      const agent = config.agent[input.agent]
      if (agent?.temperature !== undefined) {
        const models = await ctx.model.list()
        if ((models.data ?? models).find((model) => model.providerID === input.model.providerID && model.id === input.model.id)?.capabilities.temperature) input.options.temperature = agent.temperature
      }
      const rows = legacyHistory(await ctx.session.context({ sessionID: input.sessionID }), input.sessionID)
      for (const hook of hooks) if (!hook.memory) await hook["experimental.chat.messages.transform"]?.({}, { messages: rows })
      const output = { system: [] }
      for (const hook of hooks) if (!hook.memory) await hook["experimental.chat.system.transform"]?.({ sessionID: input.sessionID, model: input.model }, output)
      const override = overrides.get(input.sessionID)
      if (override?.system) output.system.push(override.system)
      if (override?.tools) for (const name of Object.keys(input.tools)) if (!override.tools[name]) delete input.tools[name]
      for (const text of output.system) input.system.push({ type: "text", text })
    }
    for (const name of ["context", "generate"]) registrations.push(await ctx.session.hook(name, transform(name)))
    events = (async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        const p = event.data ?? event.properties ?? event
        if (event.type === "session.deleted") await ctx.storage.remove(`memory.${p.sessionID}`)
        const updated = ["session.renamed", "session.moved", "session.metadata.updated"].includes(event.type)
          ? [{ type: "session.updated", properties: { info: legacySession(await ctx.session.get({ sessionID: p.sessionID })) } }]
          : legacyEvents(event)
        for (const projected of updated) for (const hook of hooks) {
          try { await hook.event?.({ event: projected }) }
          catch (error) { console.error("parity plugin event handler failed", error) }
        }
      }
    })().catch((error) => {
      if (!controller.signal.aborted) console.error("parity plugin event stream failed", error)
    })
    return cleanup
  } catch (error) {
    await cleanup()
    throw error
  }
}

export function normalize(name) {
  const normalized = name.replace(/^mcp__/, "").replaceAll("__", "_").replace(/^functions[._]/, "")
  return normalized === "shell" ? "bash" : normalized
}

function hookArgs(input, directory) {
  if (!input || typeof input !== "object") return input
  return { ...input,
    ...(input.path ? { filePath: input.path } : {}),
    ...(input.workdir ? { workdir: resolve(directory, input.workdir.replace(/^~(?=\/|$)/, homedir())) } : {}),
  }
}

export default {
  id: "moritz-parity",
  setup: (ctx) => activate(ctx, [...(ctx.options.adrafinil === false ? [] : [Adrafinil]), BackgroundShell, Monitor, SpawnedSessions, WorktreePlugin,
    (input) => createMemory(input, ctx.options),
    (input) => PeersPlugin(input, ctx.options.peers),
  ]),
}

export function createMemory(input, options) {
  const plugin = options.memoryConfigDir
    ? createMemoryPlugin({ ...process.env, CLAUDE_CONFIG_DIR: options.memoryConfigDir }, homedir())
    : MemoryPlugin
  return plugin(input, { ...options.memory, autodream: { enabled: false } })
}
