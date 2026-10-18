import { afterEach, expect, test } from "bun:test"
import { SubscriptionAuth } from "../src/auth.ts"
import { gateway } from "../src/gateway.ts"
import { legacy } from "../src/legacy.ts"
import { readFailure } from "../src/failure.ts"
import { fallback } from "../src/policy.ts"

const cleanup: Array<() => void> = []
afterEach(() => cleanup.splice(0).reverse().forEach((stop) => stop()))

test("an unreachable upstream is reported with its native network code and never falls back", async () => {
  const modules = await legacy(process.env.CLAUDE_AUTH_TEST_ROOT)
  const closed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
  const upstream = `http://127.0.0.1:${closed.port}`
  closed.stop(true)
  const credentials = { accessToken: "synthetic-access", refreshToken: "synthetic-refresh", expiresAt: Date.now() + 3600000 }
  const proxy = gateway({ auth: new SubscriptionAuth({ store: { read: async () => credentials, write: async () => true } }), transport: modules.transport, upstream })
  cleanup.push(() => { proxy.stop() })
  const response = await fetch(`${proxy.url}/messages`, {
    method: "POST", headers: { "x-subscription-gateway": proxy.secret },
    body: JSON.stringify({ model: "claude-opus-5-5", messages: [{ role: "user", content: "Synthetic outage" }] }),
  })
  expect(response.status).toBe(503)
  const body = await response.text()
  expect(JSON.parse(body).error.code).toBe("ECONNREFUSED")
  const failure = readFailure({ response: { body } })
  expect(failure).toEqual({ category: "upstream_network", reason: "connection_failed" })
  expect(fallback({ failure: failure!, failed: { providerID: "anthropic", id: "claude-opus-5-5" }, available: [{ providerID: "openai", id: "gpt-6.1-sol" }] })).toBeUndefined()
})
