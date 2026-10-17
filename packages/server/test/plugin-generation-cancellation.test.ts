import { expect } from "bun:test"
import { Bus } from "@opencode/core/bus"
import { Config } from "@opencode/core/config"
import { Watcher } from "@opencode/core/filesystem/watcher"
import { Instance } from "@opencode/core/instance"
import { Location } from "@opencode/core/location"
import { ModelsDev } from "@opencode/core/models-dev"
import { Plugin } from "@opencode/core/plugin"
import { PluginPromise } from "@opencode/core/plugin/promise"
import { SdkPlugins } from "@opencode/core/plugin/sdk"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import type { SessionDomain } from "@opencode/plugin/promise/session"
import { Global } from "@opencode/util/global"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Context, Deferred, Effect, Layer } from "effect"
import { HttpServer } from "effect/http"
import { LanguageModel } from "../../ai/src"
import { OpenAIChat } from "../../ai/src/protocols/openai-chat"
import { deltaChunk, finishChunk, toolCallChunk } from "../../ai/test/lib/openai-chunks"
import { sseEvents } from "../../ai/test/lib/sse"
import { tempGlobalLayer } from "../../core/test/fixture/global"
import { tmpdirScoped } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { createEmbeddedRoutes } from "../src/routes"

it.live("public Promise generation unwraps objects and aborts a pending provider read before fork removal", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    const reading = yield* Deferred.make<void>()
    const aborted = yield* Deferred.make<void>()
    const ready = yield* Deferred.make<SessionDomain>()
    const plugin = PluginPromise.fromPromise({
      id: "public-generation-cancellation",
      setup(ctx) {
        Effect.runSync(Deferred.succeed(ready, ctx.session))
      },
    })
    let calls = 0
    let active = 0
    const provider = yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          async fetch(request) {
            await request.json()
            calls++
            if (calls === 1)
              return new Response(
                sseEvents(
                  toolCallChunk("call_result", "generate_object", '{"selected_memories":["memory-a"]}'),
                  finishChunk("tool_calls"),
                ),
                { headers: { "content-type": "text/event-stream" } },
              )
            active++
            return new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(
                    new TextEncoder().encode(`data: ${JSON.stringify(deltaChunk({ role: "assistant" }))}\n\n`),
                  )
                  Effect.runSync(Deferred.succeed(reading, undefined))
                },
                cancel() {
                  active--
                  Effect.runSync(Deferred.succeed(aborted, undefined))
                },
              }),
              { headers: { "content-type": "text/event-stream" } },
            )
          },
        }),
      ),
      (server) => Effect.promise(() => server.stop(true)),
    )
    const model = SessionRunnerModel.resolved(
      LanguageModel.make({
        id: "cancel-model",
        provider: "local-fixture",
        route: OpenAIChat.route.with({ endpoint: { baseURL: `${provider.url}v1/` } }),
      }),
      {
        capabilities: { tools: true, input: ["text"], output: ["text"] },
        cost: [],
        limit: { context: 200_000, output: 8192 },
      },
    )
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
        SessionRunnerModel.node.replace(
          Layer.succeed(SessionRunnerModel.Service, { resolve: () => Effect.succeed(model) }),
        ),
      ]).pipe(Layer.provide(HttpServer.layerServices)),
    )
    const sessions = Context.get(context, Session.Service)
    const instances = Context.get(context, Instance.Service)
    const bus = Context.get(context, Bus.Service)
    const parent = yield* sessions.create({
      location: Location.Ref.make({ directory: AbsolutePath.make(directory.path) }),
      model: model.ref,
    })
    const id = SessionMessage.ID.create()
    yield* sessions.prompt({ sessionID: parent.id, id, text: "Retained history", resume: false })
    yield* bus.publish(SessionEvent.InboxDelivered, { sessionID: parent.id, inboxID: id })
    const fork = yield* sessions.fork({ sessionID: parent.id })
    // The supervisor constructs the real PluginHost and invokes the Promise setup bridge.
    yield* Plugin.awaitActivation.pipe(instances.provide(fork))
    const api = yield* Deferred.await(ready)
    const input = {
      sessionID: fork.id,
      prompt: "Select memories without changing context",
      schema: {
        type: "object",
        properties: { selected_memories: { type: "array", items: { type: "string" } } },
        required: ["selected_memories"],
        additionalProperties: false,
      },
    }
    expect(yield* Effect.promise(() => api.generateObject(input))).toEqual({
      object: { selected_memories: ["memory-a"] },
    })
    const history = yield* sessions.context(fork.id)
    const parentHistory = yield* sessions.context(parent.id)
    const deadline = new AbortController()
    const pending = yield* Effect.sync(() =>
      api.generateObject(input, { signal: deadline.signal }).then(
        (result) => ({ result, error: undefined }),
        (error: unknown) => ({ result: undefined, error }),
      ),
    )
    yield* Deferred.await(reading)
    expect(active).toBe(1)
    deadline.abort(new Error("Selector deadline exceeded"))
    const outcome = yield* Effect.promise(() => pending)
    expect(outcome.result).toBeUndefined()
    expect(outcome.error).toBeDefined()
    yield* Deferred.await(aborted)
    expect(active).toBe(0)
    expect(calls).toBe(2)
    expect(yield* sessions.context(fork.id)).toEqual(history)
    yield* Effect.promise(() => api.remove({ sessionID: fork.id }))
    expect((yield* sessions.get(fork.id).pipe(Effect.flip))._tag).toBe("Session.NotFoundError")
    expect(active).toBe(0)
    expect(yield* sessions.context(parent.id)).toEqual(parentHistory)
  }).pipe(Effect.timeout("3 seconds"), Effect.scoped),
)
