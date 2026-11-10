import { ClaudeFailure, classify, failureResponse, type Failure } from "./failure.ts"
import type { legacy } from "./legacy.ts"
import type { Diagnostics } from "./diagnostics.ts"
import { accountCoolMs, nextAccount } from "./policy.ts"

export interface AccountAttempt {
  source: string
  credentials(signal: AbortSignal, force?: boolean): Promise<{ accessToken: string }>
}

export function gateway(options: {
  accounts: () => AccountAttempt[] | Promise<AccountAttempt[]>
  transport: Awaited<ReturnType<typeof legacy>>["transport"]
  diagnostics?: Diagnostics
  upstream?: string
}) {
  const secret = crypto.randomUUID()
  const cooling = new Map<string, number>()
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0, idleTimeout: 0,
    async fetch(request) {
      if (request.headers.get("x-subscription-gateway") !== secret) return new Response(null, { status: 403 })
      const session = request.headers.get("x-subscription-session") ?? undefined
      const url = new URL(request.url)
      if (request.method !== "POST" || url.pathname !== "/v1/messages") return new Response(null, { status: 404 })
      const parsed = await request.json() as { model: string; system?: string | Array<{ type: string; text?: string }> }
      const system = typeof parsed.system === "string" ? [{ type: "text", text: parsed.system }] : parsed.system ?? []
      parsed.system = system.some((item) => item.text?.startsWith(options.transport.SYSTEM_IDENTITY)) ? system : [{ type: "text", text: options.transport.SYSTEM_IDENTITY }, ...system]
      const body = JSON.stringify(parsed)
      const model = parsed.model
      const accounts = (await options.accounts()).filter((item) => (cooling.get(item.source) ?? 0) <= Date.now())
      if (accounts.length === 0) return failureResponse({ category: "model_quota", reason: "quota_exceeded", exhausted: true })
      const send = (access: string) => {
        const headers = forwardedHeaders(options.transport.buildRequestHeaders(request, {}, access, model, options.transport.getExcludedBetas(model)))
        headers.delete("x-subscription-gateway")
        headers.delete("x-subscription-session")
        headers.delete("host")
        headers.delete("content-length")
        const target = new URL("/v1/messages?beta=true", options.upstream ?? "https://api.anthropic.com")
        return fetch(target, { method: "POST", headers, body: options.transport.transformBody(body), signal: request.signal })
      }
      let last: Failure | undefined
      for (const [index, account] of accounts.entries()) {
        const sent = await attempt(account, send, request.signal, model, options.transport)
        if (sent instanceof ClaudeFailure) {
          const hop = nextAccount(sent.detail)
          if (hop === "stop" || index === accounts.length - 1) return failureResponse(sent.detail)
          if (hop === "cool") cooling.set(account.source, Date.now() + accountCoolMs(sent.detail))
          options.diagnostics?.record(sent.detail, "other_account", session)
          last = sent.detail
          continue
        }
        if (sent.ok) return forward(options.transport.transformResponseStream(sent))
        const failure = sent.status === 401 ? { category: "refresh_revoked" as const, status: 401, reason: "authentication_error", exhausted: true } : await classify(sent, "model")
        if (nextAccount(failure) !== "cool" || index === accounts.length - 1) {
          options.diagnostics?.record(failure, "stop", session)
          return retain(sent, failure)
        }
        cooling.set(account.source, Date.now() + accountCoolMs(failure))
        options.diagnostics?.record(failure, "other_account", session)
        await sent.body?.cancel()
        last = failure
      }
      return failureResponse(last ?? { category: "refresh_invalid", reason: "missing_credentials", exhausted: true })
    },
    error(error) {
      // Never send unknown Error.message: a transport can put an authenticated
      // URL or credential blob there. Cancellation cannot trigger recovery.
      if (error instanceof DOMException && error.name === "AbortError") return new Response(null, { status: 499 })
      // Fetch rejects with the native code when api.anthropic.com is unreachable. Forwarding
      // the code lets the runner wait out the outage like a direct provider connection.
      const code = "code" in error && typeof error.code === "string" ? error.code : undefined
      if (code && networkCodes.has(code)) {
        options.diagnostics?.record({ category: "upstream_network", reason: "connection_failed" }, "retry_claude")
        return failureResponse({ category: "upstream_network", reason: "connection_failed", code })
      }
      return failureResponse({ category: "unknown", reason: "gateway_failure" })
    },
  })
  return { url: `http://127.0.0.1:${server.port}/v1`, secret, stop: () => server.stop(true) }
}

async function attempt(
  account: AccountAttempt,
  send: (access: string) => Promise<Response>,
  signal: AbortSignal,
  model: string,
  transport: Awaited<ReturnType<typeof legacy>>["transport"],
) {
  const token = await account.credentials(signal).catch((error: unknown) => {
    if (error instanceof ClaudeFailure) return error
    throw error
  })
  if (token instanceof ClaudeFailure) return token
  let tokenInUse = token.accessToken
  let response = await send(tokenInUse)
  if (response.status === 401) {
    await response.body?.cancel()
    const fresh = await account.credentials(signal, true).catch((error: unknown) => {
      if (error instanceof ClaudeFailure) return error
      throw error
    })
    if (fresh instanceof ClaudeFailure) return fresh
    tokenInUse = fresh.accessToken
    response = await send(tokenInUse)
  }
  if (response.status === 429) {
    const rotated = await account.credentials(signal).catch(() => undefined)
    if (rotated && rotated.accessToken !== tokenInUse) {
      await response.body?.cancel()
      response = await send(rotated.accessToken)
      tokenInUse = rotated.accessToken
    }
  }
  for (let index = 0; index < transport.LONG_CONTEXT_BETAS.length && [400, 429].includes(response.status); index++) {
    if (!transport.isLongContextError(await response.clone().text())) break
    const beta = transport.getNextBetaToExclude(model)
    if (!beta) break
    transport.addExcludedBeta(model, beta)
    await response.body?.cancel()
    response = await send(tokenInUse)
  }
  return response
}

async function retain(response: Response, failure: Failure) {
  const body: unknown = await response.clone().json().catch(() => undefined)
  if (body && typeof body === "object" && !Array.isArray(body)) {
    return Response.json({ ...body, subscription: failure }, { status: response.status, headers: forwardedHeaders(response.headers) })
  }
  return forward(response)
}

const networkCodes = new Set(["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETDOWN", "ENETUNREACH", "ETIMEDOUT", "EPIPE", "ConnectionClosed", "ConnectionRefused", "ConnectionResetByPeer", "ConnectionTimeout", "FailedToOpenSocket"])

function forward(response: Response) {
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: forwardedHeaders(response.headers) })
}

function forwardedHeaders(input: Headers) {
  const headers = new Headers(input)
  // Bun fetch has already decoded gzip/br/deflate. Transforms can also change
  // body length, and each HTTP hop owns its own framing and connection headers.
  const connection = (headers.get("connection") ?? "").split(",").map((name) => name.trim()).filter(Boolean)
  for (const name of [...connection, "content-encoding", "content-length", "transfer-encoding", "connection", "keep-alive", "proxy-connection", "proxy-authenticate", "proxy-authorization", "te", "trailer", "upgrade"]) headers.delete(name)
  return headers
}
