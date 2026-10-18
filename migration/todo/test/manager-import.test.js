import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { stat } from "node:fs/promises"
import { Effect } from "effect"
import { tmpdirScoped } from "../../../packages/core/test/fixture/tmpdir.ts"
import { openHost } from "./host.js"
import { TodoRpc } from "../rpc.js"

const legacy = process.env.TODO_LEGACY_DATABASE_PATH
const sessionID = process.env.TODO_LEGACY_SESSION_ID

test.skipIf(!legacy || !sessionID)(
  "explicit read-only candidate import restores the manager's four saved todos",
  async () => {
    const before = await stat(legacy)
    const db = new Database(legacy, { readonly: true, create: false })
    const expected = db
      .query("SELECT content, status, priority FROM todo WHERE session_id = ? ORDER BY position ASC")
      .all(sessionID)
    expect(db.query("SELECT total_changes() AS changes").get().changes).toBe(0)
    db.close()
    expect(expected).toHaveLength(4)
    expect(expected.filter((item) => item.status !== "completed")).toHaveLength(3)
    await Effect.runPromise(
      Effect.gen(function* () {
        const directory = yield* tmpdirScoped()
        const host = yield* openHost(directory.path, { legacyDatabasePath: legacy })
        yield* host.create("openai")
        const api = host.client().rpc(TodoRpc)
        const imported = yield* Effect.promise(() => api.get({ sessionID }, host.rpcOptions))
        expect(imported.todos).toEqual(expected)
        yield* Effect.promise(() => api.update({ sessionID, todos: [] }, host.rpcOptions))
        expect((yield* Effect.promise(() => api.get({ sessionID }, host.rpcOptions))).todos).toEqual([])
      }).pipe(Effect.scoped),
    )
    const after = await stat(legacy)
    expect({ size: after.size, mtime: after.mtimeMs }).toEqual({ size: before.size, mtime: before.mtimeMs })
  },
)
