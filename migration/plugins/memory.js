import { buildMemorySystemPrompt, formatRecalledMemories, recallSelectedMemories } from "./legacy/memory.js"
import { legacyHistory } from "./bridge.js"

const BASE = "memory.base"
const INDEX = "memory.index"
const RECALLED = "memory.recalled"
const MODE = "memory.mode"
const DISABLED = "Memory is disabled by the user. Treat MEMORY.md as empty. Do not apply, cite, compare against, or mention previously recalled facts. Do not access memory until the user explicitly re-enables it."
const ENABLED = "Memory is enabled. Use the latest memory index and chronological recalled context, subject to the user's current instructions."

/** Native instruction entries own epoch baselines and ordered updates. Never
 * append live memory to the model-request system hook. Durable KV is only
 * producer state (mode, selected file names, and prompt retry identity). */
export async function prepareMemory(ctx, hook, sessionID, prompt) {
  const memory = hook.memory
  if (memory.owned.has(sessionID)) return
  if (!ctx.session.instructions?.entry) throw new Error("Cache-stable memory requires the native session.instructions.entry plugin API")
  const api = ctx.session.instructions.entry
  const key = `memory.${sessionID}`
  const state = (await ctx.storage.get(key)) ?? { ignored: false, selected: [] }
  const stored = new Map((await api.list({ sessionID })).map((entry) => [entry.key, entry.value]))
  const put = async (key, value) => {
    if (stored.get(key) === value) return
    await api.put({ sessionID, key, value })
    stored.set(key, value)
  }
  const remove = async (key) => {
    if (!stored.has(key)) return
    await api.remove({ sessionID, key })
    stored.delete(key)
  }

  if (prompt && (!prompt.messageID || prompt.messageID !== state.lastUser)) {
    const rows = legacyHistory(await ctx.session.context({ sessionID }), sessionID)
    const seed = state.ignored ? [{ info: { role: "user", id: "memory-mode", sessionID }, parts: [{ type: "text", text: "ignore memory" }] }] : []
    const recalled = stored.get(RECALLED)
    await hook["experimental.chat.messages.transform"]?.({}, { messages: [
      ...seed,
      ...(recalled && !state.ignored ? [{ info: { role: "system", sessionID }, parts: [{ type: "text", text: recalled }] }] : []),
      ...rows,
      { info: { role: "user", id: prompt.messageID ?? "pending", sessionID }, parts: [{ type: "text", text: prompt.prompt.text }] },
    ] })
    state.ignored = memory.recall.isIgnored(sessionID)
    if (prompt.messageID) state.lastUser = prompt.messageID
  }

  const base = buildMemorySystemPrompt(memory.store, "", { includeIndex: false })
  if (state.ignored) {
    state.selected = []
    await ctx.storage.set(key, state)
    await put(BASE, base)
    await put(MODE, DISABLED)
    await remove(INDEX)
    await remove(RECALLED)
    return
  }

  const selected = await memory.recall.takeRecalled(sessionID)
  if (selected.length) state.selected = selected.map((item) => item.fileName)
  // Write producer state first so an interrupted preparation can reconstruct
  // the same entries on retry without another selector request.
  await ctx.storage.set(key, state)
  await put(BASE, base)
  await put(MODE, ENABLED)
  const full = buildMemorySystemPrompt(memory.store, "", { includeIndex: true })
  await put(INDEX, full.slice(base.length).trimStart())
  // Keep a consumed selection; refresh its actual files instead of removing
  // it on the next tool step or retaining stale content to save cache tokens.
  if (state.selected?.length) {
    const current = recallSelectedMemories(state.selected.map((file) => memory.store.read(file)).filter(Boolean), state.selected, new Set(), { maxMemories: memory.config.recall.maxMemories })
    const text = formatRecalledMemories(current)
    if (text) await put(RECALLED, text)
    else { state.selected = []; await ctx.storage.set(key, state); await remove(RECALLED) }
  }
}
