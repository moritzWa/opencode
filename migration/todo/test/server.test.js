import { expect } from "bun:test"
import { Database } from "bun:sqlite"
import { chmod, readFile } from "node:fs/promises"
import { join } from "node:path"
import { Effect } from "effect"
import { Tool } from "../../../packages/core/src/tool.ts"
import { Session } from "../../../packages/core/src/session.ts"
import { tmpdirScoped } from "../../../packages/core/test/fixture/tmpdir.ts"
import { it } from "../../../packages/core/test/lib/effect.ts"
import { openHost } from "./host.js"
import plugin, { activate, authority } from "../server.js"
import { createTodoStore } from "../store.js"
import { TodoRpc } from "../rpc.js"

const todos = [
  { content: "Ship the portable plugin", status: "in_progress", priority: "high" },
  { content: "Verify native persistence", status: "pending", priority: "medium" },
  { content: "Old completed work", status: "completed", priority: "low" },
  { content: "Abandoned approach", status: "cancelled", priority: "low" },
]

it.live(
  "native provider-neutral catalog executes direct tools and persists write/read/clear across full host reopen",
  () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped()
      expect(plugin.id).toBe("moritz-todo")
      expect(plugin.setup).toBe(activate)
      const saved = yield* Effect.gen(function* () {
        const host = yield* openHost(directory.path)
        const session = yield* host.create("openai")
        const other = yield* host.create("anthropic")
        const ctx = yield* host.activate(session)
        for (const current of [session, other]) {
          const tools = yield* Tool.Service.pipe(host.instances.provide(current))
          const registered = yield* tools.list()
          expect(registered.find((tool) => tool.name === "todowrite")?.options?.codemode).toBe(false)
          const snapshot = yield* tools.snapshot()
          expect(snapshot.definitions.map((tool) => tool.name)).toContain("todowrite")
          expect(snapshot.definitions.map((tool) => tool.name)).toContain("todoread")
        }
        const history = yield* host.sessions.messages({ sessionID: session.id })
        const written = yield* host.call(session, "todowrite", { todos })
        expect(written.metadata.todos).toEqual(todos)
        expect(written.metadata.title).toBeString()
        expect(JSON.parse(written.content.find((part) => part.type === "text").text)).toEqual(todos)
        const api = host.client().rpc(TodoRpc)
        const state = yield* Effect.promise(() => api.get({ sessionID: session.id }, host.rpcOptions))
        expect(state).toEqual({ sessionID: session.id, todos, revision: 1 })
        expect(yield* Effect.promise(() => ctx.storage.get(`session.${session.id}`))).toEqual({ todos, revision: 1 })
        expect((yield* host.call(other, "todoread", {})).metadata.todos).toEqual([])
        expect(yield* host.sessions.messages({ sessionID: session.id })).toEqual(history)
        return { sessionID: session.id, otherID: other.id }
      }).pipe(Effect.scoped)

      yield* Effect.gen(function* () {
        const host = yield* openHost(directory.path)
        const session = yield* host.sessions.get(saved.sessionID)
        yield* host.activate(session)
        expect((yield* host.call(session, "todoread", {})).metadata.todos).toEqual(todos)
        const cleared = yield* host.call(session, "todowrite", { todos: [] })
        expect(cleared.metadata.todos).toEqual([])
        expect(JSON.parse(cleared.content.find((part) => part.type === "text").text)).toEqual([])
      }).pipe(Effect.scoped)

      yield* Effect.gen(function* () {
        const host = yield* openHost(directory.path)
        const session = yield* host.sessions.get(saved.sessionID)
        const ctx = yield* host.activate(session)
        expect((yield* host.call(session, "todoread", {})).metadata.todos).toEqual([])
        expect(yield* Effect.promise(() => ctx.storage.get(`session.${session.id}`))).toEqual({
          todos: [],
          revision: 2,
        })
        expect(
          yield* Effect.promise(() => host.client().rpc(TodoRpc).get({ sessionID: saved.otherID }, host.rpcOptions)),
        ).toEqual({ sessionID: saved.otherID, todos: [], revision: 0 })
      }).pipe(Effect.scoped)
    }).pipe(Effect.scoped),
)

it.live(
  "two public RPC clients receive tool and HTTP changes, refetch, disconnect and reconnect without a todo HTTP route",
  () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped()
      const host = yield* openHost(directory.path)
      const session = yield* host.create()
      const other = yield* host.create()
      const first = yield* host.connect()
      const second = yield* host.connect()
      yield* Effect.promise(async () => {
        const controller = new AbortController()
        const left = first.rpc.events.subscribe("changed", { signal: controller.signal })[Symbol.asyncIterator]()
        const right = second.rpc.events.subscribe("changed", { signal: controller.signal })[Symbol.asyncIterator]()
        try {
          const pending = [left.next(), right.next()]
          const state = await first.rpc.update({ sessionID: session.id, todos }, host.rpcOptions)
          expect(state).toEqual({ sessionID: session.id, todos, revision: 1 })
          for (const item of await Promise.all(pending)) {
            expect(item.done).toBe(false)
            expect(item.value.type).toBe("rpc.moritz-todo.changed")
            expect(item.value.data).toEqual(state)
            expect(item.value.location.directory).toBe(directory.path)
          }
          expect(await second.rpc.get({ sessionID: session.id }, host.rpcOptions)).toEqual(state)
          expect(await second.rpc.get({ sessionID: other.id }, host.rpcOptions)).toEqual({
            sessionID: other.id,
            todos: [],
            revision: 0,
          })
        } finally {
          controller.abort()
          await Promise.all([left.return(), right.return()])
        }
      })
      // Exercise the model's actual Tool snapshot executor, not the RPC handler.
      const controller = new AbortController()
      const events = second.rpc.events.subscribe("changed", { signal: controller.signal })[Symbol.asyncIterator]()
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          controller.abort()
          await events.return()
        }),
      )
      const changed = events.next()
      yield* host.call(session, "todowrite", { todos: [] })
      expect((yield* Effect.promise(() => changed)).value.data).toEqual({
        sessionID: session.id,
        todos: [],
        revision: 2,
      })
      yield* Effect.promise(async () => {
        controller.abort()
        await events.return()
      })
      yield* Effect.promise(() => second.close())
      const next = yield* host.connect()
      expect(yield* Effect.promise(() => next.rpc.get({ sessionID: session.id }, host.rpcOptions))).toEqual({
        sessionID: session.id,
        todos: [],
        revision: 2,
      })
      yield* Effect.promise(async () => {
        const controller = new AbortController()
        const events = next.rpc.events.subscribe("changed", { signal: controller.signal })[Symbol.asyncIterator]()
        try {
          const pending = events.next()
          const state = await first.rpc.update({ sessionID: session.id, todos: [todos[1]] }, host.rpcOptions)
          expect((await pending).value.data).toEqual(state)
          expect(state.revision).toBe(3)
          expect(await next.rpc.get({ sessionID: session.id }, host.rpcOptions)).toEqual(state)
        } finally {
          controller.abort()
          await events.return()
        }
      })
      expect(
        host.requests.some((request) => request.method === "POST" && request.path === "/api/rpc/moritz-todo/update"),
      ).toBe(true)
      expect(
        host.requests.every(
          (request) => request.path.startsWith("/api/rpc/moritz-todo/") || request.path === "/api/event",
        ),
      ).toBe(true)
    }).pipe(Effect.scoped),
)

it.live(
  "native instruction entry supersedes an imported unavailable-tool notice on prompt and read/write without rewriting history",
  () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped()
      const host = yield* openHost(directory.path)
      const template = yield* host.create()
      const api = host.client()
      const wire = yield* Effect.promise(() => api.session.get({ sessionID: template.id }))
      const imported = yield* Effect.promise(() =>
        api.session.import({
          info: { ...wire, id: Session.ID.create() },
          messages: [
            {
              id: "msg_imported_todo_notice",
              type: "system",
              text: "Migration notice: todowrite is unavailable. Do not use it.",
              time: { created: 1 },
            },
          ],
        }),
      )
      const ctx = yield* host.activate(imported)
      const before = yield* host.sessions.messages({ sessionID: imported.id })
      expect(before.some((message) => message.text?.includes("todowrite is unavailable"))).toBe(true)
      // Each path must install the entry independently; a prior write cannot mask a missing read hook.
      for (const action of ["prompt", "todoread", "todowrite"]) {
        yield* Effect.promise(() =>
          ctx.session.instructions.entry.remove({ sessionID: imported.id, key: "todo.authority" }),
        )
        if (action === "prompt") {
          yield* Effect.promise(() =>
            ctx.session.prompt({ sessionID: imported.id, text: "Plan this work", resume: false }),
          )
        }
        if (action === "todoread") yield* host.call(imported, action, {})
        if (action === "todowrite") yield* host.call(imported, action, { todos })
        const entries = yield* Effect.promise(() => ctx.session.instructions.entry.list({ sessionID: imported.id }))
        expect(entries.filter((entry) => entry.key === "todo.authority")).toEqual([
          { key: "todo.authority", value: authority },
        ])
        expect(authority).toMatch(/unavailable.*obsolete/i)
        expect(yield* host.sessions.messages({ sessionID: imported.id })).toEqual(before)
      }
    }).pipe(Effect.scoped),
)

it.live(
  "readonly legacy SQLite import preserves order/status/priority and never resurrects edited or explicitly cleared native state",
  () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped()
      const legacy = join(directory.path, "legacy.sqlite")
      const ids = yield* Effect.gen(function* () {
        const host = yield* openHost(directory.path)
        return {
          imported: (yield* host.create()).id,
          empty: (yield* host.create()).id,
          absent: (yield* host.create()).id,
        }
      }).pipe(Effect.scoped)
      yield* Effect.promise(async () => {
        const db = new Database(legacy, { create: true })
        try {
          db.exec(
            "CREATE TABLE todo (session_id TEXT NOT NULL, position INTEGER NOT NULL, content TEXT NOT NULL, status TEXT NOT NULL, priority TEXT NOT NULL, PRIMARY KEY (session_id, position))",
          )
          for (const id of [ids.imported, ids.empty]) {
            // Deliberately insert out of order, with non-contiguous positions.
            for (const position of [3, 0, 2, 1])
              db.query("INSERT INTO todo VALUES (?, ?, ?, ?, ?)").run(
                id,
                position * 10,
                todos[position].content,
                todos[position].status,
                todos[position].priority,
              )
          }
        } finally {
          db.close()
        }
        await chmod(legacy, 0o444)
      })
      const original = yield* Effect.promise(() => readFile(legacy))
      yield* Effect.gen(function* () {
        const host = yield* openHost(directory.path, { legacyDatabasePath: legacy })
        const session = yield* host.sessions.get(ids.imported)
        const ctx = yield* host.activate(session)
        const store = createTodoStore(ctx.storage, legacy)
        expect(yield* Effect.promise(() => ctx.storage.get(`session.${ids.imported}`))).toBeUndefined()
        expect(yield* Effect.promise(() => store.get(ids.imported))).toEqual({
          sessionID: ids.imported,
          todos,
          revision: 0,
        })
        expect(yield* Effect.promise(() => store.get(ids.absent))).toEqual({
          sessionID: ids.absent,
          todos: [],
          revision: 0,
        })
        yield* Effect.promise(() => store.update({ sessionID: ids.imported, todos: [todos[2]] }))
        yield* Effect.promise(() => store.update({ sessionID: ids.empty, todos: [] }))
      }).pipe(Effect.scoped)
      expect(yield* Effect.promise(() => readFile(legacy))).toEqual(original)
      yield* Effect.promise(async () => {
        await chmod(legacy, 0o644)
        const db = new Database(legacy)
        try {
          db.query("UPDATE todo SET content = 'later legacy refresh'").run()
          db.query("INSERT INTO todo VALUES (?, 0, 'arrived after first empty read', 'pending', 'high')").run(
            ids.absent,
          )
        } finally {
          db.close()
        }
        await chmod(legacy, 0o444)
      })
      const refreshed = yield* Effect.promise(() => readFile(legacy))
      yield* Effect.gen(function* () {
        const host = yield* openHost(directory.path, { legacyDatabasePath: legacy })
        const session = yield* host.sessions.get(ids.imported)
        const ctx = yield* host.activate(session)
        const store = createTodoStore(ctx.storage, legacy)
        expect(yield* Effect.promise(() => store.get(ids.imported))).toEqual({
          sessionID: ids.imported,
          todos: [todos[2]],
          revision: 1,
        })
        expect(yield* Effect.promise(() => store.get(ids.empty))).toEqual({
          sessionID: ids.empty,
          todos: [],
          revision: 1,
        })
        expect(yield* Effect.promise(() => store.get(ids.absent))).toEqual({
          sessionID: ids.absent,
          todos: [],
          revision: 0,
        })
        expect((yield* host.call(session, "todoread", {})).metadata.todos).toEqual([todos[2]])
      }).pipe(Effect.scoped)
      expect(yield* Effect.promise(() => readFile(legacy))).toEqual(refreshed)
    }).pipe(Effect.scoped),
)

it.live("todoread may be disabled while todowrite remains a direct public tool", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    const host = yield* openHost(directory.path, { todoread: false })
    const session = yield* host.create()
    const tools = yield* Tool.Service.pipe(host.instances.provide(session))
    const snapshot = yield* tools.snapshot()
    expect(snapshot.definitions.map((tool) => tool.name)).toContain("todowrite")
    expect(snapshot.definitions.map((tool) => tool.name)).not.toContain("todoread")
    expect((yield* host.call(session, "todowrite", { todos })).metadata.todos).toEqual(todos)
  }).pipe(Effect.scoped),
)
