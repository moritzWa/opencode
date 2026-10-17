import { expect } from "bun:test"
import { join } from "node:path"
import { Bus } from "@opencode/core/bus"
import { Config } from "@opencode/core/config"
import { Watcher } from "@opencode/core/filesystem/watcher"
import { Location } from "@opencode/core/location"
import { ModelsDev } from "@opencode/core/models-dev"
import { SdkPlugins } from "@opencode/core/plugin/sdk"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { Document, Info } from "@opencode/schema/config"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { Global } from "@opencode/util/global"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Context, Deferred, Effect, Fiber, Layer, Schema, Stream } from "effect"
import { HttpServer } from "effect/http"
import { LanguageModel } from "../../ai/src"
import { OpenAIChat } from "../../ai/src/protocols/openai-chat"
import { deltaChunk, finishChunk, toolCallChunk } from "../../ai/test/lib/openai-chunks"
import { sseEvents } from "../../ai/test/lib/sse"
import { tempGlobalLayer } from "../../core/test/fixture/global"
import { tmpdirScoped } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { createEmbeddedRoutes } from "../src/routes"

const RequestBody = Schema.Struct({
  model: Schema.String,
  messages: Schema.Array(Schema.Struct({ role: Schema.String, content: Schema.optionalKey(Schema.Unknown) })),
})

// Only model inventory and policy are fixtures. Execution, foreground jobs, tools,
// parser, durable history, and cancellation all use the embedded production graph.
function scenario(interrupt?: "parent" | "child") {
  return Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    const entered = yield* Deferred.make<Session.ID>()
    const release = Promise.withResolvers<void>()
    const policyFinished = Promise.withResolvers<void>()
    const executionReady = yield* Deferred.make<SessionExecution.Interface>()
    const requests: Array<typeof RequestBody.Type> = []
    const recoveries: Session.ID[] = []
    const writes: Session.ID[] = []
    const provider = yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          async fetch(request) {
            const body = Schema.decodeUnknownSync(RequestBody)(await request.json())
            requests.push(body)
            const completed = body.messages.some((message) => message.role === "tool")
            if (body.model === "claude-subscription" && completed)
              return Response.json(
                {
                  error: { type: "subscription.refresh_server", message: "upstream refresh unavailable" },
                  subscription: {
                    category: "refresh_server",
                    status: 503,
                    reason: "overloaded_error",
                    exhausted: true,
                  },
                },
                { status: 503 },
              )
            const chunks =
              body.model === "parent-control" && !completed
                ? sseEvents(
                    toolCallChunk(
                      "call_child",
                      "subagent",
                      JSON.stringify({
                        agent: "recovery-child",
                        description: "Recover child request",
                        prompt: "Write completed.txt then answer",
                        background: false,
                      }),
                    ),
                    finishChunk("tool_calls"),
                  )
                : body.model === "claude-subscription"
                  ? sseEvents(
                      toolCallChunk("call_write", "write", '{"path":"completed.txt","content":"completed once"}'),
                      finishChunk("tool_calls"),
                    )
                  : sseEvents(deltaChunk({ content: "Completed outstanding request." }), finishChunk("stop"))
            return new Response(chunks, { headers: { "content-type": "text/event-stream" } })
          },
        }),
      ),
      (server) => Effect.promise(() => server.stop(true)),
    )
    const context = yield* Layer.build(
      createEmbeddedRoutes({ events: { persist: true } }, [
        Global.node.replace(tempGlobalLayer),
        Config.node.replace(
          Config.testLayer([
            new Document({
              type: "document",
              info: new Info({
                snapshots: false,
                permissions: [{ action: "*", resource: "*", effect: "allow" }],
                agents: {
                  "recovery-child": {
                    mode: "subagent",
                    model: { providerID: Provider.ID.make("openai"), model: Model.ID.make("claude-subscription") },
                  },
                },
              }),
            }),
          ]),
        ),
        ModelsDev.node.replace(ModelsDev.configured({ fetch: false })),
        Watcher.node.replace(Watcher.configured({ enabled: false })),
        SdkPlugins.node.replace(
          makeGlobalNode({
            service: SdkPlugins.Service,
            deps: [Bus.node, SessionExecution.node],
            layer: Layer.effect(
              SdkPlugins.Service,
              Effect.gen(function* () {
                const plugins = yield* SdkPlugins.Service
                const execution = yield* SessionExecution.Service
                yield* Deferred.succeed(executionReady, execution)
                yield* plugins.register({
                  id: "child-recovery-policy",
                  effect: Effect.fn(function* (ctx) {
                    // Auxiliary title requests must not consume a scripted primary response.
                    yield* ctx.session.hook("title", (event) =>
                      Effect.sync(() => {
                        event.result = "Child recovery fixture"
                      }),
                    )
                    yield* ctx.session.hook("retry", (event) =>
                      Effect.sync(() => {
                        event.decision = { retry: false }
                      }),
                    )
                    yield* ctx.tool.hook("execute.after", (event) =>
                      Effect.sync(() => {
                        if (event.tool === "write" && event.status === "completed") writes.push(event.sessionID)
                      }),
                    )
                    yield* ctx.session.hook("recovery", (event) =>
                      Effect.promise(async () => {
                        recoveries.push(event.sessionID)
                        expect(event.model).toEqual(Model.Ref.parse("openai/claude-subscription"))
                        expect(event.error.message).toContain("upstream refresh unavailable")
                        Effect.runSync(Deferred.succeed(entered, event.sessionID))
                        if (interrupt) await release.promise
                        event.decision = { model: Model.Ref.parse("openai/gpt-6.1-sol"), reason: "refresh_server" }
                        policyFinished.resolve()
                      }),
                    )
                  }),
                })
                return plugins
              }),
            ).pipe(Layer.provide(SdkPlugins.layer)),
          }),
        ),
        SessionRunnerModel.node.replace(
          Layer.succeed(SessionRunnerModel.Service, {
            resolve: (session) =>
              Effect.succeed(
                SessionRunnerModel.resolved(
                  LanguageModel.make({
                    id: session.model?.id ?? "parent-control",
                    provider: "openai",
                    route: OpenAIChat.route.with({ endpoint: { baseURL: `${provider.url}v1/` } }),
                  }),
                  {
                    capabilities: { tools: true, input: ["text"], output: ["text"] },
                    cost: [],
                    limit: { context: 200_000, output: 8192 },
                  },
                ),
              ),
          }),
        ),
      ]).pipe(Layer.provide(HttpServer.layerServices)),
    )
    const sessions = Context.get(context, Session.Service)
    const execution = yield* Deferred.await(executionReady)
    const bus = Context.get(context, Bus.Service)
    const parent = yield* sessions.create({
      location: Location.Ref.make({ directory: AbsolutePath.make(directory.path) }),
      model: Model.Ref.parse("openai/parent-control"),
      title: "Foreground child recovery",
    })
    yield* sessions.prompt({ sessionID: parent.id, text: "Run the foreground child and report back", resume: false })
    const running = yield* execution.resume(parent.id).pipe(Effect.exit, Effect.forkChild)
    const childID = yield* Deferred.await(entered)
    expect(childID).not.toBe(parent.id)
    expect((yield* sessions.get(childID)).parentID).toBe(parent.id)
    if (interrupt) {
      expect(yield* execution.isActive(parent.id)).toBe(true)
      expect(yield* execution.isActive(childID)).toBe(true)
      expect(yield* execution.interrupt(interrupt === "parent" ? parent.id : childID, { awaitSettlement: true })).toBe(
        true,
      )
      // Release only after production interruption has settled. Policy cannot revive the child.
      release.resolve()
      yield* Effect.promise(() => policyFinished.promise)
    }
    yield* Fiber.join(running)
    yield* execution.awaitIdle(parent.id)
    yield* execution.awaitIdle(childID)
    expect(yield* execution.isActive(parent.id)).toBe(false)
    expect(yield* execution.isActive(childID)).toBe(false)
    expect(recoveries).toEqual([childID])
    expect(writes).toEqual([childID])
    expect(yield* Effect.promise(() => Bun.file(join(directory.path, "completed.txt")).text())).toBe("completed once")
    const history = yield* sessions.context(childID)
    expect(
      history.flatMap((message) =>
        message.type === "assistant"
          ? message.content.filter(
              (part) => part.type === "tool" && part.name === "write" && part.state.status === "completed",
            )
          : [],
      ),
    ).toHaveLength(1)
    expect(history.filter((message) => message.type === "synthetic" && message.metadata?.recovery)).toHaveLength(
      interrupt ? 0 : 1,
    )
    const events = yield* bus.log({ aggregateID: childID, follow: false }).pipe(Stream.runCollect)
    expect(events.filter((event) => event.type === SessionEvent.ModelSelected.type)).toHaveLength(interrupt ? 0 : 1)
    expect((yield* sessions.get(parent.id)).model).toEqual(parent.model)
    expect((yield* sessions.get(childID)).model).toMatchObject(
      Model.Ref.parse(interrupt ? "openai/claude-subscription" : "openai/gpt-6.1-sol"),
    )
    expect(requests.filter((request) => request.model === "claude-subscription")).toHaveLength(2)
    const fallback = requests.filter((request) => request.model === "gpt-6.1-sol")
    expect(fallback).toHaveLength(interrupt ? 0 : 1)
    if (interrupt === "parent") expect(requests.filter((request) => request.model === "parent-control")).toHaveLength(1)
    if (!interrupt) {
      expect(fallback[0]?.messages.filter((message) => message.role === "tool")).toHaveLength(1)
      expect(JSON.stringify(fallback[0]?.messages)).toContain("Created file successfully: completed.txt")
      expect(history.findLast((message) => message.type === "assistant")?.finish).toBe("stop")
      const parentHistory = yield* sessions.context(parent.id)
      expect(
        parentHistory.flatMap((message) =>
          message.type === "assistant"
            ? message.content.filter(
                (part) => part.type === "tool" && part.name === "subagent" && part.state.status === "completed",
              )
            : [],
        ),
      ).toHaveLength(1)
      expect(JSON.stringify(parentHistory)).toContain("Completed outstanding request.")
      expect(parentHistory.findLast((message) => message.type === "assistant")?.finish).toBe("stop")
      expect(requests.filter((request) => request.model === "parent-control")).toHaveLength(2)
    }
    // An ordinary idle wake cannot duplicate recovery or re-execute the completed write.
    const count = requests.length
    yield* execution.wake(childID)
    yield* execution.awaitIdle(childID)
    expect(requests).toHaveLength(count)
    expect(writes).toEqual([childID])
  }).pipe(Effect.timeout("10 seconds"), Effect.scoped)
}

it.live(
  "foreground child recovers one real HTTP failure on Sol and retains its completed production write",
  () => scenario(),
  { timeout: 15_000 },
)

for (const target of ["parent", "child"] as const)
  it.live(
    `interrupting the ${target} production execution while child recovery awaits policy prevents revival`,
    () => scenario(target),
    { timeout: 15_000 },
  )
