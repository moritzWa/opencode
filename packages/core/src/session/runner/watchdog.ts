export * as SessionWatchdog from "./watchdog.js"

import { AIError, TimeoutError } from "@opencode/ai"
import { Clock, Effect } from "effect"

export interface Activity {
  at: number
  tools: number
}

/** Bound semantic provider silence even when a custom transport keeps its HTTP connection alive. */
export const watch = (activity: Activity, limit = timeout()) =>
  Effect.gen(function* () {
    if (limit <= 0) return yield* Effect.never
    while (true) {
      yield* Effect.sleep(Math.max(1, Math.min(limit / 4, 60_000)))
      const now = yield* Clock.currentTimeMillis
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
