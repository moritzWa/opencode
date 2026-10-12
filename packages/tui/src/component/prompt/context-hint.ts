import type { AssistantMessage } from "@opencode-ai/sdk/v2"

// An early replay-cost reminder, not a claim that compacting always saves money:
// summarization has a cost and changes the cached prefix.
export function contextHint(tokens: AssistantMessage["tokens"], limit: { context: number; input?: number }) {
  const used = tokens.total || tokens.input + tokens.output + tokens.cache.read + tokens.cache.write
  if (!Number.isFinite(used) || used <= 0) return
  const capacity = limit.input || limit.context
  const threshold = capacity > 0 ? Math.min(100_000, capacity * 0.5) : 100_000
  return {
    used,
    threshold,
    warn: used >= threshold,
    label: `ctx ${used >= 1000 ? `${Math.round(used / 1000)}k` : used}`,
  }
}
