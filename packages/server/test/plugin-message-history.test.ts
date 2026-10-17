import { expect } from "bun:test"
import type { MessageApi } from "@opencode/client/promise/api"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { Config } from "@opencode/core/config"
import { Watcher } from "@opencode/core/filesystem/watcher"
import { Instance } from "@opencode/core/instance"
import { Location } from "@opencode/core/location"
import { Model } from "@opencode/core/model"
import { ModelsDev } from "@opencode/core/models-dev"
import { Plugin } from "@opencode/core/plugin"
import { PluginPromise } from "@opencode/core/plugin/promise"
import { SdkPlugins } from "@opencode/core/plugin/sdk"
import { Provider } from "@opencode/core/provider"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionMessage } from "@opencode/core/session/message"
import type { SessionDomain } from "@opencode/plugin/promise/session"
import { Money } from "@opencode/schema/money"
import { Global } from "@opencode/util/global"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Context, Deferred, Effect, Layer } from "effect"
import { HttpEffect, HttpRouter, HttpServer } from "effect/http"
import { tempGlobalLayer } from "../../core/test/fixture/global"
import { tmpdirScoped } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { createEmbeddedRoutes } from "../src/routes"

it.live(
  "public Promise message pages retain pre-compaction and running output with HTTP cursors, errors and cancellation",
  () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped()
      const ready = yield* Deferred.make<{ message: MessageApi; session: SessionDomain }>()
      const plugin = PluginPromise.fromPromise({
        id: "public-message-history",
        setup(ctx) {
          Effect.runSync(Deferred.succeed(ready, ctx))
        },
      })
      const context = yield* Layer.build(
        createEmbeddedRoutes({}, [
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
      const sessions = Context.get(context, Session.Service)
      const instances = Context.get(context, Instance.Service)
      const bus = Context.get(context, Bus.Service)
      const handler = Context.get(context, HttpRouter.HttpRouter)
        .asHttpEffect()
        .pipe(HttpEffect.toWebHandlerWith(context))
      const session = yield* sessions.create({
        location: Location.Ref.make({ directory: AbsolutePath.make(directory.path) }),
      })
      // Activation constructs the actual native host and public Promise bridge.
      yield* Plugin.awaitActivation.pipe(instances.provide(session))
      const api = yield* Deferred.await(ready)
      const model = { id: Model.ID.make("history-model"), providerID: Provider.ID.make("fixture") }
      const usage = {
        cost: Money.USD.zero,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      }
      const older = SessionMessage.ID.create()
      const settled = SessionMessage.ID.create()
      const compacted = SessionMessage.ID.create()
      const newer = SessionMessage.ID.create()
      const running = SessionMessage.ID.create()
      const user = Effect.fn(function* (id: SessionMessage.ID, text: string) {
        yield* sessions.prompt({ sessionID: session.id, id, text, resume: false })
        yield* bus.publish(SessionEvent.InboxDelivered, { sessionID: session.id, inboxID: id })
      })
      const assistant = Effect.fn(function* (id: SessionMessage.ID, text: string) {
        const input = { sessionID: session.id, assistantMessageID: id }
        yield* bus.publish(SessionEvent.Step.Started, { ...input, agent: Agent.defaultID, model, started: 0 })
        yield* bus.publish(SessionEvent.Text.Started, { ...input, ordinal: 0 })
        yield* bus.publish(SessionEvent.Text.Ended, { ...input, ordinal: 0, text })
      })
      yield* user(older, "Original user message before compaction")
      yield* assistant(settled, "Original assistant answer before compaction")
      yield* bus.publish(SessionEvent.Step.Ended, {
        sessionID: session.id,
        assistantMessageID: settled,
        finish: "stop",
        ...usage,
      })
      yield* bus.publish(SessionEvent.Compaction.Started, {
        sessionID: session.id,
        reason: "manual",
        recent: "",
        inputID: compacted,
      })
      yield* bus.publish(SessionEvent.Compaction.Ended, {
        sessionID: session.id,
        reason: "manual",
        model,
        text: "Checkpoint summary",
        recent: "",
        ...usage,
      })
      yield* user(newer, "User message after compaction")
      // A projected text chunk is present, but the assistant Step has not ended.
      yield* assistant(running, "Partial assistant output still running")
      const ids = [older, settled, compacted, newer, running]
      const history = yield* sessions.messages({ sessionID: session.id, order: "asc", limit: 100 })
      expect(history.map((message) => message.id)).toEqual(ids)
      expect(history.at(-1)).toMatchObject({
        type: "assistant",
        content: [{ type: "text", text: "Partial assistant output still running" }],
      })
      expect(history.at(-1)?.time).not.toHaveProperty("completed")
      const selected = yield* Effect.promise(() => api.session.context({ sessionID: session.id }))
      expect(selected.map((message) => message.id)).toEqual([compacted, newer, running])

      type Input = Parameters<MessageApi["list"]>[0]
      const page = (input: Input) =>
        Effect.promise(async () => {
          const actual = await api.message.list(input)
          const query = new URLSearchParams(
            Object.entries(input).flatMap(([key, value]) =>
              key === "sessionID" || value === undefined ? [] : [[key, String(value)]],
            ),
          )
          const response = await handler(
            new Request(`http://opencode.local/api/session/${input.sessionID}/message?${query}`),
          )
          expect(response.status).toBe(200)
          expect(actual).toEqual(await response.json())
          return actual
        })
      for (const order of ["asc", "desc"] as const) {
        const expected = order === "asc" ? ids : ids.toReversed()
        for (const limit of [1, 2, 3, 8]) {
          const pages = []
          let input: Input = { sessionID: session.id, order, limit }
          const seen: string[] = []
          // A bounded walk also fails promptly if a cursor accidentally repeats a page.
          for (let index = 0; index <= ids.length; index++) {
            const current = yield* page(input)
            if (current.data.length === 0) break
            pages.push(current)
            seen.push(...current.data.map((message) => message.id))
            expect(current.cursor.previous).toBeDefined()
            expect(current.cursor.next).toBeDefined()
            input = { sessionID: session.id, limit, cursor: current.cursor.next ?? undefined }
          }
          expect(seen).toEqual(expected)
          expect(new Set(seen).size).toBe(ids.length)
          for (let index = pages.length - 1; index > 0; index--) {
            const previous = yield* page({
              sessionID: session.id,
              limit,
              cursor: pages[index]?.cursor.previous ?? undefined,
            })
            expect(previous).toEqual(pages[index - 1])
          }
        }
      }
      const first = yield* page({ sessionID: session.id, limit: 2, order: "asc" })
      const other = yield* sessions.create({ location: session.location })
      expect((yield* page({ sessionID: other.id, cursor: first.cursor.next ?? undefined })).data).toEqual([])
      expect(
        (yield* page({ sessionID: session.id, order: "asc", type: "user" })).data.map((message) => message.id),
      ).toEqual([older, newer])
      for (const invalid of [
        { input: { sessionID: session.id, cursor: "not-a-cursor" }, message: "Invalid cursor" },
        {
          input: { sessionID: session.id, cursor: first.cursor.next ?? undefined, order: "asc" as const },
          message: "Cursor cannot be combined with order",
        },
      ]) {
        yield* Effect.promise(async () => {
          const error = await api.message.list(invalid.input).then(
            () => undefined,
            (error: unknown) => error,
          )
          expect(error).toBeInstanceOf(Error)
          if (error instanceof Error) expect(error.message).toContain(invalid.message)
          const query = new URLSearchParams({
            cursor: invalid.input.cursor ?? "",
            ...("order" in invalid.input ? { order: invalid.input.order } : {}),
          })
          const response = await handler(
            new Request(`http://opencode.local/api/session/${session.id}/message?${query}`),
          )
          expect(response.status).toBe(400)
          expect(await response.json()).toMatchObject({ _tag: "InvalidCursorError", message: invalid.message })
        })
      }
      const controller = new AbortController()
      controller.abort(new Error("Already cancelled history read"))
      const cancelled = yield* Effect.tryPromise(() =>
        api.message.list({ sessionID: session.id }, { signal: controller.signal }),
      ).pipe(Effect.flip)
      expect(cancelled).toBeDefined()
      // A cancelled read leaves no mutation or lingering request blocking the next real read.
      expect(
        (yield* page({ sessionID: session.id, order: "asc", limit: 100 })).data.map((message) => message.id),
      ).toEqual(ids)
      expect(yield* sessions.messages({ sessionID: session.id, order: "asc", limit: 100 })).toEqual(history)
    }).pipe(Effect.timeout("5 seconds"), Effect.scoped),
)
