import { describe, expect, test } from "bun:test"
import { gateway } from "../src/gateway.ts"
import type { legacy } from "../src/legacy.ts"

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

function quota() {
  return Response.json(
    { type: "error", error: { type: "rate_limit_error", message: "limit" } },
    { status: 429, headers: { "anthropic-ratelimit-unified-5h-status": "rejected" } },
  )
}

describe("claude account rotation", () => {
  test("a used-up account is retried on the next account, then skipped", async () => {
    const seen: string[] = []
    const upstream = Bun.serve({
      port: 0,
      fetch(request) {
        const token = request.headers.get("authorization") ?? ""
        seen.push(token)
        if (token === "Bearer dead") return quota()
        return Response.json({ id: "msg", type: "message", role: "assistant", content: [{ type: "text", text: "ok" }] })
      },
    })
    const proxy = gateway({
      accounts: () => [
        { source: "primary", credentials: async () => ({ accessToken: "dead" }) },
        { source: "second", credentials: async () => ({ accessToken: "live" }) },
      ],
      transport,
      upstream: upstream.url,
    })
    const first = await fetch(`${proxy.url}/messages`, {
      method: "POST",
      headers: { "x-subscription-gateway": proxy.secret, "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-5-5", messages: [] }),
    })
    expect(first.status).toBe(200)
    expect(await first.json()).toMatchObject({ content: [{ text: "ok" }] })
    expect(seen).toEqual(["Bearer dead", "Bearer live"])
    seen.length = 0
    const second = await fetch(`${proxy.url}/messages`, {
      method: "POST",
      headers: { "x-subscription-gateway": proxy.secret, "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-5-5", messages: [] }),
    })
    expect(second.status).toBe(200)
    expect(seen).toEqual(["Bearer live"])
    upstream.stop(true)
    proxy.stop()
  })

  test("a short rate limit does not switch accounts", async () => {
    const seen: string[] = []
    const upstream = Bun.serve({
      port: 0,
      fetch(request) {
        seen.push(request.headers.get("authorization") ?? "")
        return Response.json({ type: "error", error: { type: "rate_limit_error", message: "slow down" } }, { status: 429 })
      },
    })
    const proxy = gateway({
      accounts: () => [
        { source: "primary", credentials: async () => ({ accessToken: "dead" }) },
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
    expect(response.status).toBe(429)
    expect(seen).toEqual(["Bearer dead"])
    upstream.stop(true)
    proxy.stop()
  })
})
