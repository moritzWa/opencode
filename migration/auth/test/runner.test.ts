import { afterAll, expect } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { SubscriptionAuth } from "../src/auth.ts"
import { legacy } from "../src/legacy.ts"
import { gateway } from "../src/gateway.ts"
import { boundRetry, fallback } from "../src/policy.ts"
import { readFailure } from "../src/failure.ts"
import type { Recovery } from "../src/plugin.ts"

// The manager integrates the companion core commit before loading this artifact.
// The override lets the owning stream verify that same commit before cherry-pick.
const core = process.env.AUTH_RECOVERY_CORE_ROOT ?? fileURLToPath(new URL("../../../packages/core/", import.meta.url))
const { recoveryRunnerLayer } = await import(`${core}/test/fixture/recovery-runner.ts`)
const { testEffect } = await import(`${core}/test/lib/effect.ts`)
const { Effect } = await import(`${core}/node_modules/effect/dist/index.js`)
const { AnthropicMessages } = await import(`${core}/../ai/src/protocols/anthropic-messages.ts`)
const { Auth } = await import(`${core}/../ai/src/route.ts`)
const { Agent } = await import(`${core}/src/agent.ts`)
const { Database } = await import(`${core}/src/database/database.ts`)
const { Project } = await import(`${core}/src/project.ts`)
const { ProjectTable } = await import(`${core}/src/project/sql.ts`)
const { Session } = await import(`${core}/src/session.ts`)
const { SessionTable } = await import(`${core}/src/session/sql.ts`)
const { AbsolutePath } = await import(`${core}/src/schema.ts`)
const { Model } = await import(`${core}/src/model.ts`)
const { PluginHooks } = await import(`${core}/src/plugin/hooks.ts`)
const { SessionRunner } = await import(`${core}/src/session/runner/index.ts`)
const modules = await legacy(process.env.CLAUDE_AUTH_TEST_ROOT)
const cleanup: Array<() => void> = []
afterAll(() => cleanup.reverse().forEach((fn) => fn()))

for (const scenario of ["brief", "persistent", "quota"] as const) {
  const persistent = scenario === "persistent"
  const quota = scenario === "quota"
  const directory = mkdtempSync(join(tmpdir(), "auth-runner-"))
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }))
  const file = join(directory, "credentials.json")
  writeFileSync(file, JSON.stringify({ accessToken: "expired", refreshToken: "refresh-test-secret", expiresAt: quota ? 3600000 : 0 }))
  let refreshes = 0
  let claude = 0
  let sol = 0
  let elapsed = 0
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname === "/token") {
        refreshes++
        return persistent || refreshes === 1 ? Response.json({ error: "overloaded_error" }, { status: 503 }) : Response.json({ access_token: "fresh", refresh_token: "rotated", expires_in: 3600 })
      }
      if (new URL(request.url).pathname === "/v1/messages") {
        claude++
        if (quota) {
          const body = Bun.gzipSync(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "Synthetic subscription window rejected" } }))
          return new Response(body, { status: 429, headers: { "content-type": "application/json", "content-encoding": "gzip", "content-length": String(body.byteLength), "retry-after": "17", "anthropic-ratelimit-unified-5h-status": "rejected", "request-id": "synthetic-claude-quota" } })
        }
        const events = [
          { type: "message_start", message: { id: "msg_local", type: "message", role: "assistant", content: [], model: "claude-opus-5-5", usage: { input_tokens: 10, output_tokens: 0 } } },
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Stayed on Claude." } },
          { type: "content_block_stop", index: 0 },
          { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } },
          { type: "message_stop" },
        ]
        const body = Bun.gzipSync(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""))
        return new Response(body, { headers: { "content-type": "text/event-stream", "content-encoding": "gzip", "content-length": String(body.byteLength), "request-id": "synthetic-claude-success" } })
      }
      sol++
      const body = await request.json() as { model: string; messages: Array<{ content: unknown }> }
      expect(body.model).toBe("gpt-6.1-sol")
      expect(JSON.stringify(body.messages)).toContain("Complete outstanding request")
      return new Response(`data: ${JSON.stringify({ id: "sol", object: "chat.completion.chunk", created: 0, model: "gpt-6.1-sol", choices: [{ index: 0, delta: { content: "Continued on Sol." }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
    },
  })
  cleanup.push(() => server.stop(true))
  const origin = `http://127.0.0.1:${server.port}`
  const auth = new SubscriptionAuth({
    store: { read: async () => JSON.parse(readFileSync(file, "utf8")), write: async (next) => { writeFileSync(file, JSON.stringify(next)); return true } },
    tokenURL: `${origin}/token`, now: () => elapsed, sleep: async (ms) => { elapsed += ms },
  })
  const proxy = gateway({ auth, transport: modules.transport, upstream: origin })
  cleanup.push(() => { proxy.stop() })
  const primary = AnthropicMessages.route.with({ endpoint: { baseURL: proxy.url }, auth: Auth.none, headers: { "x-subscription-gateway": proxy.secret } }).model({ id: "claude-opus-5-5" })
  const it = testEffect(recoveryRunnerLayer(directory, `${origin}/v1`, primary))
  it.live(quota ? "compressed upstream 429 evidence survives actual Anthropic parser and once-only Sol recovery" : persistent ? "persistent refresh failure passes actual Anthropic parser and runner and resumes once on Sol" : "brief refresh failure stays Claude through compressed upstream SSE and actual Anthropic parser", () => Effect.gen(function* () {
    const sessionID = Session.ID.make(`ses_auth_${scenario}`)
    const db = (yield* Database.Service).db
    const agents = yield* Agent.Service
    const hooks = yield* PluginHooks.Service
    const sessions = yield* Session.Service
    const runner = yield* SessionRunner.Service
    yield* agents.transform((editor: { update(id: string, update: (agent: { mode: string }) => void): void }) => editor.update(Agent.ID.make("build"), (agent) => { agent.mode = "primary" }))
    yield* db.insert(ProjectTable).values({ id: Project.ID.global, worktree: AbsolutePath.make(directory), sandboxes: [] }).onConflictDoNothing().run().pipe(Effect.orDie)
    yield* db.insert(SessionTable).values({ id: sessionID, project_id: Project.ID.global, slug: sessionID, directory, title: "Auth fault", version: "test" }).run().pipe(Effect.orDie)
    let recoveries = 0
    let responses = 0
    yield* hooks.register("session", "http.response", (event: { response: Response; model: { id: string } }) => Effect.sync(() => {
      if (event.model.id !== "claude-opus-5-5") return
      responses++
      expect(event.response.headers.has("content-encoding")).toBe(false)
      if (quota) {
        expect(event.response.headers.get("retry-after")).toBe("17")
        expect(event.response.headers.get("request-id")).toBe("synthetic-claude-quota")
      }
    }))
    yield* hooks.register("session", "retry", (event: Parameters<typeof boundRetry>[0]) => Effect.sync(() => boundRetry(event)))
    yield* hooks.register("session", "recovery", (event: Recovery) => Effect.sync(() => {
      const detail = readFailure(event.error)
      expect(detail?.category).toBe(quota ? "model_quota" : "refresh_server")
      expect(detail?.status).toBe(quota ? 429 : 503)
      if (quota) {
        expect(detail?.reason).toBe("rate_limit_error")
        expect(detail?.quotaWindow).toBe("5h")
        expect(detail?.retryAfterMs).toBe(17000)
      }
      if (!detail) return
      const model = fallback({ failure: detail, failed: event.model, directory, available: [{ providerID: "openai", id: "gpt-6.1-sol" }] })
      if (!model) return
      recoveries++
      event.decision = { model: Model.Ref.parse(`${model.providerID}/${model.id}`), reason: detail.category }
    }))
    yield* sessions.prompt({ sessionID, text: "Complete outstanding request", resume: false })
    yield* runner.drain({ sessionID, force: false })
    expect(recoveries).toBe(persistent || quota ? 1 : 0)
    expect(claude).toBe(persistent ? 0 : 1)
    expect(sol).toBe(persistent || quota ? 1 : 0)
    expect(elapsed).toBe(quota ? 0 : persistent ? 75000 : 1000)
    expect(refreshes).toBe(quota ? 0 : persistent ? 8 : 2)
    expect(responses).toBe(1)
  }))
}
