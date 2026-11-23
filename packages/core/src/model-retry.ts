export * as ModelRetry from "./model-retry.js"

import { AIError, isRetryable } from "@opencode/ai/effect"
import { Clock, Duration, Effect, Option, Pull, Schedule, Schema } from "effect"

interface Input {
  readonly cause: AIError
  readonly retry: boolean
}

/** Bound provider-requested delays so a hostile or buggy retry-after cannot stall a call for hours. */
const RETRY_AFTER_MAX = Duration.toMillis("15 minutes")

const retryAfter = (input: Input) => {
  if (input.cause.reason._tag === "RateLimit" || input.cause.reason._tag === "ProviderInternal")
    return input.cause.reason.retryAfterMs === undefined
      ? undefined
      : Math.min(input.cause.reason.retryAfterMs, RETRY_AFTER_MAX)
  return undefined
}

// Network outages keep the visible retry state for about six hours. Provider failures retain
// the short allowance, and stalled requests retain the separate timeout budget below.
const schedule = (network: boolean) =>
  Schedule.max([
    Schedule.min([Schedule.exponential("2 seconds"), Schedule.spaced(network ? "30 seconds" : "10 seconds")]),
    Schedule.recurs(network ? 720 : 10),
  ]).pipe(
    Schedule.jittered,
    Schedule.setInputType<Input>(),
    Schedule.modifyDelay(({ input, duration: delay }) => {
      const minimum = retryAfter(input)
      const duration = minimum === undefined ? delay : Duration.max(delay, Duration.millis(minimum))
      return Effect.succeed(Duration.millis(Math.ceil(Duration.toMillis(duration))))
    }),
  )

// This machine has no network path to the provider: the host name didn't resolve, or there is no route or interface.
// While that lasts every attempt fails before reaching the provider, and the outage behind it (a router restart, a
// dropped VPN, a laptop between networks) usually outlasts the general allowance, so these retry on their own budget:
// exponential from 2s capped at 30s per gap, for up to an hour after the first one. A refused connection is left out:
// something answered, so it is the server's state.
const UNREACHABLE_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "ENETDOWN"])
export const UNREACHABLE_WINDOW = Duration.hours(1)
const UNREACHABLE_GAP_MAX = 30_000

/** Whether the failure says this machine has no network path to the provider's host. */
export const isUnreachable = (error: AIError) =>
  error.reason._tag === "Transport" && error.reason.code !== undefined && UNREACHABLE_CODES.has(error.reason.code)

const unreachableSchedule = Schedule.max([
  Schedule.min([Schedule.exponential("2 seconds"), Schedule.spaced(Duration.millis(UNREACHABLE_GAP_MAX))]),
  Schedule.during(UNREACHABLE_WINDOW),
]).pipe(
  Schedule.jittered,
  Schedule.setInputType<Input>(),
  // Jitter scales the capped gap by up to 1.2, so cap it again after.
  Schedule.modifyDelay(({ duration }) =>
    Effect.succeed(Duration.millis(Math.min(Math.ceil(Duration.toMillis(duration)), UNREACHABLE_GAP_MAX))),
  ),
)

// A timed-out attempt already waited minutes before failing, so the general allowance would let a
// dead provider hold a call for most of an hour. Cap those attempts well below it.
const MAX_TIMEOUT_RETRIES = 3

const decodeNetworkCause = Schema.decodeUnknownOption(
  Schema.Struct({
    code: Schema.optionalKey(Schema.String),
    cause: Schema.optionalKey(Schema.Unknown),
  }),
)
// A local proxy cannot drop its client connection to mirror an unreachable upstream, so it
// answers with an error body that carries the upstream's native network code instead.
const decodeProxyNetworkFailure = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ error: Schema.Struct({ code: Schema.String }) })),
)
const networkCodes = new Set([
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETRESET",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
  "ERR_HTTP2_GOAWAY_SESSION",
  "ERR_HTTP2_SESSION_ERROR",
  "ERR_HTTP2_STREAM_CANCEL",
  "ERR_HTTP2_STREAM_ERROR",
  "ConnectionClosed",
  "ConnectionRefused",
  "ConnectionResetByPeer",
  "ConnectionTimeout",
  "FailedToOpenSocket",
])

// Provider adapters can retain a native network failure below several wrapper causes.
const isWrappedNetworkFailure = (cause: unknown): boolean => {
  const seen = new Set<unknown>()
  while (cause !== undefined && !seen.has(cause)) {
    seen.add(cause)
    const failure = Option.getOrUndefined(decodeNetworkCause(cause))
    if (!failure) return false
    if (failure.code && networkCodes.has(failure.code)) return true
    cause = failure.cause
  }
  return false
}

export const policy = Effect.gen(function* () {
  const step = yield* Schedule.toStep(schedule(false))
  const network = yield* Schedule.toStep(schedule(true))
  const unreachable = yield* Schedule.toStep(unreachableSchedule)
  let attempt = 1
  let timeouts = 0
  return (input: Input) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      const timeout =
        input.cause.reason._tag === "Transport" &&
        (input.cause.reason.code === "Timeout" || input.cause.reason.code === "idle-timeout")
      const disconnected =
        (input.cause.reason._tag === "Transport" &&
          input.cause.reason.code !== undefined &&
          networkCodes.has(input.cause.reason.code)) ||
        ((input.cause.reason._tag === "Transport" || input.cause.reason._tag === "UnknownProvider") &&
          isWrappedNetworkFailure(input.cause.reason.cause)) ||
        (input.cause.reason._tag === "ProviderInternal" &&
          Option.exists(decodeProxyNetworkFailure(input.cause.reason.body), (body) =>
            networkCodes.has(body.error.code),
          ))
      const advance = input.retry && isUnreachable(input.cause) ? unreachable : disconnected && !timeout ? network : step
      const next = yield* advance(now, input).pipe(Pull.catchDone(() => Effect.succeed(undefined)))
      if (!next) return undefined
      const [, duration] = next
      attempt++
      if (timeout) timeouts++
      return {
        attempt,
        delay: Math.ceil(Duration.toMillis(duration)),
        retry: input.retry && timeouts <= MAX_TIMEOUT_RETRIES,
      }
    })
})

/** Retry a buffered model call from scratch; failed attempts never contribute to its returned output. */
export const retry = <A, R>(effect: Effect.Effect<A, AIError, R>) =>
  Effect.gen(function* () {
    const decide = yield* policy
    while (true) {
      const result = yield* Effect.result(effect)
      if (result._tag === "Success") return result.success
      const decision = yield* decide({ cause: result.failure, retry: isRetryable(result.failure) })
      if (!decision?.retry) return yield* result.failure
      yield* Effect.sleep(Duration.millis(decision.delay))
    }
  })

// One-shot generations (stateless text, images, decisions) can be billed per attempt, so they retry only failures
// the provider never ran, a few times, with the same backoff and retry-after handling.
const ONE_SHOT_RETRIES = 3
// Only codes that fail before a connection exists: a dropped interface or route can also fail a response already being read.
const NOT_SENT_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"])

const notRun = (error: AIError) => {
  const override = error.reason.http?.headers["x-should-retry"]
  if (override === "true") return true
  if (override === "false") return false
  const reason = error.reason
  if (reason._tag === "RateLimit") return true
  if (reason._tag === "ProviderInternal") return reason.http?.status === 503 || reason.http?.status === 529
  if (reason._tag === "Transport")
    return reason.delivery === "not-sent" || (reason.code !== undefined && NOT_SENT_CODES.has(reason.code))
  return false
}

/** Retry a one-shot call only when the provider clearly didn't run it: rate limits, overload, unreachable hosts. */
export const retryOneShot = <A, R>(effect: Effect.Effect<A, AIError, R>) =>
  Effect.gen(function* () {
    const decide = yield* policy
    let retries = 0
    while (true) {
      const result = yield* Effect.result(effect)
      if (result._tag === "Success") return result.success
      const decision = yield* decide({ cause: result.failure, retry: notRun(result.failure) })
      if (!decision?.retry || retries++ >= ONE_SHOT_RETRIES) return yield* result.failure
      yield* Effect.sleep(Duration.millis(decision.delay))
    }
  })
