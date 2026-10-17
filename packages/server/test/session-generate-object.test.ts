import { expect } from "bun:test"
import { LanguageModel, SystemPart } from "../../ai/src"
import { OpenAIChat } from "../../ai/src/protocols/openai-chat"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { Config } from "@opencode/core/config"
import { Database } from "@opencode/core/database/database"
import { EventTable } from "@opencode/core/event/sql"
import { Watcher } from "@opencode/core/filesystem/watcher"
import { Instance } from "@opencode/core/instance"
import { Location } from "@opencode/core/location"
import { ModelsDev } from "@opencode/core/models-dev"
import { Plugin } from "@opencode/core/plugin"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { Model } from "@opencode/schema/model"
import { SessionEvent } from "@opencode/core/session/event"
import { InstructionEntry } from "@opencode/core/session/instruction-entry"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import {
  InstructionBlobTable,
  InstructionStateTable,
  SessionInboxTable,
  SessionMessageTable,
  SessionTable,
} from "@opencode/core/session/sql"
import { Tool } from "@opencode/core/tool"
import { Global } from "@opencode/util/global"
import { Context, Effect, Layer, Schema } from "effect"
import { HttpEffect, HttpRouter, HttpServer } from "effect/http"
import { deltaChunk, finishChunk, toolCallChunk } from "../../ai/test/lib/openai-chunks"
import { sseEvents } from "../../ai/test/lib/sse"
import { tempGlobalLayer } from "../../core/test/fixture/global"
import { tmpdirScoped } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { createEmbeddedRoutes } from "../src/routes"

const Body = Schema.Struct({
  model: Schema.String,
  messages: Schema.Array(Schema.Json),
  tools: Schema.Array(Schema.Json),
  tool_choice: Schema.Json,
  temperature: Schema.optional(Schema.Number),
})
const schema = {
  type: "object",
  properties: { selected_memories: { type: "array", items: { type: "string" } } },
  required: ["selected_memories"],
  additionalProperties: false,
}

it.live("generates validated objects over HTTP using fork context and only the forced output tool", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    const requests: Array<{ body: typeof Body.Type; headers: Headers; path: string }> = []
    const outputs = [
      '{"selected_memories":["memory-a","memory-b"]}',
      '{"selected_memories":4}',
      "{}",
      '{"selected_memories":[4]}',
      '{"selected_memories":[],"extra":true}',
      "{broken",
      undefined,
    ]
    const provider = yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          async fetch(request) {
            requests.push({
              body: Schema.decodeUnknownSync(Body)(await request.json()),
              headers: request.headers,
              path: new URL(request.url).pathname,
            })
            const output = outputs[requests.length - 1]
            return new Response(
              output === undefined
                ? sseEvents(
                    deltaChunk({ role: "assistant", content: '{"selected_memories":["text-must-not-pass"]}' }),
                    finishChunk("stop"),
                  )
                : sseEvents(toolCallChunk("call_output", "generate_object", output), finishChunk("tool_calls")),
              { headers: { "content-type": "text/event-stream" } },
            )
          },
        }),
      ),
      (server) => Effect.promise(() => server.stop(true)),
    )
    const model = SessionRunnerModel.resolved(
      LanguageModel.make({
        id: "fork-model",
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
        SessionRunnerModel.node.replace(
          Layer.succeed(SessionRunnerModel.Service, {
            resolve: (session) => {
              expect(session.model).toMatchObject(model.ref)
              return Effect.succeed(model)
            },
          }),
        ),
      ]).pipe(Layer.provide(HttpServer.layerServices)),
    )
    const sessions = Context.get(context, Session.Service)
    const instances = Context.get(context, Instance.Service)
    const bus = Context.get(context, Bus.Service)
    const database = Context.get(context, Database.Service)
    const handler = Context.get(context, HttpRouter.HttpRouter)
      .asHttpEffect()
      .pipe(HttpEffect.toWebHandlerWith(context))
    const api = yield* Effect.acquireRelease(
      Effect.sync(() => Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => handler(request) })),
      (server) => Effect.promise(() => server.stop(true)),
    )
    const parent = yield* sessions.create({
      location: Location.Ref.make({ directory: AbsolutePath.make(directory.path) }),
      agent: Agent.ID.make("build"),
      model: model.ref,
    })
    const id = SessionMessage.ID.create()
    yield* sessions.prompt({ sessionID: parent.id, id, text: "Inherited settled context", resume: false })
    yield* bus.publish(SessionEvent.InboxDelivered, { sessionID: parent.id, inboxID: id })
    const fork = yield* sessions.fork({ sessionID: parent.id })
    yield* sessions.switchAgent({ sessionID: fork.id, agent: Agent.ID.make("memory-selector") })
    yield* sessions.switchModel({ sessionID: parent.id, model: { ...model.ref, id: Model.ID.make("parent-model") } })
    let generates = 0
    let contexts = 0
    let executed = 0
    yield* Effect.gen(function* () {
      yield* Plugin.awaitActivation
      const agents = yield* Agent.Service
      const hooks = yield* PluginHooks.Service
      const tools = yield* Tool.Service
      const entries = yield* InstructionEntry.Service
      yield* agents.transform((editor) => {
        editor.update(Agent.ID.make("build"), (agent) => {
          agent.system = "Parent system must not leak"
        })
        editor.update(Agent.ID.make("memory-selector"), (agent) => {
          agent.system = "Configured fork system"
        })
      })
      yield* entries.put({
        sessionID: fork.id,
        key: InstructionEntry.Key.make("fixture-context"),
        value: "Configured fork context",
      })
      yield* tools.transform((editor) =>
        editor.add({
          name: "must_not_execute",
          description: "Must never be advertised or executed for object generation",
          input: Schema.Struct({}),
          output: Schema.String,
          options: { codemode: false },
          execute: () =>
            Effect.sync(() => {
              executed++
              return { output: "leaked", content: "leaked" }
            }),
        }),
      )
      yield* hooks.register("session", "context", (event) =>
        Effect.sync(() => {
          contexts++
          event.system.push(SystemPart.make("Context hook system"))
        }),
      )
      yield* hooks.register("session", "generate", (event) =>
        Effect.sync(() => {
          expect(event.sessionID).toBe(fork.id)
          expect(event.agent).toBe(Agent.ID.make("memory-selector"))
          event.system.push(SystemPart.make("Generate hook system"))
          event.tools.trap = { description: "Hook-injected tool must not leak", input: { type: "object" } }
          event.options.temperature = 0.2
          generates++
        }),
      )
      yield* hooks.register("session", "model.request", (event) =>
        Effect.sync(() => {
          expect(event.kind).toBe("generate")
          event.headers["x-fixture-model-hook"] = "applied"
        }),
      )
      yield* hooks.register("session", "http.request", (event) =>
        Effect.sync(() => event.request.headers.set("x-fixture-http-hook", "applied")),
      )
    }).pipe(instances.provide(fork))
    const snapshot = () =>
      Effect.all({
        events: database.db.select().from(EventTable).all().pipe(Effect.orDie),
        sessions: database.db.select().from(SessionTable).all().pipe(Effect.orDie),
        messages: database.db.select().from(SessionMessageTable).all().pipe(Effect.orDie),
        inbox: database.db.select().from(SessionInboxTable).all().pipe(Effect.orDie),
        instructions: database.db.select().from(InstructionStateTable).all().pipe(Effect.orDie),
        blobs: database.db.select().from(InstructionBlobTable).all().pipe(Effect.orDie),
      })
    const before = yield* snapshot()
    const history = yield* sessions.context(fork.id)
    const post = (sessionID: string, body: unknown) =>
      Effect.promise(() =>
        fetch(new URL(`api/session/${sessionID}/generate-object`, api.url), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      )
    for (const [index] of outputs.entries()) {
      const response = yield* post(fork.id, { prompt: "Private structured request", schema })
      expect(response.status).toBe(index === 0 ? 200 : 503)
      const body: unknown = yield* Effect.promise(() => response.json())
      expect(body).toMatchObject(
        index === 0
          ? { data: { object: { selected_memories: ["memory-a", "memory-b"] } } }
          : { _tag: "ServiceUnavailableError" },
      )
      expect(yield* sessions.context(fork.id)).toEqual(history)
      expect(yield* snapshot()).toEqual(before)
    }
    expect(requests).toHaveLength(outputs.length)
    expect(generates).toBe(outputs.length)
    expect(contexts).toBe(outputs.length)
    expect(executed).toBe(0)
    for (const request of requests) {
      expect(request.path).toBe("/v1/chat/completions")
      expect(request.headers.get("x-fixture-model-hook")).toBe("applied")
      expect(request.headers.get("x-fixture-http-hook")).toBe("applied")
      expect(request.body.model).toBe("fork-model")
      expect(request.body.temperature).toBe(0.2)
      expect(request.body.tools).toEqual([
        expect.objectContaining({
          type: "function",
          function: expect.objectContaining({ name: "generate_object", parameters: schema }),
        }),
      ])
      expect(request.body.tool_choice).toEqual({ type: "function", function: { name: "generate_object" } })
      const messages = JSON.stringify(request.body.messages)
      expect(messages).not.toContain("Parent system must not leak")
      for (const text of [
        "Configured fork system",
        "Configured fork context",
        "Generate hook system",
        "Context hook system",
        "Inherited settled context",
        "Private structured request",
      ])
        expect(messages).toContain(text)
    }
    const missing = yield* post(Session.ID.create(), { prompt: "Missing", schema })
    expect(missing.status).toBe(404)
    const invalid = yield* post(fork.id, { prompt: "Invalid schema payload", schema: [] })
    expect(invalid.status).toBe(400)
    expect(requests).toHaveLength(outputs.length)
  }).pipe(Effect.scoped),
)
