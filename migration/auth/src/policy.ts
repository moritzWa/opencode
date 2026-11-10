import { homedir } from "node:os"
import { isAbsolute, join, relative, sep } from "node:path"
import { readFailure, type Failure } from "./failure.ts"

export interface ModelRef { providerID: string; id: string }

const transient = new Set(["refresh_throttle", "refresh_network", "refresh_server", "refresh_pending", "upstream_network", "model_throttle"])

export function boundRetry(event: { error: { type: string; message: string; response?: { body: string } }; decision: { retry: false } | { retry: true; delay: number } }) {
  const detail = readFailure(event.error)
  // A spent refresh budget is not a dead subscription. Keep the runner's retry,
  // including the long network wait, instead of abandoning the model.
  if (!detail || transient.has(detail.category)) return
  if (detail.exhausted || detail.category === "model_quota" || detail.category === "billing" || detail.category === "capacity") event.decision = { retry: false }
}
export function isWork(directory?: string, code = join(homedir(), "Code")) {
  if (!directory) return false
  const rel = relative(code, directory)
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return false
  return ["arca", "science-website"].some((repo) => rel.split(sep)[0] === repo || rel.split(sep)[0]!.startsWith(`${repo}-`))
}

// Equivalent on the other subscription, then the next model there if that one is also out.
// Cursor is not a rung. The gateway tries another Claude account on the same model first.
const codexFor = {
  haiku: ["gpt-6-luna", "gpt-6.1-sol", "gpt-6-astra"],
  sonnet: ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-luna"],
  opus: ["gpt-6-astra", "gpt-6.1-sol"],
}
const claudeFor = {
  luna: ["claude-haiku-5-5", "claude-sonnet-5-5"],
  sol: ["claude-sonnet-5-5", "claude-opus-5-5"],
  astra: ["claude-opus-5-5", "claude-sonnet-5-5"],
}

const COOLDOWN = 30 * 60 * 1000
const HOUR = 60 * 60 * 1000

// A 5h or 7d rejection should not be retried on that account every request.
// A short Retry-After is not evidence the weekly window reset.
export function accountCoolMs(failure: Failure) {
  if (failure.quotaWindow === "7d" || failure.quotaWindow === "7d_opus") return 7 * 24 * HOUR
  if (failure.quotaWindow === "5h") return 5 * HOUR
  if (failure.category === "billing") return 12 * HOUR
  if (failure.retryAfterMs && failure.retryAfterMs > 0) return Math.min(failure.retryAfterMs, 7 * 24 * HOUR)
  return COOLDOWN
}

export function switchAccount(failure: Failure) {
  return failure.category === "model_quota" || failure.category === "billing" || failure.category === "capacity" || failure.category === "credential_store" || failure.category === "refresh_invalid" || failure.category === "refresh_revoked"
}

// "cool" skips that account for the rejection window. "try" asks the next account
// once (its cached token may still be valid) without treating a network blip as
// an account failure. "stop" returns the error to the runner.
export function nextAccount(failure: Failure): "stop" | "try" | "cool" {
  if (switchAccount(failure)) return "cool"
  if (failure.category === "refresh_throttle") return "cool"
  if (failure.category === "refresh_network" || failure.category === "refresh_server" || failure.category === "refresh_pending") return "try"
  return "stop"
}

export function cooldown(cooling = new Map<string, number>()) {
  return {
    mark(input: { failure: Failure; failed: ModelRef; now?: number }) {
      const providerWide = input.failure.category.startsWith("refresh_") || input.failure.category === "billing" || input.failed.providerID === "openai"
      if (!providerWide && !["model_quota", "capacity"].includes(input.failure.category)) return
      cooling.set(providerWide ? `${input.failed.providerID}/*` : `${input.failed.providerID}/${input.failed.id}`, (input.now ?? Date.now()) + COOLDOWN)
    },
    active(now = Date.now()) {
      return [...cooling].filter(([, until]) => until > now).map(([key]) => key)
    },
  }
}

const tier = (id: string) => {
  const name = id.replace(/-1m$/, "").replace(/-fast$/, "")
  if (name.includes("haiku")) return "haiku"
  if (name.includes("sonnet")) return "sonnet"
  if (name.includes("opus") || name.includes("fable")) return "opus"
  if (name.includes("luna")) return "luna"
  if (name.includes("sol")) return "sol"
  if (name.includes("astra") || name.includes("terra")) return "astra"
}

const otherSubscription = (failed: ModelRef): ModelRef[] => {
  const kind = tier(failed.id)
  if (failed.providerID === "anthropic") return (kind === "haiku" ? codexFor.haiku : kind === "opus" ? codexFor.opus : codexFor.sonnet).map((id) => ({ providerID: "openai", id }))
  if (failed.providerID === "openai") return (kind === "luna" ? claudeFor.luna : kind === "astra" ? claudeFor.astra : claudeFor.sol).map((id) => ({ providerID: "anthropic", id }))
  return []
}

export function fallback(input: { failure: Failure; failed: ModelRef; directory?: string; available: readonly ModelRef[]; tried?: readonly string[]; held?: readonly string[] }): ModelRef | undefined {
  // Only a revoked or invalid credential, after the refresh budget, means this
  // subscription cannot authenticate. Network, throttle, and 5xx refresh
  // failures are outages: the runner waits them out, and the other Claude
  // account is tried by the gateway before this hook runs.
  const auth = input.failure.exhausted === true && ["refresh_revoked", "refresh_invalid", "credential_store"].includes(input.failure.category)
  if (!auth && !["model_quota", "billing", "capacity"].includes(input.failure.category)) return
  return otherSubscription(input.failed).find((model) => !input.held?.includes(model.providerID) && !input.tried?.some((key) => key === `${model.providerID}/${model.id}` || key === `${model.providerID}/*`) && input.available.some((item) => item.providerID === model.providerID && item.id === model.id))
}
