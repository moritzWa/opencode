import { describe, expect } from "bun:test"
import { AIError, ProviderInternalError, TransportError, UnknownProviderError } from "@opencode/ai"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/core/provider"
import { SessionSchema } from "@opencode/core/session/schema"
import { SessionRunnerRetry } from "@opencode/core/session/runner/retry"
import { toSessionError } from "@opencode/core/session/to-session-error"
import { Effect } from "effect"
import { it } from "./lib/effect"

const timeout = new AIError({
  reason: new TransportError({ message: "Timed out", transport: "http", operation: "request", code: "Timeout" }),
})
const internal = new AIError({ reason: new ProviderInternalError({ message: "internal" }) })
const disconnected = new AIError({
  reason: new TransportError({
    message: "Unable to connect",
    transport: "http",
    operation: "request",
    code: "ConnectionRefused",
  }),
})

const input = (cause: AIError) => ({
  cause,
  error: toSessionError(cause),
  agent: Agent.ID.make("build"),
  model: Model.Ref.make({ id: Model.ID.make("model"), providerID: Provider.ID.make("provider") }),
  hook: () => Effect.void,
  retry: SessionRunnerRetry.isRetryable(cause),
})

// Decisions for `count` consecutive failures of the same cause within one step.
const decisions = (cause: AIError, count: number) =>
  Effect.gen(function* () {
    const policy = yield* SessionRunnerRetry.policy(SessionSchema.ID.make("ses_retry"))
    const results: boolean[] = []
    for (let i = 0; i < count; i++) results.push((yield* policy(input(cause))).retry)
    return results
  })

describe("SessionRunnerRetry.policy", () => {
  it.effect("stops retrying transport timeouts after three attempts", () =>
    Effect.gen(function* () {
      expect(yield* decisions(timeout, 4)).toEqual([true, true, true, false])
    }),
  )

  it.effect("keeps the general allowance for other transient failures", () =>
    Effect.gen(function* () {
      expect(yield* decisions(internal, 11)).toEqual([...Array(10).fill(true), false])
    }),
  )

  it.effect("waits out long network outages without extending provider failure retries", () =>
    Effect.gen(function* () {
      expect(yield* decisions(disconnected, 721)).toEqual([...Array(720).fill(true), false])
    }),
  )

  it.effect("recognizes native network codes beneath provider wrappers", () =>
    Effect.gen(function* () {
      const wrapped = new AIError({
        reason: new UnknownProviderError({
          message: "provider request failed",
          cause: { cause: { cause: { code: "ECONNRESET" } } },
        }),
      })
      expect(yield* decisions(wrapped, 12)).toEqual(Array(12).fill(true))
    }),
  )

  it.effect("waits out network outages a local proxy reports with the upstream's code", () =>
    Effect.gen(function* () {
      const proxied = new AIError({
        reason: new ProviderInternalError({
          message: "Claude subscription upstream_network: ENOTFOUND",
          body: JSON.stringify({ type: "error", error: { type: "subscription.upstream_network", code: "ENOTFOUND" } }),
        }),
      })
      expect(yield* decisions(proxied, 12)).toEqual(Array(12).fill(true))
    }),
  )
})
