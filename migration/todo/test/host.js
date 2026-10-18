// Real SDK supervisor -> Promise adapter -> native PluginHost, SQLite KV and
// embedded public HTTP router. There is no Map-backed storage or tool capture.
import { Context, Deferred, Effect, Layer } from "effect"
import { HttpEffect, HttpRouter, HttpServer } from "effect/http"
import { Bus } from "../../../packages/core/src/bus.ts"
import { Config } from "../../../packages/core/src/config.ts"
import { Instance } from "../../../packages/core/src/instance.ts"
import { Location } from "../../../packages/core/src/location.ts"
import { ModelsDev } from "../../../packages/core/src/models-dev.ts"
import { Plugin } from "../../../packages/core/src/plugin.ts"
import { PluginPromise } from "../../../packages/core/src/plugin/promise.ts"
import { SdkPlugins } from "../../../packages/core/src/plugin/sdk.ts"
import { AbsolutePath } from "../../../packages/core/src/schema.ts"
import { Session } from "../../../packages/core/src/session.ts"
import { Tool } from "../../../packages/core/src/tool.ts"
import { Watcher } from "../../../packages/core/src/filesystem/watcher.ts"
import { Global } from "../../../packages/util/src/global.ts"
import { makeGlobalNode } from "../../../packages/util/src/effect/app-node.ts"
import { OpenCode } from "../../../packages/client/src/promise/client.ts"
import { tempGlobalLayer } from "../../../packages/core/test/fixture/global.ts"
import { createEmbeddedRoutes } from "../../../packages/server/src/routes.ts"
import plugin from "../server.js"
import { TodoRpc } from "../rpc.js"

export const openHost = Effect.fn(function* (directory, options = {}, definition = plugin) {
  const ready = yield* Deferred.make()
  const context = yield* Layer.build(
    createEmbeddedRoutes({ database: { path: `${directory}/todo-host.sqlite` } }, [
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
              yield* plugins.register(
                PluginPromise.fromPromise({
                  ...definition,
                  async setup(ctx) {
                    const cleanup = await definition.setup({ ...ctx, options: { ...ctx.options, ...options } })
                    Effect.runSync(Deferred.succeed(ready, ctx))
                    return cleanup
                  },
                }),
              )
              return plugins
            }),
          ).pipe(Layer.provide(SdkPlugins.layer)),
        }),
      ),
    ]).pipe(Layer.provide(HttpServer.layerServices)),
  )
  const sessions = Context.get(context, Session.Service)
  const instances = Context.get(context, Instance.Service)
  const handler = Context.get(context, HttpRouter.HttpRouter).asHttpEffect().pipe(HttpEffect.toWebHandlerWith(context))
  const activate = Effect.fn(function* (session) {
    yield* Plugin.awaitActivation.pipe(instances.provide(session))
    return yield* Deferred.await(ready)
  })
  const create = Effect.fn(function* (providerID = "openai") {
    const session = yield* sessions.create({
      location: Location.Ref.make({ directory: AbsolutePath.make(directory) }),
      model: { providerID, id: "todo-fixture-no-network" },
    })
    yield* activate(session)
    return session
  })
  const call = Effect.fn(function* (session, name, input) {
    const tools = yield* Tool.Service.pipe(instances.provide(session))
    const snapshot = yield* tools.snapshot()
    return yield* snapshot.execute({
      sessionID: session.id,
      agent: "build",
      messageID: "msg_todo_fixture",
      call: { id: "call_todo_fixture", name, input },
    })
  })
  const requests = []
  const client = () =>
    OpenCode.make({
      baseUrl: "http://opencode.local",
      fetch: (input, init) => {
        const request = new Request(input, init)
        requests.push({ method: request.method, path: new URL(request.url).pathname })
        return handler(request)
      },
    })
  // Wait for the real SSE handshake, not a sleep, before sending mutations.
  const connect = Effect.fn(function* () {
    const api = client()
    const controller = new AbortController()
    const events = api.event.subscribe({ signal: controller.signal })[Symbol.asyncIterator]()
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        controller.abort()
        await events.return()
      }),
    )
    const first = yield* Effect.promise(() => events.next())
    if (first.done || first.value.type !== "server.connected") throw new Error("Missing public SSE handshake")
    return {
      api,
      rpc: api.rpc(TodoRpc),
      close: async () => {
        controller.abort()
        await events.return()
      },
    }
  })
  return {
    sessions,
    instances,
    handler,
    create,
    activate,
    call,
    client,
    connect,
    requests,
    rpcOptions: { location: { directory } },
  }
})
