import { homedir } from "node:os"
import { isAbsolute, join, relative, sep } from "node:path"
import { readFailure, type Failure } from "./failure.ts"

export interface ModelRef { providerID: string; id: string }

export function boundRetry(event: { error: { type: string; message: string; response?: { body: string } }; decision: { retry: false } | { retry: true; delay: number } }) {
  const detail = readFailure(event.error)
  if (detail?.exhausted || detail?.category === "model_quota" || detail?.category === "billing" || detail?.category === "capacity") event.decision = { retry: false }
}
export function isWork(directory?: string, code = join(homedir(), "Code")) {
  if (!directory) return false
  const rel = relative(code, directory)
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return false
  return ["arca", "science-website"].some((repo) => rel.split(sep)[0] === repo || rel.split(sep)[0]!.startsWith(`${repo}-`))
}

// Equivalent on the other subscription, then the next model there if that one is also out.
// Cursor is not a rung. A second Claude account is not wired yet.
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

export function fallback(input: { failure: Failure; failed: ModelRef; directory?: string; available: readonly ModelRef[]; tried?: readonly string[] }): ModelRef | undefined {
  const auth = input.failure.category.startsWith("refresh_") && input.failure.exhausted
  if (!auth && !["model_quota", "billing", "capacity"].includes(input.failure.category)) return
  return otherSubscription(input.failed).find((model) => !input.tried?.some((key) => key === `${model.providerID}/${model.id}` || key === `${model.providerID}/*`) && input.available.some((item) => item.providerID === model.providerID && item.id === model.id))
}
