export type Category = "refresh_throttle" | "refresh_network" | "refresh_server" | "refresh_revoked" | "refresh_invalid" | "refresh_pending" | "credential_store" | "model_quota" | "model_throttle" | "capacity" | "upstream_network" | "unknown"

export interface Failure {
  category: Category
  status?: number
  reason: string
  retryAfterMs?: number
  exhausted?: boolean
  quotaWindow?: "5h" | "7d" | "7d_opus"
  code?: string
}

export class ClaudeFailure extends Error {
  constructor(readonly detail: Failure) {
    super(`Claude subscription ${detail.category}: ${detail.reason}`)
    this.name = "ClaudeFailure"
  }
}

export function retryAfter(value: string | null, now = Date.now()) {
  if (value === null) return undefined
  const seconds = Number(value)
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now
  return Number.isFinite(delay) && delay >= 0 ? delay : undefined
}

// Persist protocol reason codes, never arbitrary upstream prose or response bodies.
const reasons = new Set(["invalid_grant", "invalid_client", "unauthorized_client", "access_denied", "token_revoked", "rate_limit_error", "overloaded_error", "api_error", "authentication_error", "quota_exceeded", "insufficient_quota", "usage_limit_reached", "capacity_limit"])

export async function classify(response: Response, phase: "refresh" | "model"): Promise<Failure> {
  const body: unknown = await response.clone().json().catch(() => undefined)
  const error = body && typeof body === "object" && "error" in body ? body.error : undefined
  const code = typeof error === "string" ? error : error && typeof error === "object" && "type" in error && typeof error.type === "string" ? error.type : ""
  const reason = reasons.has(code) ? code : "unrecognized_upstream_error"
  const wait = retryAfter(response.headers.get("retry-after"))
  const quotaWindow = phase === "model" && response.status === 429 ? (["5h", "7d", "7d_opus"] as const).find((window) => response.headers.get(`anthropic-ratelimit-unified-${window}-status`) === "rejected") : undefined
  const category: Category = phase === "refresh"
    ? ["invalid_grant", "invalid_client", "unauthorized_client", "access_denied", "token_revoked"].includes(reason) || response.status === 401 || response.status === 403 ? "refresh_revoked"
      : response.status === 429 ? "refresh_throttle"
        : response.status >= 500 ? "refresh_server" : "refresh_invalid"
    : quotaWindow || ["quota_exceeded", "insufficient_quota", "usage_limit_reached"].includes(reason) ? "model_quota"
      : reason === "capacity_limit" ? "capacity"
        : response.status === 429 ? "model_throttle" : "unknown"
  return { category, status: response.status, reason, ...(wait === undefined ? {} : { retryAfterMs: wait }), ...(quotaWindow ? { quotaWindow } : {}) }
}

export function failureResponse(detail: Failure) {
  // Network failures have no upstream HTTP status. 503 describes this local gateway,
  // while the structured evidence deliberately leaves upstream status absent.
  return Response.json({ type: "error", error: { type: `subscription.${detail.category}`, ...(detail.code ? { code: detail.code } : {}), message: `Claude subscription ${detail.category}: ${detail.reason}` }, subscription: detail }, { status: detail.status && detail.status >= 400 ? detail.status : 503 })
}

export function readFailure(error: { type?: string; message?: string; response?: { body: string } }): Failure | undefined {
  const parsed: unknown = error.response ? (() => { try { return JSON.parse(error.response.body) } catch { return undefined } })() : undefined
  if (!parsed || typeof parsed !== "object" || !("subscription" in parsed)) {
    if (error.type === "provider.quota") return { category: "model_quota", reason: "quota_exceeded" }
    if (/\bcapacity_limit\b/.test(error.message ?? "")) return { category: "capacity", reason: "capacity_limit" }
    return
  }
  const detail = parsed.subscription
  if (!detail || typeof detail !== "object" || !("category" in detail) || !("reason" in detail)) return
  const categories: Category[] = ["refresh_throttle", "refresh_network", "refresh_server", "refresh_revoked", "refresh_invalid", "refresh_pending", "credential_store", "model_quota", "model_throttle", "capacity", "upstream_network", "unknown"]
  const category = categories.find((item) => item === detail.category)
  if (!category || typeof detail.reason !== "string") return
  const status = "status" in detail && typeof detail.status === "number" && Number.isInteger(detail.status) && detail.status >= 100 && detail.status <= 599 ? detail.status : undefined
  const delay = "retryAfterMs" in detail && typeof detail.retryAfterMs === "number" && Number.isFinite(detail.retryAfterMs) && detail.retryAfterMs >= 0 ? detail.retryAfterMs : undefined
  const quotaWindow = "quotaWindow" in detail ? (["5h", "7d", "7d_opus"] as const).find((item) => item === detail.quotaWindow) : undefined
  return { category, reason: detail.reason, ...(status === undefined ? {} : { status }), ...(delay === undefined ? {} : { retryAfterMs: delay }), ...("exhausted" in detail && detail.exhausted === true ? { exhausted: true } : {}), ...(quotaWindow ? { quotaWindow } : {}) }
}
