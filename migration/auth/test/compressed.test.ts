import { afterEach, expect, test } from "bun:test"
import { SubscriptionAuth } from "../src/auth.ts"
import { gateway } from "../src/gateway.ts"
import { legacy } from "../src/legacy.ts"
import { readFailure } from "../src/failure.ts"

const cleanup: Array<() => void> = []
afterEach(() => cleanup.splice(0).reverse().forEach((stop) => stop()))

test.each([200, 429, 502])("gzip upstream HTTP %s crosses pinned transforms and gateway without double decoding", async (status) => {
  const modules = await legacy(process.env.CLAUDE_AUTH_TEST_ROOT)
  const credentials = { accessToken: "synthetic-access", refreshToken: "synthetic-refresh", expiresAt: Date.now() + 3600000 }
  const source = status === 200 ? 'event: content_block_start\ndata: {"content_block":{"type":"tool_use","name":"mcp_Read","id":"fixture","input":{}}}\n\n'
    : status === 429 ? JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "synthetic throttle" } })
      : "synthetic upstream temporarily unavailable"
  const compressed = Bun.gzipSync(source)
  let calls = 0
  const upstream = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request) {
      calls++
      expect(request.headers.get("authorization")).toBe("Bearer synthetic-access")
      expect(request.headers.has("x-client-hop")).toBe(false)
      return new Response(compressed, { status, headers: {
        "content-type": status === 200 ? "text/event-stream" : status === 429 ? "application/json" : "text/plain",
        "content-encoding": "gzip", "content-length": String(compressed.byteLength),
        connection: "keep-alive, x-upstream-hop", "x-upstream-hop": "must-not-cross-hop",
        "proxy-connection": "keep-alive", "proxy-authenticate": "Basic realm=synthetic",
        "retry-after": "17", "anthropic-ratelimit-requests-remaining": "0", "request-id": `synthetic-${status}`,
      } })
    },
  })
  cleanup.push(() => { upstream.stop(true) })
  const proxy = gateway({ auth: new SubscriptionAuth({ store: { read: async () => credentials, write: async () => true } }), transport: modules.transport, upstream: `http://127.0.0.1:${upstream.port}` })
  cleanup.push(() => { proxy.stop() })
  const response = await fetch(`${proxy.url}/messages`, {
    method: "POST", headers: { "x-subscription-gateway": proxy.secret, connection: "keep-alive, x-client-hop", "x-client-hop": "must-not-cross-hop" },
    body: JSON.stringify({ model: "claude-opus-5-5", messages: [{ role: "user", content: "Synthetic transport regression" }] }),
  })
  expect(response.status).toBe(status)
  expect(response.headers.has("content-encoding")).toBe(false)
  expect(response.headers.has("x-upstream-hop")).toBe(false)
  expect(response.headers.has("proxy-connection")).toBe(false)
  expect(response.headers.has("proxy-authenticate")).toBe(false)
  expect(response.headers.get("retry-after")).toBe("17")
  expect(response.headers.get("anthropic-ratelimit-requests-remaining")).toBe("0")
  expect(response.headers.get("request-id")).toBe(`synthetic-${status}`)
  const body = await response.text()
  if (response.headers.has("content-length")) expect(Number(response.headers.get("content-length"))).toBe(Buffer.byteLength(body))
  if (status === 200) {
    expect(response.headers.get("content-type")).toBe("text/event-stream")
    expect(body).toContain('"name": "read"')
    expect(body).not.toContain("mcp_Read")
  }
  if (status === 429) {
    expect(response.headers.get("content-type")).toBe("application/json")
    expect(readFailure({ response: { body } })).toEqual({ category: "model_throttle", status: 429, reason: "rate_limit_error", retryAfterMs: 17000 })
    expect(JSON.parse(body).error.message).toBe("synthetic throttle")
  }
  if (status === 502) expect(body).toBe(source)
  expect(calls).toBe(1)
})
