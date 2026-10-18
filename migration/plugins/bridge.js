/** V2 to V1 data projection shared by the server and TUI adapters. */
export function legacyMessage(message, sessionID) {
  const role = ["assistant", "compaction", "shell", "skill"].includes(message.type) ? "assistant" : message.type === "system" ? "system" : "user"
  const content = message.type === "shell" ? [{ type: "tool", id: message.shellID, name: "bash", state: { status: message.status === "running" ? "running" : "completed", input: { command: message.command }, content: [{ type: "text", text: message.output?.output ?? "" }], metadata: { exit: message.exit, status: message.status } } }]
    : message.type === "skill" ? [{ type: "tool", name: "skill", state: { status: "completed", input: { name: message.name }, content: [{ type: "text", text: message.text }] } }]
      : message.content ?? (message.text === undefined ? message.summary ? [{ type: "text", text: message.summary }] : [] : [{ type: "text", text: message.text }])
  return {
    info: {
      ...message, sessionID, role,
      providerID: message.model?.providerID,
      modelID: message.model?.id ?? message.model?.modelID,
      finish: message.finish,
      summary: message.type === "compaction",
      time: (message.type === "compaction" && message.status === "completed") || message.type === "skill" ? { ...message.time, completed: message.time.created } : message.time,
    },
    parts: content.map((part, index) => ({
      ...part,
      metadata: { ...message.metadata, ...part.metadata },
      id: String(index),
      messageID: message.id,
      sessionID,
      tool: part.name,
      ...(part.type === "tool" && part.id ? { callID: part.id } : {}),
      synthetic: message.type === "synthetic" || message.type === "system",
      ...(part.type === "tool" ? { state: { ...part.state, output: textContent(part.state?.content) } } : {}),
    })),
  }
}

export function legacyHistory(messages, sessionID) {
  const rows = messages.filter((message) => ["assistant", "user", "synthetic", "system", "compaction", "shell", "skill"].includes(message.type)).map((message) => legacyMessage(message, sessionID))
  let parentID
  for (const row of rows) {
    if (row.info.role === "user") parentID = row.info.id
    if (row.info.role === "assistant") row.info.parentID = parentID
  }
  return rows
}

export function textContent(content) {
  if (typeof content === "string") return content
  return (content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\n")
}

export function legacySession(session) {
  return { ...session, directory: session.location?.directory, title: session.title ?? "" }
}

/** Do not manufacture idle transitions from assistant completion: tools and
 * queued input may still be running. Only the actual idle event means idle. */
export function legacyEvents(event) {
  const p = event.data ?? event.properties ?? event
  if (event.type === "session.created") return [{ type: event.type, properties: { info: legacySession({ ...p, id: p.sessionID, time: { created: p.time ?? Date.now(), updated: p.time ?? Date.now() } }) } }]
  if (event.type === "session.deleted") return [{ type: event.type, properties: { info: { id: p.sessionID } } }]
  if (event.type === "session.idle") return [
    { type: "session.status", properties: { sessionID: p.sessionID, status: { type: "idle" } } },
    { type: "session.idle", properties: { sessionID: p.sessionID } },
  ]
  if (event.type === "session.execution.started") return [{ type: "session.status", properties: { sessionID: p.sessionID, status: { type: "busy" } } }]
  if (["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"].includes(event.type)) return [
    { type: "session.status", properties: { sessionID: p.sessionID, status: { type: "idle" } } },
    { type: "session.idle", properties: { sessionID: p.sessionID } },
  ]
  if (event.type === "session.retry.scheduled") return [{ type: "session.status", properties: { sessionID: p.sessionID, status: { type: "retry", next: p.at, message: p.error?.message ?? "Retrying" } } }]
  if (event.type === "session.message.updated" && p.message) {
    const message = legacyMessage(p.message, p.sessionID)
    return [{ type: "message.updated", properties: { info: message.info } }, ...message.parts.map((part) => ({ type: "message.part.updated", properties: { part } }))]
  }
  if (event.type.startsWith("session.message.")) return [{ type: "message.updated", properties: { sessionID: p.sessionID } }]
  return [{ ...event, properties: p }]
}

export function sessionID(input) {
  return input?.path?.id ?? input?.sessionID
}

export function makeClient(ctx) {
  const data = (value) => ({ data: value })
  const history = async (input) => {
    if (!ctx.message?.list) throw new Error("Full transcript access requires the V2 message.list plugin domain")
    const messages = []
    let cursor
    do {
      const page = await ctx.message.list({ sessionID: sessionID(input), limit: 200, ...(cursor ? { cursor } : { order: "asc" }) }, { signal: input?.signal })
      messages.push(...page.data)
      if (page.data.length === 0) break
      cursor = page.cursor.next
    } while (cursor)
    return legacyHistory(messages, sessionID(input))
  }
  const inject = async (input, wait = false) => {
    const body = input.body ?? input
    const id = sessionID(input)
    if (body.agent) await ctx.session.switchAgent({ sessionID: id, agent: body.agent })
    if (body.model) await ctx.session.switchModel({ sessionID: id, model: { providerID: body.model.providerID, id: body.model.modelID ?? body.model.id } })
    const synthetic = !wait || body.parts?.every((part) => part.synthetic)
    const metadata = body.parts?.find((part) => part.metadata)?.metadata
    const request = {
      sessionID: id,
      id: body.messageID,
      text: (body.parts ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\n\n"),
      metadata,
      ...(!wait ? { description: body.parts?.find((part) => part.type === "text")?.text } : {}),
      delivery: "steer",
      resume: !body.noReply,
    }
    await (synthetic ? ctx.session.synthetic(request) : ctx.session.prompt(request))
    if (!wait || body.noReply) return data(undefined)
    await ctx.session.wait({ sessionID: id }, { signal: input.signal })
    return data((await history({ sessionID: id })).findLast((message) => message.info.role === "assistant"))
  }
  const list = async (input) => {
    const sessions = []
    let cursor
    do {
      const result = await ctx.session.list({ directory: input?.query?.directory ?? ctx.location.directory, limit: 1000, ...(cursor ? { cursor } : {}) }, { signal: input?.signal })
      sessions.push(...(result.data ?? result).map(legacySession))
      cursor = result.cursor?.next
    } while (cursor)
    return data(sessions)
  }
  return {
    session: {
      get: async (input) => data(legacySession(await ctx.session.get({ sessionID: sessionID(input) }, { signal: input?.signal }))),
      list,
      children: async (input) => data((await list(input)).data.filter((session) => session.parentID === sessionID(input))),
      messages: async (input) => data((await history(input)).slice(-(input?.query?.limit ?? Infinity))),
      message: async (input) => data((await history(input)).find((message) => message.info.id === input.path.messageID)),
      status: async () => data(Object.fromEntries(Object.keys(await ctx.session.active()).map((id) => [id, { type: "busy" }]))),
      create: async (input) => data(legacySession(await ctx.session.create({ ...input?.body, location: { directory: input?.query?.directory ?? ctx.location.directory } }, { signal: input?.signal }))),
      promptAsync: (input) => inject(input),
      prompt: (input) => inject(input, true),
      abort: async (input) => data(await ctx.session.interrupt({ sessionID: sessionID(input) }, { signal: input?.signal })),
      delete: async (input) => data(await ctx.session.remove({ sessionID: sessionID(input) }, { signal: input?.signal })),
      command: async (input) => data(await ctx.session.command({ sessionID: sessionID(input), name: input.command, text: input.arguments ?? "" })),
    },
    command: { list: async () => {
      const result = await ctx.command.list()
      return data(result.data ?? result)
    } },
    postSessionIdPermissionsPermissionId: async (input) => data(await ctx.permission.reply({ sessionID: input.path.id, requestID: input.path.permissionID, decision: input.body.response })),
    app: { log: async (input) => {
      if (!ctx.options.quiet) console.error(JSON.stringify({ plugin: "moritz-parity", ...input.body }))
    } },
  }
}
