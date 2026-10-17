import { afterAll, expect } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Agent } from "@opencode/core/agent"
import { Database } from "@opencode/core/database/database"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { Session } from "@opencode/core/session"
import { SessionStore } from "@opencode/core/session/store"
import { SessionTable } from "@opencode/core/session/sql"
import { AbsolutePath } from "@opencode/core/schema"
import { Model } from "@opencode/schema/model"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { SessionRunner } from "@opencode/core/session/runner/index"
import { WriteTool } from "@opencode/core/tool/plugin/write"
import { Tool } from "@opencode/core/tool"
import { Effect, Deferred, Fiber, Exit, Layer } from "effect"
import { testEffect } from "./lib/effect"
import { recoveryRunnerLayer } from "./fixture/recovery-runner"
import { host } from "./plugin/host"

const directory = mkdtempSync(join(tmpdir(), "runner-recovery-"))
const requests: Array<{ model: string; messages: Array<{ role: string; content?: unknown }> }> = []
let failFallback = false
let withTool = false
let fallbackEntered: (() => void) | undefined
let fallbackRelease: Promise<void> | undefined
const server = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  async fetch(request) {
    const body = await request.json() as typeof requests[number]
    requests.push(body)
    if (body.model === "claude-subscription" && withTool && !body.messages.some((message) => message.role === "tool")) {
      return stream({ delta: { tool_calls: [{ index: 0, id: "call_write", type: "function", function: { name: "write", arguments: JSON.stringify({ path: "completed.txt", content: "completed once" }) } }] }, finish_reason: "tool_calls" })
    }
    if (body.model === "claude-subscription" || failFallback) return Response.json({ error: { type: "subscription.refresh_server", message: "upstream refresh unavailable" }, subscription: { category: "refresh_server", status: 503, reason: "overloaded_error", exhausted: true } }, { status: 503 })
    if (fallbackRelease) { fallbackEntered?.(); await fallbackRelease }
    return stream({ delta: { content: "Resumed outstanding request." }, finish_reason: "stop" })
  },
})
function stream(choice: object) {
  return new Response(`data: ${JSON.stringify({ id: "response", object: "chat.completion.chunk", created: 0, model: "fixture", choices: [{ index: 0, ...choice }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
}

afterAll(() => { server.stop(true); rmSync(directory, { recursive: true, force: true }) })
const it = testEffect(recoveryRunnerLayer(directory, `http://127.0.0.1:${server.port}/v1`))

function setup(id: string) {
  return Effect.gen(function* () {
    const sessionID = Session.ID.make(id)
    const db = (yield* Database.Service).db
    const agents = yield* Agent.Service
    const hooks = yield* PluginHooks.Service
    const session = yield* Session.Service
    const runner = yield* SessionRunner.Service
    const store = yield* SessionStore.Service
    yield* agents.transform((editor) => editor.update(Agent.ID.make("build"), (agent) => { agent.mode = "primary" }))
    yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make(directory), sandboxes: [] }).onConflictDoNothing().run().pipe(Effect.orDie)
    yield* db.insert(SessionTable).values({ id: sessionID, project_id: Project.ID.global, slug: id, directory, title: "recovery", version: "test" }).onConflictDoNothing().run().pipe(Effect.orDie)
    yield* hooks.register("session", "retry", (event) => Effect.sync(() => { event.decision = { retry: false } }))
    return { sessionID, hooks, session, runner, store }
  })
}

it.live("actual HTTP failure switches once and keeps completed production write tool in durable history", () => Effect.gen(function* () {
  requests.length = 0; failFallback = false; withTool = true
  const state = yield* setup("ses_recovery_tools")
  const registry = yield* Tool.Service
  yield* WriteTool.Plugin.effect(host({ tool: { ...host().tool, transform: registry.transform } }))
  let recoveries = 0
  yield* state.hooks.register("session", "recovery", (event) => Effect.sync(() => {
    recoveries++
    event.decision = { model: Model.Ref.parse("openai/gpt-6.1-sol"), reason: "refresh_server" }
  }))
  yield* state.session.prompt({ sessionID: state.sessionID, text: "Write completed.txt then finish", resume: false })
  yield* state.runner.drain({ sessionID: state.sessionID, force: false })
  expect(recoveries).toBe(1)
  expect(requests.filter((request) => request.model === "gpt-6.1-sol")).toHaveLength(1)
  const fallbackRequest = requests.find((request) => request.model === "gpt-6.1-sol")
  expect(fallbackRequest?.messages.some((message) => message.role === "tool")).toBe(true)
  expect(yield* Effect.promise(() => Bun.file(join(directory, "completed.txt")).text())).toBe("completed once")
  const history = yield* state.store.context(state.sessionID)
  expect(history.flatMap((message) => message.type === "assistant" ? message.content.filter((part) => part.type === "tool" && part.name === "write" && part.state.status === "completed") : [])).toHaveLength(1)
  // An idle wake cannot reissue a completed request.
  yield* state.runner.drain({ sessionID: state.sessionID, force: false })
  expect(requests.filter((request) => request.model === "gpt-6.1-sol")).toHaveLength(1)
}))

it.live("persistent fallback failure ends clearly with one durable recovery per input across forced restart", () => Effect.gen(function* () {
  requests.length = 0; failFallback = true; withTool = false
  const state = yield* setup("ses_recovery_failure")
  let recoveries = 0
  yield* state.hooks.register("session", "recovery", (event) => Effect.sync(() => { recoveries++; event.decision = { model: Model.Ref.parse("openai/gpt-6.1-sol"), reason: "refresh_server" } }))
  yield* state.session.prompt({ sessionID: state.sessionID, text: "Outstanding request", resume: false })
  const first = yield* state.runner.drain({ sessionID: state.sessionID, force: false }).pipe(Effect.exit)
  expect(Exit.isFailure(first)).toBe(true)
  expect(recoveries).toBe(1)
  const history = yield* state.store.context(state.sessionID)
  expect(history.filter((message) => message.type === "synthetic" && message.metadata?.recovery)).toHaveLength(1)
  const last = history.findLast((message) => message.type === "assistant")
  expect(last?.type === "assistant" && last.error?.message).toContain("upstream refresh unavailable")
  // A new drain reads the persisted marker, rather than in-memory handled sets.
  yield* state.runner.drain({ sessionID: state.sessionID, force: true }).pipe(Effect.exit)
  expect(recoveries).toBe(1)
}))

it.live("user interruption during recovery policy cannot revive the cancelled request", () => Effect.gen(function* () {
  requests.length = 0; failFallback = false; withTool = false
  const state = yield* setup("ses_recovery_aborted")
  const entered = yield* Deferred.make<void>()
  const release = yield* Deferred.make<void>()
  yield* state.hooks.register("session", "recovery", (event) => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.andThen(Effect.sync(() => { event.decision = { model: Model.Ref.parse("openai/gpt-6.1-sol"), reason: "refresh_server" } }))))
  yield* state.session.prompt({ sessionID: state.sessionID, text: "Cancel this", resume: false })
  const fiber = yield* state.runner.drain({ sessionID: state.sessionID, force: false }).pipe(Effect.forkChild)
  yield* Deferred.await(entered)
  yield* Fiber.interrupt(fiber)
  expect(requests.some((request) => request.model === "gpt-6.1-sol")).toBe(false)
  const history = yield* state.store.context(state.sessionID)
  expect(history.some((message) => message.type === "synthetic" && message.metadata?.recovery)).toBe(false)
}))

it.live("concurrent sessions each recover once without a global handled flag", () => Effect.gen(function* () {
  requests.length = 0; failFallback = false; withTool = false
  const first = yield* setup("ses_recovery_concurrent_a")
  const second = yield* setup("ses_recovery_concurrent_b")
  const recovered: string[] = []
  yield* first.hooks.register("session", "recovery", (event) => Effect.sync(() => {
    recovered.push(event.sessionID)
    event.decision = { model: Model.Ref.parse("openai/gpt-6.1-sol"), reason: "refresh_server" }
  }))
  yield* first.session.prompt({ sessionID: first.sessionID, text: "First", resume: false })
  yield* second.session.prompt({ sessionID: second.sessionID, text: "Second", resume: false })
  yield* Effect.all([first.runner.drain({ sessionID: first.sessionID, force: false }), second.runner.drain({ sessionID: second.sessionID, force: false })], { concurrency: "unbounded" })
  expect(recovered.sort()).toEqual([first.sessionID, second.sessionID].sort())
  expect(requests.filter((request) => request.model === "gpt-6.1-sol")).toHaveLength(2)
}))

it.live("restart reopens persisted runner state after recovery commit without losing or duplicating recovery", () => Effect.gen(function* () {
  requests.length = 0; failFallback = false; withTool = true
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  fallbackEntered = entered.resolve
  fallbackRelease = release.promise
  const database = join(directory, "restart.sqlite")
  let recoveries = 0
  yield* Effect.gen(function* () {
    const state = yield* setup("ses_recovery_restart")
    const registry = yield* Tool.Service
    yield* WriteTool.Plugin.effect(host({ tool: { ...host().tool, transform: registry.transform } }))
    yield* state.hooks.register("session", "recovery", (event) => Effect.sync(() => { recoveries++; event.decision = { model: Model.Ref.parse("openai/gpt-6.1-sol"), reason: "refresh_server" } }))
    yield* state.session.prompt({ sessionID: state.sessionID, text: "Finish across shutdown", resume: false })
    const fiber = yield* state.runner.drain({ sessionID: state.sessionID, force: false }).pipe(Effect.forkChild)
    // The fallback HTTP request can only arrive after the atomic model+marker commit.
    yield* Effect.promise(() => entered.promise)
    yield* Fiber.interrupt(fiber)
  }).pipe(Effect.provide(Layer.fresh(recoveryRunnerLayer(directory, `http://127.0.0.1:${server.port}/v1`, undefined, database))))
  fallbackRelease = undefined
  fallbackEntered = undefined
  release.resolve()
  yield* Effect.gen(function* () {
    const state = yield* setup("ses_recovery_restart")
    yield* state.hooks.register("session", "recovery", () => Effect.sync(() => { recoveries++ }))
    yield* state.runner.drain({ sessionID: state.sessionID, force: true })
    const history = yield* state.store.context(state.sessionID)
    expect(history.filter((message) => message.type === "synthetic" && message.metadata?.recovery)).toHaveLength(1)
    expect(history.flatMap((message) => message.type === "assistant" ? message.content.filter((part) => part.type === "tool" && part.name === "write" && part.state.status === "completed") : [])).toHaveLength(1)
    expect(recoveries).toBe(1)
    const last = history.findLast((message) => message.type === "assistant")
    expect(last?.type === "assistant" && last.finish).toBe("stop")
  }).pipe(Effect.provide(Layer.fresh(recoveryRunnerLayer(directory, `http://127.0.0.1:${server.port}/v1`, undefined, database))))
}))
