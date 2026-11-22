import { afterEach, expect, test } from "bun:test"
import { sharedAuth, SubscriptionAuth } from "../src/auth.ts"
import { ClaudeFailure, readFailure } from "../src/failure.ts"
import { gateway } from "../src/gateway.ts"
import type { Credentials } from "../src/legacy.ts"

const cleanup: Array<() => void> = []
afterEach(() =>
  cleanup
    .splice(0)
    .reverse()
    .forEach((dispose) => dispose()),
)
const signal = () => new AbortController().signal
const transport = {
  SYSTEM_IDENTITY: "test-identity",
  buildRequestHeaders: () => new Headers(),
  transformBody: (body: string) => body,
  transformResponseStream: (response: Response) => response,
  getExcludedBetas: () => new Set<string>(),
  isLongContextError: () => false,
  getNextBetaToExclude: () => null,
  addExcludedBeta: () => {},
  LONG_CONTEXT_BETAS: [],
}

function store() {
  const state = { value: { accessToken: "expired", refreshToken: "refresh", expiresAt: 0 } }
  return {
    read: async () => state.value,
    write: async (next: Credentials) => {
      state.value = next
      return true
    },
  }
}

function endpoint(handle: () => Response | Promise<Response>) {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: handle })
  cleanup.push(() => server.stop(true))
  return server.url.href
}

test("different Location leases share one refresh and cancel independently", async () => {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let calls = 0
  const tokenURL = endpoint(async () => {
    calls++
    entered.resolve()
    await release.promise
    return Response.json({ access_token: "new", expires_in: 3600 })
  })
  const disk = store()
  const first = sharedAuth(tokenURL, { store: disk, tokenURL })
  const second = sharedAuth(tokenURL, { store: disk, tokenURL })
  cleanup.push(first.release, second.release)
  const cancelled = new AbortController()
  const a = first.auth.credentials(cancelled.signal).catch((error: unknown) => error)
  const b = second.auth.credentials(signal())
  await entered.promise
  cancelled.abort(new DOMException("cancelled", "AbortError"))
  expect(await a).toBeInstanceOf(DOMException)
  release.resolve()
  expect((await b).accessToken).toBe("new")
  expect(calls).toBe(1)
})

test("an exhausted refresh shares Retry-After cooldown across callers", async () => {
  let calls = 0
  let now = 0
  const tokenURL = endpoint(() => {
    calls++
    return Response.json({ error: "rate_limit_error" }, { status: 429, headers: { "retry-after": "120" } })
  })
  const auth = new SubscriptionAuth({ store: store(), tokenURL, now: () => now })
  const first = await auth.credentials(signal()).catch((error: unknown) => error)
  expect(first).toBeInstanceOf(ClaudeFailure)
  expect(await auth.credentials(signal()).catch((error: unknown) => error)).toMatchObject({
    detail: { category: "refresh_throttle", status: 429, exhausted: true },
  })
  expect(calls).toBe(1)
  now = 120_001
  await auth.credentials(signal()).catch(() => undefined)
  expect(calls).toBe(2)
})

test("fresh credentials from another process bypass the refresh cooldown", async () => {
  const disk = store()
  const tokenURL = endpoint(() =>
    Response.json({ error: "rate_limit_error" }, { status: 429, headers: { "retry-after": "120" } }),
  )
  const auth = new SubscriptionAuth({ store: disk, tokenURL })
  await auth.credentials(signal()).catch(() => undefined)
  await disk.write({ accessToken: "external-renewal", refreshToken: "new", expiresAt: Date.now() + 3600_000 })
  expect((await auth.credentials(signal())).accessToken).toBe("external-renewal")
})

test("the shared gateway budget preserves the first account's 429 when the next account hangs", async () => {
  const proxy = gateway({
    accounts: () => [
      {
        source: "first",
        credentials: async () => {
          throw new ClaudeFailure({
            category: "refresh_throttle",
            reason: "rate_limit_error",
            status: 429,
            retryAfterMs: 120_000,
            exhausted: true,
          })
        },
      },
      { source: "second", credentials: () => new Promise<never>(() => {}) },
    ],
    authBudgetMs: 100,
    transport,
  })
  cleanup.push(() => proxy.stop())
  const response = await fetch(`${proxy.url}/messages`, {
    method: "POST",
    headers: { "x-subscription-gateway": proxy.secret },
    body: JSON.stringify({ model: "claude-sonnet-5-5", messages: [] }),
  })
  expect(response.status).toBe(429)
  expect(readFailure({ response: { body: await response.text() } })).toMatchObject({
    category: "refresh_throttle",
    status: 429,
    exhausted: true,
    retryAfterMs: 120_000,
  })
})

test("account discovery also has a structured authentication deadline", async () => {
  const proxy = gateway({ accounts: () => new Promise<never>(() => {}), authBudgetMs: 100, transport })
  cleanup.push(() => proxy.stop())
  const response = await fetch(`${proxy.url}/messages`, {
    method: "POST",
    headers: { "x-subscription-gateway": proxy.secret },
    body: JSON.stringify({ model: "claude-sonnet-5-5", messages: [] }),
  })
  expect(response.status).toBe(503)
  expect(readFailure({ response: { body: await response.text() } })).toMatchObject({
    category: "refresh_pending",
    reason: "timeout",
    exhausted: true,
  })
})
