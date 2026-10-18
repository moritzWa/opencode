import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SubscriptionAuth } from "../src/auth.ts"
import { ClaudeFailure, classify, readFailure, retryAfter } from "../src/failure.ts"
import { Diagnostics } from "../src/diagnostics.ts"
import { fallback, isWork } from "../src/policy.ts"
import { legacy } from "../src/legacy.ts"
import { gateway } from "../src/gateway.ts"

const cleanup: Array<() => void> = []
afterEach(() => cleanup.splice(0).reverse().forEach((fn) => fn()))
function store() {
  const directory = mkdtempSync(join(tmpdir(), "subscription-auth-"))
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }))
  const file = join(directory, "credential.json")
  writeFileSync(file, JSON.stringify({ accessToken: "expired-access-secret", refreshToken: "refresh-secret", expiresAt: 0 }))
  return { directory, read: async () => JSON.parse(readFileSync(file, "utf8")), write: async (next: object) => { writeFileSync(file, JSON.stringify(next)); return true } }
}
function endpoint(handle: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: handle })
  cleanup.push(() => server.stop(true))
  return `http://127.0.0.1:${server.port}`
}
const signal = () => new AbortController().signal
const available = [{ providerID: "openai", id: "gpt-6.1-sol" }, { providerID: "cursor", id: "claude-opus-5-5-1m" }]

describe("subscription auth over real HTTP", () => {
  test("brief 503 recovers Claude, preserving status and upstream reason", async () => {
    const disk = store()
    const diagnostics = new Diagnostics(join(disk.directory, "events.sqlite"))
    cleanup.push(() => diagnostics.close())
    let calls = 0
    let now = 0
    const tokenURL = endpoint(async (request) => {
      expect((await request.formData()).get("refresh_token")).toBe("refresh-secret")
      calls++
      return calls === 1 ? Response.json({ error: "overloaded_error" }, { status: 503, headers: { "retry-after": "2" } }) : Response.json({ access_token: "new-access-secret", refresh_token: "new-refresh-secret", expires_in: 3600 })
    })
    const auth = new SubscriptionAuth({ store: disk, tokenURL, diagnostics, now: () => now, sleep: async (ms) => { now += ms } })
    expect((await auth.credentials(signal())).accessToken).toBe("new-access-secret")
    expect(calls).toBe(2)
    expect(diagnostics.db.query("SELECT category,status,reason,retry_after_ms,action FROM diagnostic ORDER BY id LIMIT 1").get()).toEqual({ category: "refresh_server", status: 503, reason: "overloaded_error", retry_after_ms: 2000, action: "retry_claude" })
    expect(JSON.stringify(diagnostics.db.query("SELECT * FROM diagnostic").all())).not.toContain("secret")
  })

  test.each([429, 503, 401])("persistent HTTP %s has accurate classification and bounded attempts", async (status) => {
    const disk = store()
    let calls = 0
    let now = 0
    const tokenURL = endpoint(() => { calls++; return Response.json({ error: status === 401 ? "invalid_grant" : "rate_limit_error" }, { status, headers: { "retry-after": "120" } }) })
    const auth = new SubscriptionAuth({ store: disk, tokenURL, budgetMs: 75000, now: () => now, sleep: async (ms) => { now += ms } })
    const error = await auth.credentials(signal()).catch((error: unknown) => error)
    expect(error).toBeInstanceOf(ClaudeFailure)
    if (!(error instanceof ClaudeFailure)) throw error
    expect(error.detail.category).toBe(status === 429 ? "refresh_throttle" : status === 503 ? "refresh_server" : "refresh_revoked")
    expect(error.detail.status).toBe(status)
    expect(error.detail.retryAfterMs).toBe(120000)
    expect(error.detail.exhausted).toBe(true)
    expect(calls).toBe(1)
    expect(fallback({ failure: error.detail, failed: { providerID: "anthropic", id: "claude-opus-5-5" }, available })).toEqual(available[0])
  })

  test("network failure is never quota or refresh throttle", async () => {
    const disk = store()
    const auth = new SubscriptionAuth({ store: disk, tokenURL: "http://127.0.0.1:1", budgetMs: 0 })
    // A real connection refusal, with no fabricated status.
    const failing = new SubscriptionAuth({ ...auth.options, budgetMs: 20, maxAttempts: 1, sleep: async () => {} })
    const error = await failing.credentials(signal()).catch((error: unknown) => error)
    expect(error).toBeInstanceOf(ClaudeFailure)
    if (!(error instanceof ClaudeFailure)) throw error
    expect(error.detail.category).toBe("refresh_network")
    expect(error.detail.status).toBeUndefined()
  })

  test("concurrent callers share refresh but cancellation does not cancel another thread", async () => {
    const disk = store()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let calls = 0
    const tokenURL = endpoint(async () => { calls++; entered.resolve(); await release.promise; return Response.json({ access_token: "new", expires_in: 3600 }) })
    const auth = new SubscriptionAuth({ store: disk, tokenURL })
    const cancelled = new AbortController()
    const first = auth.credentials(cancelled.signal).catch((error: unknown) => error)
    const second = auth.credentials(signal())
    await entered.promise
    cancelled.abort(new DOMException("Cancelled", "AbortError"))
    expect(await first).toBeInstanceOf(DOMException)
    release.resolve()
    expect((await second).accessToken).toBe("new")
    expect(calls).toBe(1)
  })

  test("diagnostics rotates and survives a new process connection", () => {
    const disk = store()
    const file = join(disk.directory, "events.sqlite")
    const diagnostics = new Diagnostics(file, 3)
    for (let i = 0; i < 10; i++) diagnostics.record({ category: "refresh_network", reason: "connection_failed" }, "retry_claude")
    diagnostics.record({ category: "refresh_network", reason: "upstream reflected refresh-secret" }, "stop")
    expect(JSON.stringify(diagnostics.db.query("SELECT * FROM diagnostic").all())).not.toContain("refresh-secret")
    diagnostics.close()
    const reopened = new Diagnostics(file, 3)
    expect(reopened.db.query("SELECT count(*) AS count FROM diagnostic").get()).toEqual({ count: 3 })
    reopened.close()
  })
})

test("billing boundaries and quota evidence", async () => {
  expect(isWork(undefined)).toBe(false)
  expect(isWork(join(process.env.HOME!, "Code/arca-worktree"))).toBe(true)
  expect(isWork(join(process.env.HOME!, "Code/arcafoo"))).toBe(false)
  const generic = await classify(Response.json({ error: { message: "Claude token refresh is rate-limited" } }, { status: 429 }), "model")
  expect(generic.category).toBe("model_throttle")
  const unified = await classify(Response.json({ error: { type: "rate_limit_error", message: "same generic prose" } }, { status: 429, headers: { "anthropic-ratelimit-unified-5h-status": "rejected" } }), "model")
  expect(unified.category).toBe("model_quota")
  expect(unified.quotaWindow).toBe("5h")
  expect(unified.reason).toBe("rate_limit_error")
  expect(fallback({ failure: generic, failed: { providerID: "anthropic", id: "claude-opus-5-5" }, available })).toBeUndefined()
  expect(readFailure({ response: { body: "not-json" } })).toBeUndefined()
  expect(retryAfter("Thu, 01 Jan 1970 00:00:10 GMT", 1000)).toBe(9000)
  expect(fallback({ failure: { category: "model_quota", reason: "quota_exceeded" }, failed: { providerID: "anthropic", id: "claude-opus-5-5" }, available, directory: join(process.env.HOME!, "Code/arca") })).toEqual(available[1])
})

test("licensed V1 transport reused without setup; gateway carries structured refresh failure", async () => {
  const root = process.env.CLAUDE_AUTH_TEST_ROOT
  const modules = await legacy(root)
  const disk = store()
  let calls = 0
  const tokenURL = endpoint(() => { calls++; return Response.json({ error: "overloaded_error" }, { status: 502 }) })
  const proxy = gateway({ auth: new SubscriptionAuth({ store: disk, tokenURL, maxAttempts: 1, sleep: async () => {} }), transport: modules.transport })
  cleanup.push(() => { proxy.stop() })
  const response = await fetch(`${proxy.url}/messages`, { method: "POST", headers: { "x-subscription-gateway": proxy.secret }, body: JSON.stringify({ model: "claude-opus-5-5", messages: [] }) })
  const detail = readFailure({ response: { body: await response.text() } })
  expect(response.status).toBe(502)
  expect(detail?.category).toBe("refresh_server")
  expect(detail?.exhausted).toBe(true)
  expect(calls).toBe(1)
})

test("real gateway applies subscription identity/billing/auth and reverses fragmented SSE tool names", async () => {
  const modules = await legacy(process.env.CLAUDE_AUTH_TEST_ROOT)
  const disk = store()
  await disk.write({ accessToken: "valid-secret", refreshToken: "refresh-secret", expiresAt: Date.now() + 3600000 })
  let calls = 0
  const upstream = endpoint(async (request) => {
    calls++
    expect(request.headers.get("authorization")).toBe("Bearer valid-secret")
    expect(request.headers.has("x-api-key")).toBe(false)
    expect(request.headers.has("x-subscription-gateway")).toBe(false)
    const body = await request.json() as { system: Array<{ text: string }>; tools: Array<{ name: string }> }
    expect(body.system.some((part) => part.text === modules.transport.SYSTEM_IDENTITY)).toBe(true)
    expect(body.system[0]?.text.startsWith("x-anthropic-billing-header")).toBe(true)
    expect(body.tools[0]?.name).toBe("mcp_Read")
    const encoder = new TextEncoder()
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(encoder.encode('event: content_block_start\ndata: {"content_block":{"type":"tool_use","name":"mcp_')); controller.enqueue(encoder.encode('Read","id":"tool1","input":{}}}\n\n')); controller.close() } }), { headers: { "content-type": "text/event-stream" } })
  })
  const proxy = gateway({ auth: new SubscriptionAuth({ store: disk }), transport: modules.transport, upstream })
  cleanup.push(() => { proxy.stop() })
  const response = await fetch(`${proxy.url}/messages`, { method: "POST", headers: { "x-subscription-gateway": proxy.secret, "x-api-key": "must-be-removed" }, body: JSON.stringify({ model: "claude-opus-5-5", system: [{ type: "text", text: "OpenCode instructions" }], messages: [{ role: "user", content: "read" }], tools: [{ name: "read", input_schema: { type: "object" } }] }) })
  expect(response.status).toBe(200)
  expect(await response.text()).toContain('"name": "read"')
  expect(calls).toBe(1)
})
