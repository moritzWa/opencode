import { expect } from "bun:test"
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
