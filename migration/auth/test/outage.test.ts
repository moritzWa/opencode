import { describe, expect, test } from "bun:test"
import { boundRetry, fallback } from "../src/policy.ts"

const sonnet = { providerID: "anthropic", id: "claude-sonnet-5-5" }
const sol = { providerID: "openai", id: "gpt-6.1-sol" }

describe("a refresh outage does not leave Claude", () => {
  test("an exhausted network or throttle failure does not switch providers", () => {
    expect(fallback({ failure: { category: "refresh_network", reason: "connection_failed", exhausted: true }, failed: sonnet, available: [sol] })).toBeUndefined()
    expect(fallback({ failure: { category: "refresh_throttle", reason: "rate_limit_error", exhausted: true }, failed: sonnet, available: [sol] })).toBeUndefined()
    expect(fallback({ failure: { category: "refresh_server", reason: "api_error", exhausted: true, status: 503 }, failed: sonnet, available: [sol] })).toBeUndefined()
  })

  test("a revoked credential and a real quota still move", () => {
    expect(fallback({ failure: { category: "refresh_revoked", reason: "token_revoked", exhausted: true }, failed: sonnet, available: [sol] })).toEqual(sol)
    expect(fallback({ failure: { category: "model_quota", reason: "quota_exceeded" }, failed: sonnet, available: [sol] })).toEqual(sol)
  })

  test("an exhausted network failure does not stop the runner retry", () => {
    const event = {
      error: { type: "provider.internal", message: "connection_failed", response: { body: JSON.stringify({ subscription: { category: "refresh_network", reason: "connection_failed", exhausted: true } }) } },
      decision: { retry: true as const, delay: 1000 },
    }
    boundRetry(event)
    expect(event.decision.retry).toBe(true)
  })
})
