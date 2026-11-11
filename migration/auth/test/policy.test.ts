import { describe, expect, test } from "bun:test"
import { ClaudeFailure } from "../src/failure.ts"
import { gateway } from "../src/gateway.ts"
import type { legacy } from "../src/legacy.ts"
import { boundRetry, fallback, NETWORK_GIVE_UP, nextAccount } from "../src/policy.ts"
import { failureResponse, readFailure } from "../src/failure.ts"

const sonnet = { providerID: "anthropic", id: "claude-sonnet-5-5" }
const sol = { providerID: "openai", id: "gpt-6.1-sol" }

describe("recovery does not leave Claude on a network blip", () => {
  test("an exhausted refresh network failure does not switch providers", () => {
    const failure = { category: "refresh_network" as const, reason: "connection_failed", exhausted: true, code: "ECONNRESET" }
    expect(fallback({ failure, failed: sonnet, available: [sol] })).toBeUndefined()
    const event = { error: { type: "provider.internal", message: failure.reason, response: { body: "" } }, decision: { retry: true as const, delay: 1000 } }
    event.error.response.body = JSON.stringify({ subscription: failure })
    boundRetry(event)
    expect(event.decision.retry).toBe(true)
  })

  test("an exhausted refresh throttle does not switch providers", () => {
    expect(fallback({ failure: { category: "refresh_throttle", reason: "rate_limit_error", exhausted: true, status: 429 }, failed: sonnet, available: [sol] })).toBeUndefined()
  })

  test("a connection that is still down after a few tries leaves Claude", () => {
    const failure = { category: "upstream_network" as const, reason: "connection_failed", code: "ECONNRESET" }
    const event = { attempt: NETWORK_GIVE_UP, error: { type: "provider.internal", message: failure.reason, response: { body: JSON.stringify({ subscription: failure }) } }, decision: { retry: true as const, delay: 1000 } }
    boundRetry(event)
    expect(event.decision.retry).toBe(false)
    const grok = { providerID: "xai", id: "grok-4.7" }
    expect(fallback({ failure, failed: sonnet, available: [sonnet, sol, grok], persistent: true })).toEqual(sol)
    expect(fallback({ failure, failed: sonnet, available: [sonnet, sol, grok], persistent: true, held: ["openai"] })).toEqual(grok)
    expect(fallback({ failure, failed: sonnet, available: [sonnet, sol] })).toBeUndefined()
    const early = { attempt: NETWORK_GIVE_UP - 1, error: event.error, decision: { retry: true as const, delay: 1000 } }
    boundRetry(early)
    expect(early.decision.retry).toBe(true)
  })

  test("a real quota still moves to Codex unless that provider is already exhausted", () => {
    const failure = { category: "model_quota" as const, reason: "quota_exceeded" }
    expect(fallback({ failure, failed: sonnet, available: [sol] })).toEqual(sol)
    expect(fallback({ failure, failed: sonnet, available: [sol], held: ["openai"] })).toBeUndefined()
  })

  test("a revoked credential still leaves Claude", () => {
    expect(fallback({ failure: { category: "refresh_revoked", reason: "token_revoked", exhausted: true }, failed: sonnet, available: [sol] })).toEqual(sol)
  })

  test("a network refresh tries the other Claude account without cooling it", () => {
    expect(nextAccount({ category: "refresh_network", reason: "connection_failed", exhausted: true })).toBe("try")
    expect(nextAccount({ category: "model_quota", reason: "quota_exceeded" })).toBe("cool")
    expect(nextAccount({ category: "upstream_network", reason: "connection_failed" })).toBe("stop")
  })

  test("a Codex usage limit keeps its reset time", () => {
    const detail = readFailure({
      type: "provider.quota",
      message: "The usage limit has been reached",
      response: { body: JSON.stringify({ error: { type: "usage_limit_reached", resets_at: 1794404034 } }) },
    })
    expect(detail).toMatchObject({ category: "model_quota", reason: "usage_limit_reached", resetsAt: 1794404034000 })
  })

  test("a refresh network response carries a socket code the runner can wait on", async () => {
    const response = failureResponse({ category: "refresh_network", reason: "connection_failed" })
    expect(response.status).toBe(503)
    expect((await response.json()).error.code).toBe("ECONNRESET")
  })
})

const transport = {
  SYSTEM_IDENTITY: "test-identity",
  buildRequestHeaders: (_request: Request, _init: RequestInit, token: string) => new Headers({ authorization: `Bearer ${token}` }),
  transformBody: (body: string) => body,
  transformResponseStream: (response: Response) => response,
  getExcludedBetas: () => new Set<string>(),
  isLongContextError: () => false,
  getNextBetaToExclude: () => null,
  addExcludedBeta: () => {},
  LONG_CONTEXT_BETAS: [],
} as unknown as Awaited<ReturnType<typeof legacy>>["transport"]

describe("gateway account hop on a refresh outage", () => {
  test("a failed refresh on the preferred account uses the other account's cached token", async () => {
    const seen: string[] = []
    const upstream = Bun.serve({
      port: 0,
      fetch(request) {
        seen.push(request.headers.get("authorization") ?? "")
        return Response.json({ id: "msg", type: "message", role: "assistant", content: [{ type: "text", text: "ok" }] })
      },
    })
    const proxy = gateway({
      accounts: () => [
        { source: "primary", credentials: async () => { throw new ClaudeFailure({ category: "refresh_network", reason: "connection_failed", exhausted: true, code: "ECONNRESET" }) } },
        { source: "second", credentials: async () => ({ accessToken: "live" }) },
      ],
      transport,
      upstream: upstream.url,
    })
    const response = await fetch(`${proxy.url}/messages`, {
      method: "POST",
      headers: { "x-subscription-gateway": proxy.secret, "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-5-5", messages: [] }),
    })
    expect(response.status).toBe(200)
    expect(seen).toEqual(["Bearer live"])
    const again = await fetch(`${proxy.url}/messages`, {
      method: "POST",
      headers: { "x-subscription-gateway": proxy.secret, "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-5-5", messages: [] }),
    })
    expect(again.status).toBe(200)
    expect(seen).toEqual(["Bearer live", "Bearer live"])
    upstream.stop(true)
    proxy.stop()
  })
})
