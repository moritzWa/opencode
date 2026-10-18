import { parseTodos } from "./rpc.js"

// All Location activations in this server serialize a Session's first import
// with its writes. The public KV domain has no compare-and-swap operation.
const jobs = new Map()
function serial(sessionID, run) {
  const job = (jobs.get(sessionID) ?? Promise.resolve()).catch(() => {}).then(run)
  jobs.set(sessionID, job)
  return job.finally(() => {
    if (jobs.get(sessionID) === job) jobs.delete(sessionID)
  })
}

export function createTodoStore(storage, legacyDatabasePath) {
  async function read(sessionID) {
    const saved = await storage.get(`session.${sessionID}`)
    if (saved !== undefined) {
      if (!saved || !Number.isSafeInteger(saved.revision) || saved.revision < 0)
        throw new Error("Invalid saved todo state")
      return { sessionID, revision: saved.revision, todos: parseTodos(saved.todos) }
    }
    const state = { sessionID, revision: 0, todos: await importLegacy(legacyDatabasePath, sessionID) }
    // Missing and explicitly cleared are different: [] is a durable tombstone,
    // and later legacy refreshes must never resurrect an edited/cleared list.
    await storage.set(`session.${sessionID}`, { revision: state.revision, todos: state.todos })
    return state
  }
  return {
    get(sessionID) {
      return serial(sessionID, () => read(sessionID))
    },
    update(input) {
      return serial(input.sessionID, async () => {
        const previous = await read(input.sessionID)
        const state = { sessionID: input.sessionID, revision: previous.revision + 1, todos: parseTodos(input.todos) }
        await storage.set(`session.${input.sessionID}`, { revision: state.revision, todos: state.todos })
        return state
      })
    },
  }
}

async function importLegacy(file, sessionID) {
  if (!file) return []
  const { Database } = await import("bun:sqlite")
  const db = new Database(file, { readonly: true, create: false })
  try {
    if (!db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'todo'").get()) return []
    return parseTodos(
      db.query("SELECT content, status, priority FROM todo WHERE session_id = ? ORDER BY position ASC").all(sessionID),
    )
  } finally {
    db.close()
  }
}
