import { expect } from "bun:test"
import { Bus } from "@opencode/core/bus"
import { Config } from "@opencode/core/config"
import { Database } from "@opencode/core/database/database"
import { Watcher } from "@opencode/core/filesystem/watcher"
import { Instance } from "@opencode/core/instance"
import { Location } from "@opencode/core/location"
import { ModelsDev } from "@opencode/core/models-dev"
import { Plugin } from "@opencode/core/plugin"
import { PluginPromise } from "@opencode/core/plugin/promise"
import { SdkPlugins } from "@opencode/core/plugin/sdk"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { InstructionEntry } from "@opencode/core/session/instruction-entry"
import { InstructionEntryTable, SessionTable } from "@opencode/core/session/sql"
import type { SessionDomain } from "@opencode/plugin/promise/session"
import { Global } from "@opencode/util/global"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Context, Deferred, Effect, Layer } from "effect"
import { HttpEffect, HttpRouter, HttpServer } from "effect/http"
import { tempGlobalLayer } from "../../core/test/fixture/global"
import { tmpdirScoped } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { createEmbeddedRoutes } from "../src/routes"

it.live("public Promise instruction entries match HTTP, isolate sessions and survive runtime reopen", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    const otherDirectory = yield* tmpdirScoped()
    const database = `${directory.path}/entries.sqlite`
    const open = Effect.fn(function* () {
      const ready = yield* Deferred.make<SessionDomain>()
      const plugin = PluginPromise.fromPromise({
        id: "public-instruction-entry",
        setup(ctx) {
          Effect.runSync(Deferred.succeed(ready, ctx.session))
        },
      })
      const context = yield* Layer.build(
        createEmbeddedRoutes({ database: { path: database } }, [
          Global.node.replace(tempGlobalLayer),
          Config.node.replace(Config.testLayer()),
          ModelsDev.node.replace(ModelsDev.configured({ fetch: false })),
          Watcher.node.replace(Watcher.configured({ enabled: false })),
          SdkPlugins.node.replace(
            makeGlobalNode({
              service: SdkPlugins.Service,
              deps: [Bus.node],
              layer: Layer.effect(
                SdkPlugins.Service,
                Effect.gen(function* () {
                  const plugins = yield* SdkPlugins.Service
                  yield* plugins.register(plugin)
                  return plugins
                }),
              ).pipe(Layer.provide(SdkPlugins.layer)),
            }),
          ),
        ]).pipe(Layer.provide(HttpServer.layerServices)),
      )
      return {
        sessions: Context.get(context, Session.Service),
        instances: Context.get(context, Instance.Service),
        db: Context.get(context, Database.Service).db,
        ready,
        handler: Context.get(context, HttpRouter.HttpRouter).asHttpEffect().pipe(HttpEffect.toWebHandlerWith(context)),
      }
    })
    const saved = yield* Effect.gen(function* () {
      const runtime = yield* open()
      const parent = yield* runtime.sessions.create({
        location: Location.Ref.make({ directory: AbsolutePath.make(directory.path) }),
      })
      const session = yield* runtime.sessions.create({ parentID: parent.id })
      const other = yield* runtime.sessions.create({
        location: Location.Ref.make({ directory: AbsolutePath.make(otherDirectory.path) }),
      })
      // This activates the actual SDK supervisor, native PluginHost and fromPromise adapter.
      yield* Plugin.awaitActivation.pipe(runtime.instances.provide(session))
      const api = (yield* Deferred.await(runtime.ready)).instructions.entry
      const entries = yield* InstructionEntry.Service.pipe(runtime.instances.provide(session))
      const otherEntries = yield* InstructionEntry.Service.pipe(runtime.instances.provide(other))
      expect(otherEntries).not.toBe(entries)
      const before = yield* runtime.db.select().from(SessionTable).orderBy(SessionTable.id).all()
      const history = yield* runtime.sessions.messages({ sessionID: session.id })
      const parentHistory = yield* runtime.sessions.messages({ sessionID: parent.id })
      const rows = () =>
        runtime.db
          .select()
          .from(InstructionEntryTable)
          .orderBy(InstructionEntryTable.session_id, InstructionEntryTable.key)
          .all()
      const request = (sessionID: Session.ID, method = "GET", key?: string, value?: unknown) =>
        Effect.promise(() =>
          runtime.handler(
            new Request(
              `http://opencode.local/api/experimental/session/${sessionID}/instructions/entries${key === undefined ? "" : `/${encodeURIComponent(key)}`}`,
              {
                method,
                ...(method === "PUT"
                  ? { headers: { "content-type": "application/json" }, body: JSON.stringify({ value }) }
                  : {}),
              },
            ),
          ),
        )
      const list = (sessionID: Session.ID) =>
        Effect.gen(function* () {
          const actual = yield* Effect.promise(() => api.list({ sessionID }))
          expect(Array.isArray(actual)).toBe(true)
          const response = yield* request(sessionID)
          expect(response.status).toBe(200)
          expect(yield* Effect.promise(() => response.json())).toEqual({ data: actual })
          return actual
        })
      const rejected = (call: () => Promise<unknown>, message?: string) =>
        Effect.promise(async () => {
          const error = await call().then(
            () => undefined,
            (error: unknown) => error,
          )
          expect(error).toBeInstanceOf(Error)
          if (error instanceof Error && message) expect(error.message).toContain(message)
          return error
        })
      expect(yield* list(session.id)).toEqual([])
      expect(
        yield* Effect.promise(() =>
          api.put({ sessionID: session.id, key: "memory.v1_0-ok", value: { note: ["native", 1, true, null] } }),
        ),
      ).toBeUndefined()
      expect(yield* entries.list(session.id)).toEqual([
        { key: "memory.v1_0-ok", value: { note: ["native", 1, true, null] } },
      ])
      expect(yield* entries.list(session.id)).toEqual(yield* list(session.id))

      // Pin the timestamp to prove an identical put executes no rewrite, without a clock race.
      yield* runtime.db.update(InstructionEntryTable).set({ time_updated: 123 }).run()
      const unchanged = yield* rows()
      yield* Effect.promise(() =>
        api.put({ sessionID: session.id, key: "memory.v1_0-ok", value: { note: ["native", 1, true, null] } }),
      )
      expect(yield* rows()).toEqual(unchanged)

      const put = yield* request(session.id, "PUT", "memory.v1_0-ok", { note: "HTTP replacement" })
      expect(put.status).toBe(204)
      expect(yield* Effect.promise(() => put.text())).toBe("")
      expect(yield* list(session.id)).toEqual([{ key: "memory.v1_0-ok", value: { note: "HTTP replacement" } }])
      expect(yield* Effect.promise(() => api.remove({ sessionID: session.id, key: "memory.v1_0-ok" }))).toBeUndefined()
      expect(yield* list(session.id)).toEqual([])
      expect(yield* rows()).toMatchObject([
        { session_id: session.id, key: "memory.v1_0-ok", value: null, removed: true },
      ])
      yield* Effect.promise(() => api.put({ sessionID: session.id, key: "memory.v1_0-ok", value: "revived" }))
      expect(yield* list(session.id)).toEqual([{ key: "memory.v1_0-ok", value: "revived" }])
      const remove = yield* request(session.id, "DELETE", "memory.v1_0-ok")
      expect(remove.status).toBe(204)
      expect(yield* Effect.promise(() => remove.text())).toBe("")
      expect(yield* entries.list(session.id)).toEqual([])

      // The plugin belongs to session's directory, while the target belongs to another Location.
      yield* Effect.promise(() =>
        api.put({ sessionID: other.id, key: "cross-session", value: { directory: "target" } }),
      )
      expect(yield* otherEntries.list(other.id)).toEqual([{ key: "cross-session", value: { directory: "target" } }])
      expect(yield* otherEntries.list(other.id)).toEqual(yield* list(other.id))
      yield* Effect.promise(() => api.remove({ sessionID: other.id, key: "cross-session" }))
      expect(yield* otherEntries.list(other.id)).toEqual([])
      yield* Effect.promise(() =>
        api.put({ sessionID: other.id, key: "cross-session", value: { directory: "persisted" } }),
      )

      const missing = Session.ID.create()
      for (const method of ["GET", "PUT", "DELETE"]) {
        const response = yield* request(missing, method, method === "GET" ? undefined : "missing", "never stored")
        expect(response.status).toBe(404)
      }
      expect(yield* rejected(() => api.list({ sessionID: missing }))).toMatchObject({
        _tag: "Session.NotFoundError",
        sessionID: missing,
      })
      expect(
        yield* rejected(() => api.put({ sessionID: missing, key: "missing", value: "never stored" })),
      ).toMatchObject({
        _tag: "Session.NotFoundError",
        sessionID: missing,
      })
      expect(yield* rejected(() => api.remove({ sessionID: missing, key: "missing" }))).toMatchObject({
        _tag: "Session.NotFoundError",
        sessionID: missing,
      })
      const valid = yield* rows()
      for (const key of ["Uppercase", "has/slash", "has space", "-leading", ""]) {
        yield* rejected(() => api.put({ sessionID: session.id, key, value: "invalid" }))
        yield* rejected(() => api.remove({ sessionID: session.id, key }))
        // Empty path keys cannot address the item route; all nonempty invalid keys must decode as 400.
        if (key === "") continue
        expect((yield* request(session.id, "PUT", key, "invalid")).status).toBe(400)
        expect((yield* request(session.id, "DELETE", key)).status).toBe(400)
      }
      // Multibyte JSON is bounded by encoded bytes, rather than JavaScript string length.
      const oversized = "é".repeat(InstructionEntry.MaxValueBytes / 2)
      yield* rejected(() => api.put({ sessionID: session.id, key: "oversized", value: oversized }), "limit")
      const tooLarge = yield* request(session.id, "PUT", "oversized", oversized)
      expect(tooLarge.status).toBe(413)
      expect(yield* Effect.promise(() => tooLarge.json())).toMatchObject({
        _tag: "InstructionEntryValueTooLargeError",
        actualBytes: InstructionEntry.MaxValueBytes + 2,
      })

      const controller = new AbortController()
      const reason = new Error("Already cancelled entry write")
      controller.abort(reason)
      expect(
        yield* rejected(() =>
          api.put({ sessionID: session.id, key: "cancelled", value: "never stored" }, { signal: controller.signal }),
        ),
      ).toBe(reason)
      expect(
        yield* rejected(() => api.remove({ sessionID: other.id, key: "cross-session" }, { signal: controller.signal })),
      ).toBe(reason)
      expect(yield* rows()).toEqual(valid)
      expect(yield* entries.list(parent.id)).toEqual([])
      expect(yield* runtime.sessions.messages({ sessionID: session.id })).toEqual(history)
      expect(yield* runtime.sessions.messages({ sessionID: parent.id })).toEqual(parentHistory)
      expect(yield* runtime.sessions.messages({ sessionID: other.id })).toEqual([])
      expect(yield* runtime.db.select().from(SessionTable).orderBy(SessionTable.id).all()).toEqual(before)
      return { sessionID: session.id, otherID: other.id, rows: yield* rows() }
    }).pipe(Effect.scoped)

    // The entire first application graph, plugin supervisor and SQLite connection are closed.
    yield* Effect.gen(function* () {
      const runtime = yield* open()
      const session = yield* runtime.sessions.get(saved.sessionID)
      yield* Plugin.awaitActivation.pipe(runtime.instances.provide(session))
      const api = (yield* Deferred.await(runtime.ready)).instructions.entry
      expect(yield* Effect.promise(() => api.list({ sessionID: saved.sessionID }))).toEqual([])
      expect(yield* Effect.promise(() => api.list({ sessionID: saved.otherID }))).toEqual([
        { key: "cross-session", value: { directory: "persisted" } },
      ])
      expect(
        yield* runtime.db
          .select()
          .from(InstructionEntryTable)
          .orderBy(InstructionEntryTable.session_id, InstructionEntryTable.key)
          .all(),
      ).toEqual(saved.rows)
    }).pipe(Effect.scoped)
  }).pipe(Effect.scoped),
)
