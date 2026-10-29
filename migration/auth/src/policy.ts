import { homedir } from "node:os"
import { isAbsolute, join, relative, sep } from "node:path"
import { readFailure, type Failure } from "./failure.ts"

export interface ModelRef { providerID: string; id: string }

export function boundRetry(event: { error: { type: string; message: string; response?: { body: string } }; decision: { retry: false } | { retry: true; delay: number } }) {
  const detail = readFailure(event.error)
  if (detail?.exhausted || detail?.category === "model_quota" || detail?.category === "capacity") event.decision = { retry: false }
}
export function isWork(directory?: string, code = join(homedir(), "Code")) {
  if (!directory) return false
  const rel = relative(code, directory)
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return false
  return ["arca", "science-website"].some((repo) => rel.split(sep)[0] === repo || rel.split(sep)[0]!.startsWith(`${repo}-`))
}

// Ordered ladder: each rung is tried only if available and not already tried; OpenAI is last because its credits can run out.
const personal = [{ providerID: "cursor", id: "claude-sonnet-5-5" }, ...["gpt-6.1-sol", "gpt-5.6-sol", "gpt-6-astra", "gpt-5.5"].map((id) => ({ providerID: "openai", id }))]

export function fallback(input: { failure: Failure; failed: ModelRef; directory?: string; available: readonly ModelRef[]; tried?: readonly string[] }): ModelRef | undefined {
  const auth = input.failure.category.startsWith("refresh_") && input.failure.exhausted
  if (!auth && !["model_quota", "capacity"].includes(input.failure.category)) return
  const work = isWork(input.directory)
  // Auth outages walk the personal ladder. Work quota recovery
  // retains the established same-Claude-on-Cursor billing route.
  const candidates = auth ? personal : work ? [
    ...(input.failed.providerID === "anthropic" ? [{ providerID: "cursor", id: `${input.failed.id.replace(/-1m$/, "")}-1m` }, { providerID: "cursor", id: input.failed.id }] : []),
    { providerID: "cursor", id: "claude-opus-5" }, { providerID: "anthropic", id: "claude-opus-5-5" },
  ] : personal
  return candidates.find((model) => `${model.providerID}/${model.id}` !== `${input.failed.providerID}/${input.failed.id}` && !input.tried?.includes(`${model.providerID}/${model.id}`) && input.available.some((item) => item.providerID === model.providerID && item.id === model.id))
}
