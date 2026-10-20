import { expect } from "bun:test"
import { isRetryable } from "@opencode/ai"
import { Clock, Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { SessionWatchdog } from "../src/session/runner/watchdog"
import { it } from "./lib/effect"

it.effect("stops a silent semantic stream without retrying indefinitely", () =>
  Effect.gen(function* () {
    const activity = { at: yield* Clock.currentTimeMillis, tools: 0 }
    const fiber = yield* SessionWatchdog.watch(activity, 100).pipe(
      Effect.result,
      Effect.forkChild({ startImmediately: true }),
    )
    yield* TestClock.adjust(100)
    const result = yield* Fiber.join(fiber)
    expect(result).toMatchObject({ _tag: "Failure", failure: { reason: { _tag: "Timeout", timeoutMs: 100 } } })
  }),
)

it.effect("excludes real tool execution and grants a fresh provider allowance afterwards", () =>
  Effect.gen(function* () {
    const activity = { at: yield* Clock.currentTimeMillis, tools: 1 }
    const fiber = yield* SessionWatchdog.watch(activity, 100).pipe(
      Effect.result,
      Effect.forkChild({ startImmediately: true }),
    )
    yield* TestClock.adjust(1_000)
    expect(fiber.pollUnsafe()).toBeUndefined()
    activity.tools = 0
    activity.at = yield* Clock.currentTimeMillis
    yield* TestClock.adjust(75)
    expect(fiber.pollUnsafe()).toBeUndefined()
    yield* TestClock.adjust(25)
    expect(yield* Fiber.join(fiber)).toMatchObject({ _tag: "Failure" })
  }),
)

// Timers pause while the computer sleeps; the wall clock jumps ahead by the time asleep.
const sleepingClock = Effect.gen(function* () {
  const clock = yield* Clock.Clock
  const state = { asleep: 0 }
  const wall: Clock.Clock = {
    ...clock,
    currentTimeMillisUnsafe: () => clock.currentTimeMillisUnsafe() + state.asleep,
    currentTimeMillis: Effect.sync(() => clock.currentTimeMillisUnsafe() + state.asleep),
  }
  return { state, wall }
})

it.effect("reconnects instead of timing out when the computer slept during a response", () =>
  Effect.gen(function* () {
    const clock = yield* sleepingClock
    const activity = { at: clock.wall.currentTimeMillisUnsafe(), tools: 0 }
    const fiber = yield* SessionWatchdog.watch(activity, 30 * 60_000).pipe(
      Effect.provideService(Clock.Clock, clock.wall),
      Effect.result,
      Effect.forkChild({ startImmediately: true }),
    )
    yield* TestClock.adjust("30 seconds")
    clock.state.asleep = 2 * 60 * 60_000
    yield* TestClock.adjust("30 seconds")
    const result = yield* Fiber.join(fiber)
    expect(result).toMatchObject({ _tag: "Failure", failure: { reason: { _tag: "Transport", operation: "read" } } })
    if (result._tag === "Failure") expect(isRetryable(result.failure)).toBe(true)
  }),
)

it.effect("ignores short timer delays and sleep while a tool runs", () =>
  Effect.gen(function* () {
    const clock = yield* sleepingClock
    const activity = { at: clock.wall.currentTimeMillisUnsafe(), tools: 1 }
    const fiber = yield* SessionWatchdog.watch(activity, 30 * 60_000).pipe(
      Effect.provideService(Clock.Clock, clock.wall),
      Effect.result,
      Effect.forkChild({ startImmediately: true }),
    )
    clock.state.asleep = 2 * 60 * 60_000
    yield* TestClock.adjust("1 minute")
    expect(fiber.pollUnsafe()).toBeUndefined()
    activity.tools = 0
    clock.state.asleep += SessionWatchdog.SUSPENDED_MS - 1
    yield* TestClock.adjust("1 minute")
    expect(fiber.pollUnsafe()).toBeUndefined()
    yield* Fiber.interrupt(fiber)
  }),
)

it.effect("permits disabling the semantic watchdog", () =>
  Effect.gen(function* () {
    const fiber = yield* SessionWatchdog.watch({ at: 0, tools: 0 }, 0).pipe(
      Effect.forkChild({ startImmediately: true }),
    )
    yield* TestClock.adjust("1 day")
    expect(fiber.pollUnsafe()).toBeUndefined()
    yield* Fiber.interrupt(fiber)
  }),
)
