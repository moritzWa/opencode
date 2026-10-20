export * as SessionWatchdog from "./watchdog.js"

import { AIError, TimeoutError, TransportError } from "@opencode/ai"
import { Clock, Effect } from "effect"

export interface Activity {
  at: number
  tools: number
}

/** A tick this much later than scheduled means the computer slept, not that the event loop stalled. */
export const SUSPENDED_MS = 2 * 60_000

/** Bound semantic provider silence even when a custom transport keeps its HTTP connection alive. */
export const watch = (activity: Activity, limit = timeout()) =>
  Effect.gen(function* () {
    if (limit <= 0) return yield* Effect.never
    const interval = Math.max(1, Math.min(limit / 4, 60_000))
    let tick = yield* Clock.currentTimeMillis
    while (true) {
      yield* Effect.sleep(interval)
      const now = yield* Clock.currentTimeMillis
      // Timers pause while the computer sleeps but the wall clock does not, so a late tick measures
      // time asleep. That is not provider silence, and the response connection rarely survives it:
      // reconnect through the retry policy, which waits out a network that is still down.
      const asleep = now - tick - interval
      tick = now
      if (asleep >= SUSPENDED_MS && activity.tools === 0)
        return yield* new AIError({
          reason: new TransportError({
            message: `The computer slept for ${Math.round(asleep / 60_000)} minutes during the provider response; reconnecting.`,
            transport: "http",
            operation: "read",
            phase: "receive",
          }),
        })
      // Commands, subagents and user interaction can legitimately take hours. Tool settlement
      // also refreshes `at`, so the provider receives the full allowance after a long tool.
      if (activity.tools > 0) activity.at = now
      if (now - activity.at < limit) continue
      return yield* new AIError({
        reason: new TimeoutError({
          message: `No response from the provider for ${limit}ms. The step was stopped; send a message to retry.`,
          timeoutMs: limit,
        }),
      })
    }
  })

const timeout = () => {
  const raw = process.env.OPENCODE_STREAM_IDLE_TIMEOUT_MS
  const value = raw ? Number(raw) : Number.NaN
  return Number.isFinite(value) ? value : 30 * 60_000
}
