export function host(directory, options = {}, defaultSession = "ses_fixture") {
  const tools = new Map()
  const commands = new Map()
  const hooks = new Map()
  const prompts = []
  const history = new Map()
  const structured = []
  const stored = new Map()
  const instructions = new Map()
  const sessions = new Map([[defaultSession, { id: defaultSession, location: { directory }, time: { created: 1, updated: 1 }, title: "fixture" }]])
  const events = []
  let wake
  const register = async (name, callback) => {
    const rows = hooks.get(name) ?? []
    hooks.set(name, [...rows, callback])
    return { dispose: async () => hooks.set(name, (hooks.get(name) ?? []).filter((fn) => fn !== callback)) }
  }
  const context = {
    location: { directory, project: { id: "fixture", directory, canonical: directory } }, options: { quiet: true, ...options },
    tool: {
      transform: async (callback) => {
        const owned = []
        callback({ add: (tool) => { tools.set(tool.name, tool); owned.push(tool.name) } })
        return { dispose: async () => owned.forEach((name) => tools.delete(name)) }
      },
      hook: register,
    },
    command: {
      transform: async (callback) => {
        const owned = []
        callback({ add: (command) => { commands.set(command.name, command); owned.push(command.name) } })
        return { dispose: async () => owned.forEach((name) => commands.delete(name)) }
      },
      list: async () => ({ location: { directory }, data: [...commands.values()] }),
    },
    session: {
      hook: register,
      instructions: { entry: {
        list: async ({ sessionID }) => [...(instructions.get(sessionID) ?? new Map())].map(([key, value]) => ({ key, value })),
        put: async ({ sessionID, key, value }) => { const entries = instructions.get(sessionID) ?? new Map(); entries.set(key, value); instructions.set(sessionID, entries) },
        remove: async ({ sessionID, key }) => instructions.get(sessionID)?.delete(key),
      } },
      list: async () => ({ data: [...sessions.values()] }),
      active: async () => ({}),
      get: async ({ sessionID }) => sessions.get(sessionID),
      context: async ({ sessionID }) => history.get(sessionID) ?? [],
      generateObject: async (input, options) => {
        const draft = { sessionID: input.sessionID, agent: sessions.get(input.sessionID).agent, options: {}, tools: { shell: {} }, system: [], model: { providerID: "openai", id: "fixture" } }
        for (const kind of ["context", "generate"]) for (const callback of hooks.get(kind) ?? []) await callback(draft)
        structured.push({ input, options, draft, session: { ...sessions.get(input.sessionID) } })
        return { object: { selected_memories: ["team/test.md"] } }
      },
      create: async (input) => {
        const session = { ...input, id: `ses_fixture${sessions.size}`, time: { created: Date.now(), updated: Date.now() } }
        sessions.set(session.id, session)
        return session
      },
      prompt: async (input) => { prompts.push(input) },
      synthetic: async (input) => { prompts.push(input) },
      remove: async ({ sessionID }) => sessions.delete(sessionID),
      interrupt: async () => {},
      switchAgent: async ({ sessionID, agent }) => { sessions.get(sessionID).agent = agent },
      switchModel: async ({ sessionID, model }) => { sessions.get(sessionID).model = model },
      wait: async () => {},
    },
    agent: {
      get: async ({ agentID }) => ({ location: { directory }, data: { id: agentID, ...(options.agentModels?.[agentID] ? { model: options.agentModels[agentID] } : {}) } }),
    },
    permission: { reply: async () => {} },
    model: { list: async () => ({ location: { directory }, data: [{ providerID: "openai", id: "fixture", capabilities: { temperature: true } }] }) },
    message: { list: async ({ sessionID }) => ({ data: history.get(sessionID) ?? [], cursor: {} }) },
    storage: { get: async (key) => stored.has(key) ? structuredClone(stored.get(key)) : undefined, set: async (key, value) => stored.set(key, structuredClone(value)), remove: async (key) => stored.delete(key) },
    shell: { hook: (name, callback) => register(`shell.${name}`, callback) },
    event: {
      subscribe({ signal }) {
        return { async *[Symbol.asyncIterator]() {
          while (!signal.aborted) {
            if (!events.length) await new Promise((resolve) => { wake = resolve; signal.addEventListener("abort", resolve, { once: true }) })
            while (events.length) yield events.shift()
          }
        } }
      },
    },
  }
  return {
    context, tools, commands, prompts, history, sessions, structured, instructions,
    event: (event) => { events.push(event); wake?.() },
    invoke: async (name, input) => { for (const callback of hooks.get(name) ?? []) await callback(input) },
    call: async (name, input, sessionID = defaultSession) => tools.get(name).execute(input, { sessionID, agent: "build", id: "call_fixture", messageID: "msg_fixture", signal: new AbortController().signal, progress: async () => {} }),
  }
}
