import { HOME, LAST_RESORT, type ModelRef } from "./policy.ts"

// Above this many tokens, the history is summarized before Sonnet reads it cold.
export const COMPACT_ABOVE = 300_000

export interface ReturnMessage {
  readonly type: string
  readonly time: { readonly created: number }
  readonly model?: { readonly providerID: string; readonly id: string }
  readonly metadata?: Record<string, unknown>
  readonly tokens?: { input: number; output: number; reasoning?: number; cache: { read: number; write: number } }
  readonly error?: unknown
}

export interface ReturnInput {
  readonly model?: ModelRef
  readonly messages: readonly ReturnMessage[]
  readonly metadata?: Record<string, unknown>
  readonly held: readonly string[]
  readonly cooling: readonly string[]
  readonly available: readonly ModelRef[]
  readonly active: boolean
  readonly compactAbove?: number
}

export type ReturnDecision = { move: false; reason: string } | { move: true; compact: boolean; tokens: number }

/** Size of the history the last answered request carried, with its reply. */
export function contextTokens(messages: readonly ReturnMessage[]) {
  const last = messages.findLast((message) => message.type === "assistant" && message.tokens && !message.error)
  const tokens = last?.tokens
  return tokens ? tokens.input + tokens.cache.read + tokens.cache.write + tokens.output : 0
}

/** True when the last-resort model was picked again after an earlier return, so it stays. */
export function repicked(messages: readonly ReturnMessage[], returnedAt: number | undefined) {
  if (returnedAt === undefined) return false
  const index = messages.findLastIndex((message) => message.type === "model-switched" && message.model?.providerID === LAST_RESORT.providerID)
  const switched = messages[index]
  if (!switched || switched.time.created <= returnedAt) return false
  // A fallback commits the switch and a recovery marker together; only a bare switch is a pick.
  const next = messages[index + 1]
  return !(next?.type === "synthetic" && next.metadata?.recovery)
}

export function returnedAt(metadata: Record<string, unknown> | undefined) {
  const mark = metadata?.modelReturn
  const at = mark && typeof mark === "object" ? (mark as { at?: unknown }).at : undefined
  return typeof at === "number" ? at : undefined
}

export function decideReturn(input: ReturnInput): ReturnDecision {
  if (input.model?.providerID !== LAST_RESORT.providerID) return { move: false, reason: "not on the last resort" }
  if (input.active) return { move: false, reason: "session is running" }
  if (input.held.includes(HOME.providerID) || input.cooling.some((key) => key === `${HOME.providerID}/*` || key === `${HOME.providerID}/${HOME.id}`)) return { move: false, reason: "Claude is held" }
  if (!input.available.some((item) => item.providerID === HOME.providerID && item.id === HOME.id)) return { move: false, reason: "home model unavailable" }
  if (repicked(input.messages, returnedAt(input.metadata))) return { move: false, reason: "picked again after a return" }
  const tokens = contextTokens(input.messages)
  return { move: true, compact: tokens > (input.compactAbove ?? COMPACT_ABOVE), tokens }
}
